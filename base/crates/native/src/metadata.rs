use crate::workspace::{Job, Result};
use serde_json::{json, Value};

fn strings(v: &Value, key: &str, count: usize, length: usize) -> Vec<String> {
    v[key]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .take(count)
        .map(|s| s.chars().take(length).collect())
        .collect()
}
pub fn normalize(response: &Value) -> Result<Value> {
    let docs = response["docs"]
        .as_array()
        .ok_or("invalid_metadata_response")?;
    let result: Vec<_>=docs.iter().take(10).filter_map(|doc| {
        let title=doc["title"].as_str()?.chars().take(255).collect::<String>();
        if title.trim().is_empty() { return None; }
        let authors=strings(doc,"author_name",16,64);
        let mut metadata=json!({"version":1,"contributors":authors.iter().map(|s|json!({"name":s,"role":"author"})).collect::<Vec<_>>(),"identifiers":strings(doc,"isbn",16,32).iter().map(|s|json!({"scheme":"ISBN","value":s})).collect::<Vec<_>>(),"subjects":strings(doc,"subject",32,64),"languages":strings(doc,"language",16,64)});
        if let Some(publisher)=strings(doc,"publisher",1,255).first() { metadata["publisher"]=publisher.clone().into(); }
        if let Some(year)=doc["first_publish_year"].as_u64().filter(|y|(1000..=9999).contains(y)) { metadata["publishedDate"]=year.to_string().into(); }
        Some(json!({"source":"Open Library","sourceId":doc["key"].as_str().unwrap_or(""),"title":title,"author":authors.join("；").chars().take(255).collect::<String>(),"metadata":metadata}))
    }).collect();
    Ok(result.into())
}
pub fn lookup(query: &str, job: &Job) -> Result<Value> {
    if query.trim().is_empty() || query.len() > 512 {
        return Err("invalid_metadata_query".into());
    }
    tokio::runtime::Runtime::new().map_err(|e|e.to_string())?.block_on(async {
        let client=reqwest::Client::builder().timeout(std::time::Duration::from_secs(20)).redirect(reqwest::redirect::Policy::none()).user_agent("Shufang/0.3 (desktop metadata lookup)").build().map_err(|_|"metadata_client_failed")?;
        job.check()?;
        let request=client.get("https://openlibrary.org/search.json").query(&[("q",query),("limit","10"),("fields","key,title,author_name,publisher,first_publish_year,language,isbn,subject")]).send();
        let mut response=tokio::select! { value=request => value.map_err(|_|"metadata_network_failed")?, _=async { loop { if job.check().is_err() { break; } tokio::time::sleep(std::time::Duration::from_millis(50)).await; } } => return Err("cancelled".into()) };
        if !response.status().is_success() { return Err("metadata_provider_failed".into()); }
        let mut bytes=Vec::new();
        while let Some(chunk)=response.chunk().await.map_err(|_|"metadata_network_failed")? { job.check()?;if bytes.len()+chunk.len()>2*1024*1024 { return Err("metadata_response_limit".into()); } bytes.extend_from_slice(&chunk); }
        normalize(&serde_json::from_slice(&bytes).map_err(|_|"invalid_metadata_response")?)
    })
}
