//! Copy a deleted container without leaving its learning references on tombstones.
use crate::{CoreSession, Repository, Result, Runtime};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, BTreeSet};

fn key(kind: &str, id: &str) -> String {
    format!("{kind}:{id}")
}
fn contains(value: &Value, field: &str, kind: &str, ids: &BTreeSet<String>) -> bool {
    value[field]
        .as_str()
        .is_some_and(|id| ids.contains(&key(kind, id)))
}
fn node_selected(value: &Value, ids: &BTreeSet<String>) -> bool {
    contains(value, "sourceHighlightId", "highlights", ids)
        || value["children"]
            .as_array()
            .is_some_and(|children| children.iter().any(|c| node_selected(c, ids)))
}
fn rewrite(value: &mut Value, field: &str, kind: &str, ids: &BTreeMap<String, String>) {
    if let Some(id) = value[field]
        .as_str()
        .and_then(|id| ids.get(&key(kind, id)))
        .cloned()
    {
        value[field] = id.into();
    }
}
fn rewrite_nodes(value: &mut Value, ids: &BTreeMap<String, String>) {
    rewrite(value, "sourceHighlightId", "highlights", ids);
    if let Some(children) = value["children"].as_array_mut() {
        for child in children {
            rewrite_nodes(child, ids);
        }
    }
}
fn encoded(id: &str) -> String {
    id.bytes()
        .map(|b| {
            if b.is_ascii_alphanumeric() || b"_.~".contains(&b) {
                (b as char).to_string()
            } else {
                format!("%{b:02X}")
            }
        })
        .collect()
}
fn replace_link(text: &str, old: &str, new: &str) -> String {
    let mut output = String::new();
    let mut rest = text;
    while let Some(start) = rest.find(old) {
        output.push_str(&rest[..start]);
        let tail = &rest[start + old.len()..];
        let boundary = tail.chars().next().is_none_or(|c| {
            c.is_whitespace() || matches!(c, '?' | '#' | ')' | ']' | '"' | '\'' | '<' | '>')
        });
        output.push_str(if boundary { new } else { old });
        rest = tail;
    }
    output.push_str(rest);
    output
}

