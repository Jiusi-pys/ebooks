//! Confirmed local-library import creates new operations without rewriting old identities.
use crate::workspace::{string, Result, Workspace};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{collections::BTreeMap, io::{Read, Write}, path::{Path, PathBuf}, sync::Arc};

const ORDER:&[&str]=&["folders","notes","books","highlights","translations","mindMaps","studySets","associations","preferences","reviews"];
fn encoded(id:&str)->String {
    id.bytes().map(|b|if b.is_ascii_alphanumeric()||b"_.~".contains(&b){(b as char).to_string()}else{format!("%{b:02X}")}).collect()
}
fn rewrite(value:&mut Value,mapping:&BTreeMap<String,String>) {
    match value {
        Value::Object(fields)=>for (key,item) in fields {
            let kind=match key.as_str(){"bookId"=>Some("books"),"noteId"=>Some("notes"),"folderId"=>Some("folders"),"sourceHighlightId"|"highlightId"=>Some("highlights"),_=>None};
            if let Some(kind)=kind {if let Some(id)=item.as_str(){if let Some(mapped)=mapping.get(&format!("{kind}:{id}")){*item=mapped.clone().into();}}}
            else if key=="bookIds" {if let Some(ids)=item.as_array_mut(){for id in ids {if let Some(mapped)=id.as_str().and_then(|id|mapping.get(&format!("books:{id}"))){*id=mapped.clone().into();}}}}
            else if key=="content" {if let Some(text)=item.as_str(){let mut text=text.to_owned();for (key,id) in mapping {if let Some(old)=key.strip_prefix("highlights:"){text=text.replace(&format!("<!-- shufang-citation-id:{} -->",encoded(old)),&format!("<!-- shufang-citation-id:{} -->",encoded(id)));}}*item=text.into();}}
            else {rewrite(item,mapping)}
        },
        Value::Array(items)=>for item in items {rewrite(item,mapping)},
        _=>{}
    }
}
fn copy_source(target:&Workspace,path:&Path,manifest:&shufang_application::BlobManifest)->Result<()> {
    let store=crate::sync_blobs::BlobStore::new(&target.root.join("sync-blobs"));
    let upload=store.create(manifest)?;
    if !upload.present {
        let mut file=std::fs::File::open(path).map_err(|e|e.to_string())?;
        let mut buffer=vec![0;shufang_application::CHUNK_SIZE as usize];
        for index in 0..upload.chunks {
            let size=manifest.chunk_length(index)? as usize;
            file.read_exact(&mut buffer[..size]).map_err(|e|e.to_string())?;
            store.put(&upload.id,index,&buffer[..size],&format!("{:x}",Sha256::digest(&buffer[..size])))?;
        }
    }
    if store.commit(&upload.id)?!=*manifest {return Err("merge_source_mismatch".into());}
    Ok(())
}
pub fn merge(source:&Arc<Workspace>,args:&Value)->Result<Value> {
    let destination=PathBuf::from(string(args,"destination")?);
    if !destination.is_absolute()||destination==source.root{return Err("invalid_merge_destination".into());}
    let batch=string(args,"batch")?;
    if !shufang_domain::sync::valid_identifier(batch){return Err("invalid_merge_batch".into());}
    let target=Workspace::open(&destination.join("library.sqlite"),string(args,"workspace")?,string(args,"replica")?)?;
    let batch_hash=format!("{:x}",Sha256::digest(format!("{}:{batch}",source.root.display()).as_bytes()));
    let directory=source.root.join("merge-plans");std::fs::create_dir_all(&directory).map_err(|e|e.to_string())?;
    let plan_path=directory.join(format!("{batch_hash}.json"));
    let plan:Value=if plan_path.exists(){serde_json::from_reader(std::fs::File::open(&plan_path).map_err(|e|e.to_string())?).map_err(|_|"invalid_merge_plan")?}else{
        let core=source.core.lock().map_err(|_|"core_lock_failed")?;
        let mut entities=vec![];
        for kind in ORDER {for record in core.entities(kind)? {
            let id=string(&record.value,"id")?;
            let hydrated=core.entity(kind,id)?;
            let mut entity=json!({"kind":kind,"value":hydrated.value,"revision":hydrated.revision});
            if *kind=="books" {entity["source"]=serde_json::to_value(core.book_source(id)?).map_err(|e|e.to_string())?;}
            entities.push(entity);
        }}
        let value=json!({"mappingVersion":2,"batch":batch_hash,"workspace":args["workspace"],"entities":entities});
        let mut staged=tempfile::NamedTempFile::new_in(&directory).map_err(|e|e.to_string())?;
        serde_json::to_writer(&mut staged,&value).map_err(|e|e.to_string())?;
        staged.flush().map_err(|e|e.to_string())?;staged.as_file().sync_all().map_err(|e|e.to_string())?;
        staged.persist_noclobber(&plan_path).map_err(|e|e.to_string())?;value
    };
    if plan["workspace"]!=args["workspace"] {return Err("merge_workspace_changed".into());}
    let entities=plan["entities"].as_array().ok_or("invalid_merge_plan")?;
    let version=match plan.get("mappingVersion") {None=>1,Some(value)=>value.as_u64().ok_or("invalid_merge_plan")?};
    if !(1..=2).contains(&version){return Err("unsupported_merge_plan_version".into());}
    // Old snapshots never collected review events. Do not silently report a
    // complete migration or mutate their pinned identities to fill that gap.
    if version==1 && !source.core.lock().map_err(|_|"core_lock_failed")?.entities("reviews")?.is_empty(){return Err("merge_plan_upgrade_requires_clean_staging".into());}
    let mut mapping=BTreeMap::new();
    for entity in entities {
        let kind=string(entity,"kind")?;let id=string(&entity["value"],"id")?;
        let mapped=if kind=="preferences" {id.to_owned()}else{format!("android-{:x}",Sha256::digest(format!("{batch_hash}:{kind}:{id}").as_bytes()))};
        mapping.insert(format!("{kind}:{id}"),mapped);
    }
    for entity in entities {
        if entity["kind"]!="notes" {continue;}
        let old=string(&entity["value"],"id")?;
        if !old.starts_with("pdfink."){continue;}
        let book=string(&entity["value"],"bookId")?;
        let page=entity["value"]["pdfPage"].as_u64().filter(|p|*p>0).ok_or("invalid_ink_page")?;
        let mapped=mapping.get(&format!("books:{book}")).ok_or("merge_ink_book_missing")?;
        if version==1 && target.core.lock().map_err(|_|"core_lock_failed")?.local_value(&format!("android-merge:{batch_hash}:notes:{old}"))?.is_some(){return Err("merge_plan_upgrade_requires_clean_staging".into());}
        mapping.insert(format!("notes:{old}"),format!("pdfink.{:x}.{page}",Sha256::digest(mapped.as_bytes())));
    }
    for entity in entities {
        let kind=string(entity,"kind")?;let old=string(&entity["value"],"id")?;
        let id=mapping.get(&format!("{kind}:{old}")).ok_or("invalid_merge_mapping")?;
        let receipt=format!("android-merge:{batch_hash}:{kind}:{old}");
        let fingerprint=format!("{:x}",Sha256::digest(entity.to_string().as_bytes()));
        if target.core.lock().map_err(|_|"core_lock_failed")?.local_value(&receipt)?.is_some(){continue;}
        for manifest in crate::attachments::references(&entity["value"])? {
            let store=crate::sync_blobs::BlobStore::new(&source.root.join("sync-blobs"));
            copy_source(&target,&store.path(&manifest.sha256)?,&manifest)?;
        }
        let mut value=entity["value"].clone();rewrite(&mut value,&mapping);
        let fields=value.as_object_mut().ok_or("invalid_merge_record")?;
        fields.remove("id");if kind!="reviews"{fields.remove("createdAt");}fields.remove("updatedAt");fields.remove("sourceFile");
        if kind=="books" {
            let manifest:shufang_application::BlobManifest=serde_json::from_value(entity["source"].clone()).map_err(|_|"invalid_merge_source")?;
            copy_source(&target,&source.book_file(old)?,&manifest)?;
            target.core.lock().map_err(|_|"core_lock_failed")?.with_receipt(&receipt,&fingerprint,vec![],|core|{core.import_book(id,value,&manifest)?;Ok(())})?;
        } else if kind=="reviews" {
            target.core.lock().map_err(|_|"core_lock_failed")?.with_receipt(&receipt,&fingerprint,vec![],|core|{core.import_review_event(id,value)?;Ok(())})?;
        } else {
            target.core.lock().map_err(|_|"core_lock_failed")?.with_receipt(&receipt,&fingerprint,vec![],|core|{let expected=if kind=="preferences" {match core.entity(kind,id){Ok(record)=>record.revision,Err(error)if error=="not_found"=>0,Err(error)=>return Err(error)}}else{0};core.save_entity(kind,id,value,vec![],expected)?;Ok(())})?;
        }
    }
    Ok(json!({"completed":true,"entities":entities.len(),"batch":batch_hash}))
}
