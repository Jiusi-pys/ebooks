//! ShufangStudyBackup v1, with an untrusted ZIP transport and immutable preview.
use crate::{attachments, sync_blobs::BlobStore, workspace::{string, Result, Workspace}};
use serde::{Deserialize,Serialize};
use serde_json::{json,Value};
use sha2::{Digest,Sha256};
use std::{collections::{BTreeMap,BTreeSet},fs::File,io::{Read,Write},path::{Path,PathBuf}};
use shufang_application::{BlobManifest,Repository};

const LIMIT:u64=512*1024*1024;
const KINDS:&[&str]=&["books","sources","folders","notes","highlights","translations","mindMaps","studySets","associations","reviews"];
#[derive(Clone,Serialize,Deserialize)]
struct StudyRecord {id:String,kind:String,fields:Value}
impl StudyRecord {fn key(&self)->String{format!("{}:{}",self.kind,self.id)}}
#[derive(Serialize,Deserialize)]
struct Plan {version:u32,clock:String,records:Vec<StudyRecord>,attachments:Vec<BlobManifest>,archive_hash:String}
fn hash(bytes:&[u8])->String{format!("{:x}",Sha256::digest(bytes))}
fn io(e:impl std::fmt::Display)->String{e.to_string()}
fn read(path:&Path,max:u64)->Result<Vec<u8>>{let file=File::open(path).map_err(io)?;if file.metadata().map_err(io)?.len()>max{return Err("study_too_large".into());}let mut bytes=vec![];file.take(max+1).read_to_end(&mut bytes).map_err(io)?;if bytes.len() as u64>max{return Err("study_too_large".into());}Ok(bytes)}
fn valid_path(path:&str)->bool {
    let p:Vec<_>=path.split('/').collect();
    match p.as_slice(){["study.json"]=>true,["attachments",h]=>BlobManifest::valid_hash(h),["books",h,"package.json"|"source.pdf"]=>BlobManifest::valid_hash(h),_=>false}
}
fn refs(records:&[StudyRecord])->Result<Vec<BlobManifest>> {
    let mut refs=BTreeMap::<String,BlobManifest>::new();
    for r in records {let mut found=attachments::references(&r.fields)?;if r.kind=="sources"{let m:BlobManifest=serde_json::from_value(r.fields.clone()).map_err(|_|"invalid_source")?;m.validate()?;found.push(m);}
        for m in found{if refs.get(&m.sha256).is_some_and(|prior|prior.size!=m.size){return Err("attachment_size_conflict".into());}refs.insert(m.sha256.clone(),m);}}
    Ok(refs.into_values().collect())
}
fn record_list(ws:&Workspace)->Result<Vec<StudyRecord>> {
    let core=ws.core.lock().map_err(|_|"core_lock_failed")?;let mut result=vec![];
    for kind in KINDS {for row in core.entities(kind)? {let mut value=core.entity(kind,string(&row.value,"id")?)?.value;let id=string(&value,"id")?.to_owned();value.as_object_mut().ok_or("invalid_record")?.remove("id");result.push(StudyRecord{id,kind:(*kind).into(),fields:value});}}
    if result.len()>10000{return Err("study_too_large".into());}Ok(result)
}
fn wiki_links(text:&str)->Vec<(&str,&str)> {
    text.split("[[").skip(1).filter_map(|part|{let body=part.split_once("]]")?.0;if body.contains(['[',']','\n']){return None;}let (target,label)=body.split_once('|').unwrap_or((body,body));Some((target.trim(),label))}).collect()
}
fn encode_id(id:&str)->String{id.bytes().map(|b|if b.is_ascii_alphanumeric()||b"_.~".contains(&b){(b as char).to_string()}else{format!("%{b:02X}")}).collect()}
fn note_content(content:&str,ids:&BTreeMap<String,String>,notes:&[StudyRecord])->String {
    let mut output=String::new();let mut rest=content;
    while let Some(start)=rest.find("[[") {output.push_str(&rest[..start]);let tail=&rest[start+2..];let Some(end)=tail.find("]]")else{output.push_str(&rest[start..]);rest="";break;};let body=&tail[..end];
        let (target,label)=body.split_once('|').unwrap_or((body,body));let target=target.trim();
        let exact:Vec<_>=notes.iter().filter(|n|n.id.to_lowercase()==target.to_lowercase()).collect();let candidates=if exact.is_empty(){notes.iter().filter(|n|n.fields["title"].as_str().is_some_and(|s|s.to_lowercase()==target.to_lowercase())).collect::<Vec<_>>()}else{exact};
        if !body.contains(['[',']','\n'])&&candidates.len()==1&&ids.contains_key(&candidates[0].key()){output.push_str(&format!("[[{}|{}]]",ids[&candidates[0].key()],if body.contains('|'){label}else{target}));}else{output.push_str(&rest[start..start+2+end+2]);}
        rest=&tail[end+2..];
    }
    output.push_str(rest);
    for (key,id)in ids {if let Some(old)=key.strip_prefix("highlights:"){output=output.replace(&format!("<!-- shufang-citation-id:{} -->",encode_id(old)),&format!("<!-- shufang-citation-id:{} -->",encode_id(id)));}}
    output
}
fn card_refs(value:&Value,out:&mut BTreeSet<String>){match value{Value::Object(map)=>{if let Some(id)=map.get("sourceHighlightId").and_then(Value::as_str){out.insert(id.into());}for v in map.values(){card_refs(v,out);}},Value::Array(a)=>for v in a{card_refs(v,out);},_=>{}}}
fn select(records:Vec<StudyRecord>,set:Option<&str>)->Result<Vec<StudyRecord>> {
    let Some(set)=set else{return Ok(records)};
    let requested:BTreeSet<String>=records.iter().find(|r|r.kind=="studySets"&&r.id==set).ok_or("study_set_not_found")?.fields["bookIds"].as_array().ok_or("invalid_book_ids")?.iter().map(|v|v.as_str().map(str::to_owned).ok_or_else(||"invalid_book_id".to_owned())).collect::<Result<_>>()?;
    let mut books=requested.clone();let mut cards=BTreeSet::<String>::new();let mut notes=BTreeSet::<String>::new();let mut folders=BTreeSet::<String>::new();let mut selected=BTreeSet::<String>::new();
    let citation_cards:BTreeMap<_,_>=records.iter().filter(|r|r.kind=="highlights").map(|r|(encode_id(&r.id),r.id.clone())).collect();
    loop {let old=(books.len(),cards.len(),notes.len(),folders.len(),selected.len());
        for r in &records {let f=&r.fields;let member=|key:&str|f[key].as_str().is_some_and(|id|books.contains(id));let mut node_cards=BTreeSet::new();card_refs(f,&mut node_cards);
            let include=selected.contains(&r.key())||match r.kind.as_str(){
                "books"|"sources"=>books.contains(&r.id),"folders"=>folders.contains(&r.id),"highlights"=>cards.contains(&r.id)||member("bookId"),"notes"=>notes.contains(&r.id)||member("bookId"),"translations"=>member("bookId"),"reviews"=>f["highlightId"].as_str().is_some_and(|id|cards.contains(id)),"mindMaps"=>member("bookId")||!node_cards.is_disjoint(&cards),"associations"=>["source","target"].iter().any(|key|f[*key]["bookId"].as_str().is_some_and(|id|books.contains(id))),"studySets"=>f["bookIds"].as_array().is_some_and(|a|( !a.is_empty()||requested.is_empty())&&a.iter().all(|v|v.as_str().is_some_and(|id|requested.contains(id)))),_=>false};
            if !include{continue;}selected.insert(r.key());
            match r.kind.as_str(){"books"=>{if let Some(id)=f["folderId"].as_str().or(f["folder"].as_str()).filter(|s|!s.is_empty()){folders.insert(id.into());}},"folders"=>{if let Some(id)=f["parentId"].as_str(){folders.insert(id.into());}},"highlights"=>{cards.insert(r.id.clone());if let Some(id)=f["bookId"].as_str(){books.insert(id.into());}
if let Some(id)=f["noteId"].as_str(){notes.insert(id.into());}},"mindMaps"=>cards.extend(node_cards),"associations"=>{for key in ["source","target"]{if let Some(id)=f[key]["bookId"].as_str(){books.insert(id.into());}}},"notes"=>{for (link,_)in wiki_links(f["content"].as_str().unwrap_or("")){for note in records.iter().filter(|n|n.kind=="notes"){if note.id.eq_ignore_ascii_case(link)||note.fields["title"].as_str().is_some_and(|s|s.to_lowercase()==link.to_lowercase()){notes.insert(note.id.clone());}}}},_=>{}}
        }
        for note in records.iter().filter(|r|r.kind=="notes"&&selected.contains(&r.key())) {for token in note.fields["content"].as_str().unwrap_or("").split("<!-- shufang-citation-id:").skip(1) {if let Some((encoded,_))=token.split_once(" -->"){if let Some(id)=citation_cards.get(encoded){cards.insert(id.clone());}}}}
        if old==(books.len(),cards.len(),notes.len(),folders.len(),selected.len()){break;}
    }
    Ok(records.into_iter().filter(|r|selected.contains(&r.key())).collect())
}
pub fn export(ws:&Workspace,args:&Value)->Result<Value> {
    let destination=PathBuf::from(string(args,"path")?);if !destination.is_absolute()||destination.exists(){return Err("backup_destination_must_be_new".into());}
    let records=select(record_list(ws)?,args["studySetId"].as_str())?;
    let staging=tempfile::tempdir_in(&ws.root).map_err(io)?;let mut files=BTreeMap::new();
    let study=staging.path().join("study.json");std::fs::write(&study,serde_json::to_vec(&records).map_err(io)?).map_err(io)?;files.insert("study.json".to_owned(),study);
    let store=BlobStore::new(&ws.root.join("sync-blobs"));
    for m in refs(&records)?{let path=store.path(&m.sha256)?;if hash(&read(&path,m.size)?)!=m.sha256{return Err("attachment_hash_mismatch".into());}files.insert(format!("attachments/{}",m.sha256),path);}
    for r in records.iter().filter(|r|r.kind=="books") {
        let f=&r.fields;let contents=f["chapters"].as_array().ok_or("invalid_chapters")?;let has_pdf=f["format"]=="pdf";
        let chapters:Vec<Value>=contents.iter().enumerate().map(|(index,c)|json!({"id":c["id"],"index":index,"title":c["title"],"paragraphs":c["paragraphs"].as_array().map_or(0,Vec::len),"chars":c["paragraphs"].as_array().map_or(0,|a|a.iter().filter_map(Value::as_str).map(|s|s.encode_utf16().count()).sum::<usize>())})).collect();
        let content:Vec<Value>=contents.iter().enumerate().map(|(index,c)|{let mut c=c.clone();c["index"]=index.into();c}).collect();
        let mut book=f.clone();book["extId"]=r.id.clone().into();book["folder"]=f["folderId"].as_str().unwrap_or("").into();book["chapterCount"]=contents.len().into();
        let package=json!({"book":book,"chapters":chapters,"contents":content,"downloadedAt":0,"hasPDF":has_pdf});let path=staging.path().join(format!("{}.json",hash(r.id.as_bytes())));std::fs::write(&path,package.to_string()).map_err(io)?;
        let prefix=format!("books/{}/",hash(r.id.as_bytes()));files.insert(format!("{prefix}package.json"),path);
        if has_pdf{files.insert(format!("{prefix}source.pdf"),ws.book_file(&r.id)?);}
    }
    let mut output=tempfile::NamedTempFile::new_in(destination.parent().ok_or("invalid_destination")?).map_err(io)?;
    let mut zip=zip::ZipWriter::new(output.as_file_mut());let options=zip::write::SimpleFileOptions::default().compression_method(zip::CompressionMethod::Stored);let mut entries=vec![];let mut total=0u64;
    for (name,path) in files {let bytes=read(&path,LIMIT)?;total=total.checked_add(bytes.len() as u64).ok_or("study_too_large")?;if total>LIMIT{return Err("study_too_large".into());}entries.push(json!({"path":name,"bytes":bytes.len(),"sha256":hash(&bytes)}));zip.start_file(name,options).map_err(io)?;zip.write_all(&bytes).map_err(io)?;}
    let created=std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_err(io)?.as_secs_f64()-978307200.0;
    let manifest=json!({"format":"ShufangStudyBackup","version":1,"createdAt":created,"origin":string(args,"origin")?,"userID":string(args,"userID")?,"title":args["title"].as_str().unwrap_or("学习资料"),"entries":entries});
    zip.start_file("manifest.json",options).map_err(io)?;zip.write_all(manifest.to_string().as_bytes()).map_err(io)?;zip.finish().map_err(io)?;output.as_file().sync_all().map_err(io)?;output.persist_noclobber(&destination).map_err(io)?;
    Ok(json!({"path":destination,"records":records.len(),"bytes":total}))
}
fn extract(archive:&Path,target:&Path)->Result<(Value,Vec<StudyRecord>,Vec<BlobManifest>)> {
    let mut zip=zip::ZipArchive::new(File::open(archive).map_err(io)?).map_err(io)?;if zip.len()>10001{return Err("study_too_large".into());}
    let mut names=BTreeSet::new();let mut total=0u64;
    for index in 0..zip.len(){let mut entry=zip.by_index(index).map_err(io)?;let name=entry.name().to_owned();
        if !names.insert(name.clone())||entry.enclosed_name().is_none()||entry.is_dir()||entry.unix_mode().is_some_and(|m|m&0o170000==0o120000)||(!valid_path(&name)&&name!="manifest.json"){return Err("invalid_backup_path".into());}
        total=total.checked_add(entry.size()).ok_or("study_too_large")?;if total>LIMIT||name=="manifest.json"&&entry.size()>2*1024*1024{return Err("study_too_large".into());}
        let path=target.join(&name);std::fs::create_dir_all(path.parent().ok_or("invalid_backup_path")?).map_err(io)?;let mut out=File::create(path).map_err(io)?;let size=entry.size();let copied=std::io::copy(&mut entry.by_ref().take(size+1),&mut out).map_err(io)?;if copied!=size{return Err("invalid_backup_size".into());}
    }
    let manifest:Value=serde_json::from_slice(&read(&target.join("manifest.json"),2*1024*1024)?).map_err(io)?;
    if manifest["format"]!="ShufangStudyBackup"||manifest["version"]!=1{return Err("unsupported_study_backup".into());}
    let mut verified=BTreeSet::new();for item in manifest["entries"].as_array().ok_or("invalid_manifest")? {let path=string(item,"path")?;
        if !valid_path(path)||!names.contains(path)||!verified.insert(path.to_owned()){return Err("invalid_manifest".into());}let bytes=read(&target.join(path),LIMIT)?;if item["bytes"].as_u64()!=Some(bytes.len() as u64)||item["sha256"]!=hash(&bytes)||path.starts_with("attachments/")&&path!=format!("attachments/{}",hash(&bytes)){return Err("backup_checksum_mismatch".into());}}
    if verified.len()+1!=names.len()||!verified.contains("study.json"){return Err("incomplete_manifest".into());}
    let mut records:Vec<StudyRecord>=serde_json::from_slice(&read(&target.join("study.json"),LIMIT)?).map_err(io)?;
    let mut keys=BTreeSet::new();if records.len()>10000{return Err("study_too_large".into());}
    for r in &records{if !KINDS.contains(&r.kind.as_str())||!shufang_domain::sync::valid_identifier(&r.id)||!r.fields.is_object()||!keys.insert(r.key()){return Err("invalid_record".into());}}
    let mut packages=BTreeSet::new();for path in verified.iter().filter(|p|p.ends_with("/package.json")) {
        let package:Value=serde_json::from_slice(&read(&target.join(path),LIMIT)?).map_err(io)?;let id=string(&package["book"],"extId")?;
        if path!=&format!("books/{}/package.json",hash(id.as_bytes()))||!packages.insert(id.to_owned()){return Err("invalid_book_package".into());}
        let chapters=package["chapters"].as_array().ok_or("invalid_chapters")?;let contents=package["contents"].as_array().ok_or("invalid_chapters")?;let has_pdf=package["hasPDF"].as_bool().ok_or("invalid_book_package")?;
        if chapters.len()!=contents.len()||chapters.iter().zip(contents).any(|(a,b)|a["id"]!=b["id"])||contents.is_empty()&&!has_pdf{return Err("invalid_book_package".into());}
        let r=records.iter_mut().find(|r|r.kind=="books"&&r.id==id).ok_or("book_package_without_record")?;r.fields["chapters"]=package["contents"].clone();
        if r.fields["folderId"].is_null(){if let Some(folder)=r.fields["folder"].as_str().filter(|s|!s.is_empty()).map(str::to_owned){r.fields["folderId"]=folder.into();}}
        if has_pdf{let pdf=read(&target.join(format!("books/{}/source.pdf",hash(id.as_bytes()))),256*1024*1024)?;if !pdf.starts_with(b"%PDF"){return Err("invalid_pdf".into());}}
    }
    // $blob is JSON; $attachment is always opaque.
    for r in &mut records {for field in r.fields.as_object_mut().ok_or("invalid_record")?.values_mut(){if let Some(reference)=field.get("$blob"){let m:BlobManifest=serde_json::from_value(reference.clone()).map_err(|_|"invalid_blob_manifest")?;m.validate()?;let bytes=read(&target.join(format!("attachments/{}",m.sha256)),m.size)?;if bytes.len() as u64!=m.size||hash(&bytes)!=m.sha256{return Err("attachment_hash_mismatch".into());}*field=serde_json::from_slice(&bytes).map_err(|_|"invalid_json_blob")?;}}}
    let refs=refs(&records)?;for m in &refs {let bytes=read(&target.join(format!("attachments/{}",m.sha256)),m.size)?;if bytes.len() as u64!=m.size||hash(&bytes)!=m.sha256{return Err("attachment_hash_mismatch".into());}}
    Ok((manifest,records,refs))
}
fn mapped(ids:&BTreeMap<String,String>,kind:&str,id:&str)->String{ids.get(&format!("{kind}:{id}")).cloned().unwrap_or(id.into())}
fn reference(value:&mut Value,key:&str,kind:&str,ids:&BTreeMap<String,String>){if let Some(id)=value[key].as_str(){value[key]=mapped(ids,kind,id).into();}}
fn nodes(value:&mut Value,ids:&BTreeMap<String,String>){reference(value,"sourceHighlightId","highlights",ids);if let Some(children)=value["children"].as_array_mut(){for child in children{nodes(child,ids);}}}
fn remap(r:&mut StudyRecord,ids:&BTreeMap<String,String>,notes:&[StudyRecord]) {
    let f=&mut r.fields;
    match r.kind.as_str(){
        "books"=>{for key in ["extId","folderId","folder"]{reference(f,key,if key=="extId"{"books"}else{"folders"},ids);}},"folders"=>reference(f,"parentId","folders",ids),
        "highlights"=>{reference(f,"bookId","books",ids);reference(f,"noteId","notes",ids);if let Some(ranges)=f["sourceRanges"].as_array_mut(){for range in ranges{reference(range,"bookId","books",ids);}}},
        "notes"=>{reference(f,"bookId","books",ids);if let Some(content)=f["content"].as_str(){f["content"]=note_content(content,ids,notes).into();}},
        "studySets"=>{if let Some(books)=f["bookIds"].as_array_mut(){for book in books{if let Some(id)=book.as_str(){*book=mapped(ids,"books",id).into();}}}},
        "mindMaps"=>{reference(f,"bookId","books",ids);nodes(&mut f["root"],ids);},"associations"=>{for key in ["source","target"]{reference(&mut f[key],"bookId","books",ids);}if let Ok(pair)=shufang_domain::associations::pair_key(&f["source"],&f["target"],f["direction"].as_str().unwrap_or("bidirectional")){f["pairKey"]=pair.into();f["pairKeyVersion"]=2.into();}},
        "reviews"=>reference(f,"highlightId","highlights",ids),"translations"=>reference(f,"bookId","books",ids),_=>{}
    }
    r.id=mapped(ids,&r.kind,&r.id);
}
pub fn preview(ws:&Workspace,args:&Value)->Result<Value> {
    let policy=string(args,"policy")?;if !["keepLocal","keepBoth","replace"].contains(&policy){return Err("invalid_restore_policy".into());}
    let archive=PathBuf::from(string(args,"path")?);if !archive.is_absolute(){return Err("absolute_archive_path_required".into());}
    let directory=ws.root.join("study-restores");std::fs::create_dir_all(&directory).map_err(io)?;let staged=tempfile::tempdir_in(&directory).map_err(io)?;
    let (manifest,records,attachments)=extract(&archive,staged.path())?;
    let same_origin=|left:&str,right:&str|{if left==right{return true;}match (reqwest::Url::parse(left),reqwest::Url::parse(right)){(Ok(a),Ok(b))=>a.scheme()==b.scheme()&&a.host_str()==b.host_str()&&a.port_or_known_default()==b.port_or_known_default()&&["","/"].contains(&a.path())&&["","/"].contains(&b.path())&&a.query().is_none()&&b.query().is_none()&&a.fragment().is_none()&&b.fragment().is_none(),_=>false}};
    if !same_origin(string(&manifest,"origin")?,string(args,"origin")?)||manifest["userID"]!=args["userID"]{return Err("backup_wrong_account".into());}
    let core=ws.core.lock().map_err(|_|"core_lock_failed")?;let clock=core.study_clock()?;
    let mut existing=BTreeMap::new();for r in &records{if let Some(row)=core.repository().load(&r.kind,&r.id)?{existing.insert(r.key(),row.state.deleted);}}
    let mut ids=BTreeMap::new();for r in records.iter().filter(|r|r.kind=="books"||r.kind=="sources"){if existing.get(&format!("books:{}",r.id))==Some(&true)||existing.get(&format!("sources:{}",r.id))==Some(&true){let id=ids.entry(format!("books:{}",r.id)).or_insert_with(||uuid::Uuid::new_v4().to_string()).clone();ids.insert(format!("sources:{}",r.id),id);}}
    for r in records.iter().filter(|r|!["books","sources","reviews"].contains(&r.kind.as_str())) {
        if r.kind=="notes"&&r.id.starts_with("pdfink."){if let Some(book)=r.fields["bookId"].as_str().and_then(|id|ids.get(&format!("books:{id}"))){let page=r.fields["pdfPage"].as_u64().filter(|p|*p>0).ok_or("invalid_ink_page")?;ids.insert(r.key(),format!("pdfink.{}.{page}",hash(book.as_bytes())));}else if existing.get(&r.key())==Some(&true){return Err("restore_deleted_ink_requires_book".into());}continue;}
        if existing.get(&r.key())==Some(&true)||policy=="keepBoth"&&existing.contains_key(&r.key()){ids.insert(r.key(),uuid::Uuid::new_v4().to_string());}
    }
    for r in records.iter().filter(|r|r.kind=="reviews"){if existing.get(&r.key())==Some(&true)||r.fields["highlightId"].as_str().is_some_and(|id|ids.contains_key(&format!("highlights:{id}"))){ids.insert(r.key(),uuid::Uuid::new_v4().to_string());}}
    let notes:Vec<_>=records.iter().filter(|r|r.kind=="notes"&&!r.id.starts_with("pdfink.")).cloned().collect();let mut restored=vec![];
    for mut r in records {if !ids.contains_key(&r.key())&&existing.contains_key(&r.key())&&(policy=="keepLocal"||r.kind=="reviews"||policy=="keepBoth"&&(r.kind=="books"||r.kind=="sources"||r.kind=="notes"&&r.id.starts_with("pdfink."))){continue;}remap(&mut r,&ids,&notes);restored.push(r);}
    let id=uuid::Uuid::new_v4().to_string();let plan=Plan{version:1,clock,records:restored,attachments,archive_hash:hash(&read(&archive,LIMIT)?)};
    core.validate_study_records(&plan.clock,plan.records.iter().map(|r|(r.kind.clone(),r.id.clone(),r.fields.clone())).collect())?;
    std::fs::write(staged.path().join("plan.json"),serde_json::to_vec(&plan).map_err(io)?).map_err(io)?;let mut counts=BTreeMap::<String,usize>::new();for r in &plan.records{*counts.entry(r.kind.clone()).or_default()+=1;}
    std::fs::rename(staged.path(),directory.join(&id)).map_err(io)?;
    Ok(json!({"planId":id,"counts":counts,"mapped":ids.len(),"policy":policy,"title":manifest["title"],"archiveHash":plan.archive_hash}))
}
fn plan_path(ws:&Workspace,args:&Value)->Result<PathBuf>{let id=string(args,"planId")?;if uuid::Uuid::parse_str(id).is_err()||id.contains(['/', '\\']){return Err("invalid_restore_plan".into());}Ok(ws.root.join("study-restores").join(id))}
pub fn cancel(ws:&Workspace,args:&Value)->Result<Value>{let path=plan_path(ws,args)?;if path.exists(){std::fs::remove_dir_all(path).map_err(io)?;}Ok(json!({"cancelled":true}))}
pub fn commit(ws:&Workspace,args:&Value)->Result<Value> {
    let path=plan_path(ws,args)?;let plan:Plan=serde_json::from_slice(&read(&path.join("plan.json"),LIMIT)?).map_err(io)?;if plan.version!=1{return Err("unsupported_restore_plan".into());}
    let mut core=ws.core.lock().map_err(|_|"core_lock_failed")?;let key=format!("study-restore:{}",string(args,"planId")?);
    if core.local_value(&key)?.is_some(){return Ok(json!({"completed":true,"duplicate":true}));}
    if core.study_clock()?!=plan.clock{return Err("restore_preview_changed".into());}
    for m in &plan.attachments{let file=path.join(format!("attachments/{}",m.sha256));crate::attachments::put(ws,&json!({"path":file,"sha256":m.sha256,"name":m.name,"type":m.content_type}))?;}
    let safety=ws.root.join(format!("before-study-restore-{}.zip",uuid::Uuid::new_v4()));
    // Snapshot while holding the business mutex: no edit can race the safety copy.
    crate::backup::create(&ws.database,&safety)?;
    let records=plan.records.into_iter().map(|r|(r.kind,r.id,r.fields)).collect();
    core.with_receipt(&key,&plan.archive_hash,vec![],|core|core.restore_study_records(&plan.clock,records))?;
    Ok(json!({"completed":true,"safetyBackup":safety}))
}
