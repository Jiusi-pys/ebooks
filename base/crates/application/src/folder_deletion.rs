//! Decide cascade membership using identifiers only; large book contents stay in storage.
use crate::Result;
use shufang_domain::lossless_json::{quote_units, Json};
fn belongs(folder: &[u16], membership: Option<&[u16]>) -> bool {
    membership == Some(folder)
}
pub fn plan_json(folder_json: &str, books_json: &str) -> Result<String> {
    let folder = Json::parse(folder_json)?;
    let folder = folder.string_units().ok_or("invalid_folder")?;
    let books = Json::parse(books_json)?.elements().ok_or("invalid_books")?;
    let mut ids = Vec::new();
    for book in books {
        let membership = book.get("folderId").map(|v| v.to_owned());
        if belongs(folder, membership.as_ref().and_then(Json::string_units)) {
            let id = book.get("id").ok_or("invalid_book")?.to_owned();
            ids.push(quote_units(id.string_units().ok_or("invalid_book")?));
        }
    }
    Ok(format!("[{}]", ids.join(",")))
}
pub fn books_to_detach<'a>(
    folder_id: &str,
    books: impl IntoIterator<Item = (&'a str, Option<&'a str>)>,
) -> Vec<String> {
    let folder_id: Vec<_> = folder_id.encode_utf16().collect();
    books
        .into_iter()
        .filter(|(_, folder)| {
            belongs(
                &folder_id,
                folder
                    .map(|v| v.encode_utf16().collect::<Vec<_>>())
                    .as_deref(),
            )
        })
        .map(|(id, _)| id.to_owned())
        .collect()
}
