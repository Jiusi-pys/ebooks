use serde_json::{json, Value};

/// Describe the native v2 adapter without embedding credentials or node URLs.
pub fn document() -> Value {
    let mut paths = serde_json::Map::new();
    for (method, path, summary) in [
        ("get", "/capabilities", "Protocol and transfer limits"),
        (
            "post",
            "/sync/preflight",
            "Read current entity versions and immutable-operation acceptance without writes",
        ),
        (
            "post",
            "/sync/push",
            "Persist immutable operations with per-item receipts",
        ),
        (
            "get",
            "/sync/changes",
            "Read changes using a node-scoped cursor",
        ),
        (
            "post",
            "/sync/snapshots",
            "Create a fixed-watermark snapshot",
        ),
        ("get", "/sync/snapshots/{id}", "Read snapshot pages"),
        (
            "get",
            "/entities",
            "Read field-version entity states and tombstones",
        ),
        (
            "get",
            "/entities/{kind}/{id}/history",
            "Read the latest 100 operations",
        ),
        (
            "post",
            "/entities/{kind}/{id}/restore",
            "Restore to a new entity identity",
        ),
        (
            "post",
            "/mutations",
            "Commit a locally clocked mutation and deletion cascades",
        ),
        ("get", "/status", "Read replication status"),
        (
            "post",
            "/peers",
            "Owner: issue an inbound workspace credential",
        ),
        (
            "delete",
            "/peers/{id}",
            "Owner: revoke an inbound workspace credential",
        ),
        ("post", "/blobs/uploads", "Create a resumable upload"),
        (
            "get",
            "/blobs/uploads/{id}",
            "Read manifest and missing chunk indexes",
        ),
        (
            "put",
            "/blobs/uploads/{id}/{index}",
            "Upload a chunk with X-Chunk-SHA256",
        ),
        (
            "post",
            "/blobs/uploads/{id}/commit",
            "Verify total size and SHA-256",
        ),
        (
            "get",
            "/blobs/{hash}",
            "Download an original file or field payload",
        ),
        (
            "get",
            "/blobs/{hash}/chunks/{index}",
            "Download a 256 KiB chunk",
        ),
    ] {
        let mut parameters = vec![
            json!({"name":"X-Workspace-Id","in":"header","required":false,"description":"Required with a node credential","schema":{"type":"string"}}),
        ];
        for segment in path.split('/') {
            if let Some(name) = segment.strip_prefix('{').and_then(|s| s.strip_suffix('}')) {
                parameters.push(
                    json!({"name":name,"in":"path","required":true,"schema":{"type":"string"}}),
                );
            }
        }
        for name in match path {
            "/sync/changes" => &["cursor"][..],
            "/entities" => &["kind", "after"][..],
            "/sync/snapshots/{id}" => &["after"][..],
            _ => &[][..],
        } {
            parameters.push(json!({"name":name,"in":"query","schema":{"type":"string"}}));
        }
        let mut operation = json!({"summary":summary,"parameters":parameters,"responses":{"200":{"description":"Success"},"400":{"description":"Invalid input"},"401":{"description":"Missing or invalid credential"},"403":{"description":"Workspace or owner scope required"},"409":{"description":"Identity, cursor, or revision conflict"},"503":{"description":"Storage unavailable"}}});
        if method == "post" || method == "put" {
            operation["requestBody"] = if method == "put" {
                operation["parameters"].as_array_mut().unwrap().push(json!({"name":"X-Chunk-SHA256","in":"header","required":true,"schema":{"type":"string","pattern":"^[a-f0-9]{64}$"}}));
                json!({"required":true,"content":{"application/octet-stream":{"schema":{"type":"string","format":"binary"}}}})
            } else {
                json!({"required":false,"content":{"application/json":{"schema":{"type":"object"}}}})
            };
        }
        if ["/sync/snapshots", "/peers", "/blobs/uploads"].contains(&path) && method == "post" {
            operation["responses"]
                .as_object_mut()
                .unwrap()
                .remove("200");
            operation["responses"]["201"] = json!({"description":"Created"});
        }
        if path.starts_with("/blobs/{hash}") {
            operation["responses"]["200"] = json!({"description":"Binary data","content":{"application/octet-stream":{"schema":{"type":"string","format":"binary"}}}});
        }
        paths.entry(path.to_owned()).or_insert(json!({}))[method] = operation;
    }
    json!({"openapi":"3.0.3","info":{"title":"Shufang native workspace-v2","version":"2"},"servers":[{"url":"/api/v2"}],"security":[{"BearerAuth":[]},{"ApiKeyAuth":[]}],"paths":paths,"components":{"securitySchemes":{"BearerAuth":{"type":"http","scheme":"bearer"},"ApiKeyAuth":{"type":"apiKey","in":"header","name":"X-API-Key"}}}})
}
