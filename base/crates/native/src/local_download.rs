use crate::{sync_blobs::BlobStore,workspace::{string,Result,Workspace}};
use serde_json::{json,Value};
use shufang_application::BlobManifest;
pub fn enabled(ws:&Workspace,id:&str)->Result<bool>{let core=ws.core.lock().map_err(|_|"core_lock_failed")?;Ok(core.local_value(&format!("download:book:{id}"))?.is_none_or(|(_,value)|value!=false))}
pub fn acknowledge(ws:&Workspace,m:&BlobManifest)->Result<()> {
    let mut core=ws.core.lock().map_err(|_|"core_lock_failed")?;let key=format!("file:remote:{}",m.sha256);let revision=core.local_value(&key)?.map_or(0,|(r,_)|r);
    core.set_local_value(&key,revision,&json!({"sha256":m.sha256,"size":m.size}))?;Ok(())
}
/// Shared originals and learning attachments are never freed as another book's cache.
pub fn cleanup(ws:&Workspace,m:&BlobManifest)->Result<u64> {
    let core=ws.core.lock().map_err(|_|"core_lock_failed")?;let mut disabled=false;
    for source in core.entities("sources")? {if source.value["sha256"]==m.sha256 {
        let id=string(&source.value,"id")?;
        if core.local_value(&format!("download:book:{id}"))?.is_some_and(|(_,v)|v==false){disabled=true;}else{return Ok(0);}
    }}
    if !disabled{return Ok(0);}
    for kind in shufang_domain::sync::ENTITY_KINDS.iter().filter(|k|**k!="sources") {
        for record in core.entities(kind)? {if crate::attachments::references(&record.value)?.iter().any(|r|r.sha256==m.sha256){return Ok(0);}}
    }
    // Keep the business mutex through deletion so a new shared reference cannot race.
    let store=BlobStore::new(&ws.root.join("sync-blobs"));let _lock=store.lock()?;let path=store.path(&m.sha256)?;
    match std::fs::metadata(&path){Ok(meta)=>{let bytes=meta.len();std::fs::remove_file(path).map_err(|e|e.to_string())?;Ok(bytes)},Err(e)if e.kind()==std::io::ErrorKind::NotFound=>Ok(0),Err(e)=>Err(e.to_string())}
}
pub fn command(ws:&Workspace,action:&str,args:&Value)->Result<Value> {
    let id=string(args,"id")?;let mut core=ws.core.lock().map_err(|_|"core_lock_failed")?;
    let m=match core.book_source(id){Ok(m)=>m,Err(e)if e=="source_not_found"&&action=="downloadState"=>return Ok(json!({"enabled":true,"available":false})),Err(e)=>return Err(e)};let key=format!("download:book:{id}");
    if action=="downloadState" {let wanted=core.local_value(&key)?.is_none_or(|(_,v)|v!=false);return Ok(json!({"enabled":wanted,"available":wanted&&BlobStore::new(&ws.root.join("sync-blobs")).has(&m.sha256)?}));}
    if action=="removeDownload" {let ack=core.local_value(&format!("file:remote:{}",m.sha256))?.ok_or("download_has_no_remote_receipt")?.1;if ack["sha256"]!=m.sha256||ack["size"]!=m.size{return Err("download_has_no_remote_receipt".into());}}
    let revision=core.local_value(&key)?.map_or(0,|(r,_)|r);core.set_local_value(&key,revision,&json!(action=="enableDownload"))?;drop(core);
    let bytes=if action=="removeDownload"{cleanup(ws,&m)?}else{0};Ok(json!({"removed":action=="removeDownload","releasedBytes":bytes}))
}
