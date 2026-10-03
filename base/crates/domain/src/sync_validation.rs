//! Partial projection checks matching workspace-v2's known fields. Unknown fields
//! remain extensible; valid externalized fields bypass this partial check as in
//! the existing protocol. Full hydrated projection validation is a separate gate.
use crate::sync::{Operation, Result};
use serde_json::Value;

fn number(v: &Value) -> bool {
    v.as_f64().is_some_and(f64::is_finite)
}
fn string(v: &Value) -> bool {
    v.is_string()
}
fn strings(v: &Value) -> bool {
    v.as_array().is_some_and(|a| a.iter().all(string))
}
type FieldCheck = fn(&Value) -> bool;
fn object(v: &Value, fields: &[(&str, FieldCheck)]) -> bool {
    v.is_object() && fields.iter().all(|(k, check)| v.get(k).is_some_and(*check))
}
fn anchor(v: &Value) -> bool {
    object(v, &[("bookId", string)])
}
fn progress(v: &Value) -> bool {
    object(v, &[("chapterId", string), ("ratio", number)])
}
fn root(v: &Value) -> bool {
    object(
        v,
        &[
            ("id", string),
            ("text", string),
            ("children", |v| v.is_array()),
        ],
    )
}
fn chapters(v: &Value) -> bool {
    v.as_array().is_some_and(|a| {
        a.iter().all(|v| {
            object(
                v,
                &[("id", string), ("title", string), ("paragraphs", strings)],
            )
        })
    })
}
fn sessions(v: &Value) -> bool {
    v.as_array().is_some_and(|a| {
        a.iter().all(|v| {
            let Some(o) = v.as_object() else {
                return false;
            };
            o.len() == 4
                && v["id"].as_str().is_some_and(crate::sync::valid_identifier)
                && v["bookId"].as_str().is_some_and(|s| {
                    let op = Operation {
                        workspace_id: "w".into(),
                        replica_id: "n".into(),
                        operation_id: "o".into(),
                        kind: "books".into(),
                        entity_id: s.into(),
                        clock: "1:0".into(),
                        patch: Default::default(),
                        unset: vec![],
                        deleted: false,
                    };
                    // Identifier validation is shared with the wire operation contract.
                    crate::sync::validate_operation(&op).is_ok()
                })
                && v["startedAt"].as_f64().is_some_and(|n| n >= 0.0)
                && v["endedAt"]
                    .as_f64()
                    .is_some_and(|n| n >= v["startedAt"].as_f64().unwrap_or(f64::INFINITY))
        })
    })
}
fn blob(v: &Value) -> bool {
    let b = &v["$blob"];
    b["sha256"].as_str().is_some_and(|s| {
        s.len() == 64
            && s.bytes()
                .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
    }) && b["size"]
        .as_f64()
        .is_some_and(|n| n.fract() == 0.0 && (0.0..=268435456.0).contains(&n))
}

pub fn validate_patch(op: &Operation) -> Result<()> {
    for (key, value) in &op.patch {
        if blob(value) {
            continue;
        }
        let valid = match (op.kind.as_str(), key.as_str()) {
            ("sources", "sha256") => value.as_str().is_some_and(|s| {
                s.len() == 64
                    && s.bytes()
                        .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
            }),
            ("sources", "size") => value
                .as_f64()
                .is_some_and(|n| n.fract() == 0.0 && (0.0..=268435456.0).contains(&n)),
            ("sources", "name") => value
                .as_str()
                .is_some_and(|s| s.encode_utf16().count() <= 255),
            ("sources", "type") => value
                .as_str()
                .is_some_and(|s| s.encode_utf16().count() <= 128),
            ("sources", "format") => string(value),
            ("books", "format") => value.as_str().is_some_and(|s| {
                ["pdf", "epub", "mobi", "azw3", "fb2", "txt", "builtin"].contains(&s)
            }),
            ("books", "chapters") => chapters(value),
            ("books", "progress") => progress(value),
            ("books", "readingSessions") => sessions(value),
            ("books", "coverTone") => number(value),
            ("mindMaps", "root") => root(value),
            ("studySets", "bookIds") => strings(value),
            ("associations", "source" | "target") => anchor(value),
            ("associations", "direction") => value
                .as_str()
                .is_some_and(|s| ["bidirectional", "source-to-target"].contains(&s)),
            (
                "notes" | "books" | "folders" | "highlights" | "translations" | "mindMaps"
                | "studySets" | "associations",
                "createdAt",
            ) => number(value),
            ("notes" | "translations" | "studySets" | "associations", "updatedAt") => number(value),
            ("notes", "title" | "content")
            | ("books", "title" | "author")
            | ("folders" | "studySets", "name")
            | ("highlights", "bookId" | "chapterId" | "chapterTitle" | "text")
            | ("translations", "bookId" | "chapterId" | "targetLang" | "text")
            | ("mindMaps", "title" | "bookId")
            | ("associations", "pairKey") => string(value),
            _ => true,
        };
        if !valid {
            return Err("validation_failed".into());
        }
    }
    Ok(())
}