impl<R: Repository, T: Runtime> CoreSession<R, T> {
    pub(crate) fn conflict_container_copies(
        &self,
        kind: &str,
        id: &str,
        new_id: &str,
    ) -> Result<Vec<(String, String, Value)>> {
        let mut records = vec![];
        for kind in [
            "folders",
            "books",
            "sources",
            "highlights",
            "notes",
            "mindMaps",
            "translations",
            "studySets",
            "associations",
            "reviews",
        ] {
            for row in self.repository.list(kind)? {
                let mut summary = row.state.clone();
                if kind == "books" {
                    summary.fields.remove("chapters");
                }
                if kind == "notes" {
                    summary.fields.remove("content");
                }
                if let Some(value) = self.materialize_state(&summary)? {
                    records.push((kind.to_owned(), row.state.id, value));
                }
            }
        }
        if records.len() > 10_000 {
            return Err("sync_conflict_dependency_limit".into());
        }
        let mut selected = BTreeSet::from([key(kind, id)]);
        loop {
            let before = selected.len();
            for (kind, id, value) in &records {
                let linked = match kind.as_str() {
                    "folders" => contains(value, "parentId", "folders", &selected),
                    "books" => contains(value, "folderId", "folders", &selected),
                    "sources" => selected.contains(&key("books",id)),
                    "highlights" => {
                        contains(value, "bookId", "books", &selected)
                            || value["sourceRanges"].as_array().is_some_and(|ranges| {
                                ranges
                                    .iter()
                                    .any(|r| contains(r, "bookId", "books", &selected))
                            })
                    }
                    "notes" => {
                        contains(value, "bookId", "books", &selected)
                            || records.iter().any(|(k, i, v)| {
                                k == "highlights"
                                    && selected.contains(&key(k, i))
                                    && v["noteId"] == id.as_str()
                            })
                    }
                    "mindMaps" => {
                        contains(value, "bookId", "books", &selected)
                            || node_selected(&value["root"], &selected)
                    }
                    "translations" => contains(value, "bookId", "books", &selected),
                    "studySets" => value["bookIds"].as_array().is_some_and(|books| {
                        books.iter().any(|b| {
                            b.as_str()
                                .is_some_and(|i| selected.contains(&key("books", i)))
                        })
                    }),
                    "associations" => {
                        contains(value, "bookId", "books", &selected)
                            || ["source", "target"]
                                .iter()
                                .any(|side| contains(&value[*side], "bookId", "books", &selected))
                    }
                    "reviews" => contains(value, "highlightId", "highlights", &selected),
                    _ => false,
                };
                if linked {
                    selected.insert(key(kind, id));
                }
            }
            if before == selected.len() {
                break;
            }
        }
        let mut ids: BTreeMap<String, String> = selected
            .iter()
            .map(|k| (k.clone(), self.runtime.new_id()))
            .collect();
        ids.insert(key(kind, id), new_id.into());
        for (kind,id,_) in &records {
            if kind=="sources" && selected.contains(&key(kind,id)) {
                if let Some(book)=ids.get(&key("books",id)).cloned() {ids.insert(key(kind,id),book);}
            }
        }
        // PDF ink identities are derived from the new book identity, not random IDs.
        for (kind, id, value) in &records {
            if kind == "notes" && id.starts_with("pdfink.") {
                if let Some(book) = value["bookId"]
                    .as_str()
                    .and_then(|b| ids.get(&key("books", b)))
                    .cloned()
                {
                    if let Some(page) = value["pdfPage"].as_u64() {
                        ids.insert(
                            key(kind, id),
                            format!("pdfink.{:x}.{page}", Sha256::digest(book.as_bytes())),
                        );
                    }
                }
            }
        }
        let mut copies = vec![];
        for (kind, id, _) in records {
            let Some(new_id) = ids.get(&key(&kind, &id)).cloned() else {
                continue;
            };
            let mut value = self.entity(&kind, &id)?.value;
            match kind.as_str() {
                "books" => {
                    rewrite(&mut value, "folderId", "folders", &ids);
                    if value.get("extId").is_some() {
                        value["extId"] = new_id.clone().into();
                    }
                }
                "folders" => rewrite(&mut value, "parentId", "folders", &ids),
                "highlights" => {
                    rewrite(&mut value, "bookId", "books", &ids);
                    rewrite(&mut value, "noteId", "notes", &ids);
                    if let Some(ranges) = value["sourceRanges"].as_array_mut() {
                        for r in ranges {
                            rewrite(r, "bookId", "books", &ids);
                        }
                    }
                }
                "notes" => {
                    rewrite(&mut value, "bookId", "books", &ids);
                    if let Some(content) = value["content"].as_str() {
                        let mut text = content.to_owned();
                        for (k, new) in &ids {
                            let (kind, old) = k.split_once(':').ok_or("invalid_sync_copy")?;
                            for prefix in [
                                format!("shufang://{kind}/"),
                                format!("shufang://{}/", kind.trim_end_matches('s')),
                            ] {
                                text = replace_link(&text,
                                    &format!("{prefix}{}", encoded(old)),
                                    &format!("{prefix}{}", encoded(new)),
                                );
                            }
                            if kind == "notes" {
                                text = text
                                    .replace(&format!("[[{old}]]"), &format!("[[{new}]]"))
                                    .replace(&format!("[[{old}|"), &format!("[[{new}|"));
                            }
                        }
                        value["content"] = text.into();
                    }
                }
                "mindMaps" => {
                    rewrite(&mut value, "bookId", "books", &ids);
                    rewrite_nodes(&mut value["root"], &ids);
                }
                "translations" => rewrite(&mut value, "bookId", "books", &ids),
                "studySets" => {
                    if let Some(books) = value["bookIds"].as_array_mut() {
                        for book in books {
                            if let Some(id) = book
                                .as_str()
                                .and_then(|b| ids.get(&key("books", b)))
                                .cloned()
                            {
                                *book = id.into();
                            }
                        }
                    }
                }
                "associations" => {
                    for side in ["source", "target"] {
                        rewrite(&mut value[side], "bookId", "books", &ids);
                    }
                    value["pairKey"] = shufang_domain::associations::pair_key(
                        &value["source"],
                        &value["target"],
                        value["direction"].as_str().unwrap_or("bidirectional"),
                    )?
                    .into();
                }
                "reviews" => rewrite(&mut value, "highlightId", "highlights", &ids),
                _ => {}
            }
            value
                .as_object_mut()
                .ok_or("invalid_sync_copy")?
                .remove("id");
            copies.push((kind, new_id, value));
        }
        Ok(copies)
    }
}

#[cfg(test)]
mod tests {
    use super::replace_link;
    #[test]
    fn references_do_not_rewrite_ids_with_a_shared_prefix() {
        assert_eq!(replace_link("[A](shufang://notes/n) [B](shufang://notes/n2) shufang://notes/n#p", "shufang://notes/n", "shufang://notes/copy"), "[A](shufang://notes/copy) [B](shufang://notes/n2) shufang://notes/copy#p");
    }
}
