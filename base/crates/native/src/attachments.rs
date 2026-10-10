//! Binary attachments remain opaque; only $blob fields contain externalized JSON.
use crate::{sync_blobs::BlobStore,workspace::{Result,Workspace}};
use serde_json::{json,Value};
use sha2::{Digest,Sha256};
use shufang_application::{BlobManifest,CHUNK_SIZE,MAX_BLOB_SIZE};
use std::{collections::BTreeMap,fs::File,io::Read,path::PathBuf};

pub fn references(value:&Value)->Result<Vec<BlobManifest>> {
    fn visit(value:&Value,result:&mut BTreeMap<String,BlobManifest>,depth:usize)->Result<()> {
        if depth>64{return Err("attachment_nesting_too_deep".into());}
        match value {
            Value::Object(map)=>{
                for marker in ["$attachment","$blob"] {
                    if let Some(value)=map.get(marker) {
                        let m:BlobManifest=serde_json::from_value(value.clone()).map_err(|_|"invalid_attachment_manifest")?;
                        m.validate()?;
                        if let Some(old)=result.get(&m.sha256) {if old.size!=m.size{return Err("attachment_size_conflict".into());}}
                        result.insert(m.sha256.clone(),m);
                    }
                }
                for value in map.values(){visit(value,result,depth+1)?;}
            }
            Value::Array(values)=>for value in values {visit(value,result,depth+1)?;},
            _=>{}
        }
        Ok(())
    }
    let mut result=BTreeMap::new();visit(value,&mut result,0)?;Ok(result.into_values().collect())
}

pub fn put(workspace:&Workspace,args:&Value)->Result<Value> {
    let path=PathBuf::from(args["path"].as_str().ok_or("attachment_path_required")?);
    let path=path.canonicalize().map_err(|e|e.to_string())?;
    let root=workspace.root.canonicalize().map_err(|e|e.to_string())?;
    if !path.starts_with(root){return Err("attachment_outside_workspace".into());}
    let size=path.metadata().map_err(|e|e.to_string())?.len();
    if size>MAX_BLOB_SIZE{return Err("attachment_too_large".into());}
    let mut input=File::open(&path).map_err(|e|e.to_string())?;
    let mut digest=Sha256::new();let mut buffer=vec![0;CHUNK_SIZE as usize];
    loop{let count=input.read(&mut buffer).map_err(|e|e.to_string())?;if count==0{break;}digest.update(&buffer[..count]);}
    let hash=format!("{:x}",digest.finalize());
    if args["sha256"].as_str().is_some_and(|expected|expected!=hash){return Err("attachment_hash_mismatch".into());}
    let manifest=BlobManifest{sha256:hash,size,name:args["name"].as_str().unwrap_or("attachment.bin").into(),content_type:args["type"].as_str().unwrap_or("application/octet-stream").into()};
    manifest.validate()?;
    let store=BlobStore::new(&workspace.root.join("sync-blobs"));let upload=store.create(&manifest)?;
    if !upload.present {
        let mut input=File::open(path).map_err(|e|e.to_string())?;
        for index in 0..upload.chunks {
            let count=manifest.chunk_length(index)? as usize;
            input.read_exact(&mut buffer[..count]).map_err(|e|e.to_string())?;
            store.put(&upload.id,index,&buffer[..count],&format!("{:x}",Sha256::digest(&buffer[..count])))?;
        }
        if store.commit(&upload.id)?!=manifest{return Err("attachment_manifest_mismatch".into());}
    }
    Ok(json!({"$attachment":manifest}))
}
pub fn resource(workspace:&Workspace,args:&Value)->Result<Value> {
    let reference=&args["reference"];let values=references(reference)?;
    if values.len()!=1{return Err("single_attachment_required".into());}
    let manifest=&values[0];let store=BlobStore::new(&workspace.root.join("sync-blobs"));
    if !store.has(&manifest.sha256)?{return Err("attachment_pending".into());}
    let path=store.path(&manifest.sha256)?;
    if path.metadata().map_err(|e|e.to_string())?.len()!=manifest.size{return Err("attachment_size_mismatch".into());}
    Ok(json!({"path":path,"type":manifest.content_type,"name":manifest.name}))
}
