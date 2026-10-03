use shufang_application::{
    externalize::{hydrate_fields, prepare_fields, FieldObjects, FieldReader, INLINE_FIELD_LIMIT},
    BlobManifest,
};
use shufang_domain::lossless_json::Json;
struct Store {
    fail: bool,
    objects: Vec<(BlobManifest, String)>,
}
impl FieldObjects for Store {
    fn put_field(&mut self, manifest: &BlobManifest, json: &str) -> Result<(), String> {
        if self.fail {
            return Err("isolated_object_failure".into());
        }
        self.objects.push((manifest.clone(), json.into()));
        Ok(())
    }
}
impl FieldReader for Store {
    fn read_field(&self, hash: &str, _size: u64) -> Result<Vec<u8>, String> {
        self.objects
            .iter()
            .find(|(manifest, _)| manifest.sha256 == hash)
            .map(|(_, body)| body.as_bytes().to_vec())
            .ok_or("sync_field_pending".into())
    }
}
#[test]
fn fields_are_externalized_before_operation_commit_without_changing_utf16() {
    let input = format!(
        r#"{{"title":"\ud800","content":"{}\udfff"}}"#,
        "x".repeat(INLINE_FIELD_LIMIT)
    );
    let patch = Json::parse(&input).unwrap();
    let mut store = Store {
        fail: false,
        objects: vec![],
    };
    let prepared = prepare_fields(&patch, &mut store).unwrap();
    assert_eq!(store.objects.len(), 1);
    let (manifest, body) = &store.objects[0];
    assert_eq!(manifest.size, body.len() as u64);
    assert_eq!(manifest.name, "field.json");
    assert!(body.ends_with(r#"\udfff""#));
    assert_eq!(hydrate_fields(&prepared, &store).unwrap(), patch);
    assert_eq!(
        prepared
            .get("title")
            .unwrap()
            .to_owned()
            .string_units()
            .unwrap(),
        &[0xd800]
    );
    assert_eq!(
        prepared
            .get("content")
            .unwrap()
            .to_owned()
            .get("$blob")
            .unwrap()
            .to_owned()
            .get("sha256")
            .unwrap()
            .to_owned()
            .string_units()
            .unwrap(),
        manifest.sha256.encode_utf16().collect::<Vec<_>>()
    );
    let mut failed = Store {
        fail: true,
        objects: vec![],
    };
    assert_eq!(
        prepare_fields(&patch, &mut failed).unwrap_err(),
        "isolated_object_failure"
    );
    assert!(patch
        .get("content")
        .unwrap()
        .to_owned()
        .string_units()
        .is_some());
}
#[test]
fn invalid_blob_shaped_extension_values_remain_ordinary_json() {
    let patch = Json::parse(
        r#"{"metadata":{"$blob":{"sha256":"not-a-hash","size":0}},"other":{"$blob":false}}"#,
    )
    .unwrap();
    assert_eq!(
        hydrate_fields(
            &patch,
            &Store {
                fail: false,
                objects: vec![]
            }
        )
        .unwrap(),
        patch
    );
}
#[test]
fn threshold_is_encoded_bytes_and_existing_references_are_preserved() {
    let patch=Json::parse(&format!(r#"{{"at":"{}","over":"{}","blob":{{"$blob":{{"sha256":"{}","size":1,"name":"old.json","type":"application/json"}}}}}}"#,"a".repeat(INLINE_FIELD_LIMIT-2),"a".repeat(INLINE_FIELD_LIMIT-1),"a".repeat(64))).unwrap();
    let mut store = Store {
        fail: false,
        objects: vec![],
    };
    let prepared = prepare_fields(&patch, &mut store).unwrap();
    assert_eq!(store.objects.len(), 1);
    assert!(prepared
        .get("at")
        .unwrap()
        .to_owned()
        .string_units()
        .is_some());
    assert_eq!(
        prepared.get("blob").unwrap().to_owned(),
        patch.get("blob").unwrap().to_owned()
    );
}
