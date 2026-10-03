use crate::{Change, Commit, CoreSession, Repository, Result, Runtime};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use shufang_domain::sync::{apply_operation, flatten_fields, next_clock, Operation};
use std::collections::{BTreeMap, BTreeSet};

pub const KINDS: &[&str] = &[
    "books",
    "folders",
    "notes",
    "highlights",
    "associations",
    "translations",
    "mindMaps",
    "studySets",
    "preferences",
];

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Record {
    pub revision: u64,
    pub value: Value,
    #[serde(
        rename = "pendingFields",
        default,
        skip_serializing_if = "Vec::is_empty"
    )]
    pub pending_fields: Vec<String>,
}

impl<R: Repository, T: Runtime> CoreSession<R, T> {
    pub fn import_book(
        &mut self,
        id: &str,
        mut book: Value,
        source: &crate::BlobManifest,
    ) -> Result<Record> {
        crate::externalize::validate_source_link(id, id, source.size)?;
        source.validate()?;
        if self.repository.load("books", id)?.is_some()
            || self.repository.load("sources", id)?.is_some()
        {
            return Err("import_identity_exists".into());
        }
        if !book.is_object() {
            return Err("invalid_book".into());
        }
        book["id"] = id.into();
        book["createdAt"] = self.runtime.now().into();
        self.validate("books", &book)?;
        let mut original = serde_json::to_value(source).map_err(|_| "invalid_source")?;
        original["id"] = id.into();
        original["format"] = book["format"].clone();
        let changes = BTreeMap::from([
            (("books".into(), id.into()), Some(book)),
            (("sources".into(), id.into()), Some(original)),
        ]);
        self.commit_values(&self.repository.clock()?, changes)?;
        self.entity("books", id)
    }
    pub fn book_source(&self, id: &str) -> Result<crate::BlobManifest> {
        let book = self.repository.load("books", id)?.ok_or("not_found")?;
        if book.state.deleted {
            return Err("entity_deleted".into());
        }
        let source = self
            .repository
            .load("sources", id)?
            .ok_or("source_not_found")?;
        let value = self
            .materialize_state(&source.state)?
            .ok_or("source_deleted")?;
        let manifest: crate::BlobManifest =
            serde_json::from_value(value).map_err(|_| "invalid_source")?;
        manifest.validate()?;
        Ok(manifest)
    }
    pub fn attach_book_source(&mut self, id: &str, source: &crate::BlobManifest) -> Result<()> {
        source.validate()?;
        let book = self.entity("books", id)?;
        if let Ok(prior) = self.book_source(id) {
            if prior.sha256 == source.sha256 && prior.size == source.size {
                return Ok(());
            }
            return Err("source_identity_reused".into());
        }
        if self.repository.load("sources", id)?.is_some() {
            return Err("source_identity_reused".into());
        }
        let mut original = serde_json::to_value(source).map_err(|_| "invalid_source")?;
        original["id"] = id.into();
        original["format"] = book.value["format"].clone();
        self.commit_values(
            &self.repository.clock()?,
            BTreeMap::from([(("sources".into(), id.into()), Some(original))]),
        )
    }
    pub fn entities(&self, kind: &str) -> Result<Vec<Record>> {
        valid_kind(kind)?;
        self.repository
            .list(kind)?
            .into_iter()
            .filter(|r| !r.state.deleted)
            .map(|r| self.metadata_record(&r))
            .collect()
    }
    pub fn entity(&self, kind: &str, id: &str) -> Result<Record> {
        valid_kind(kind)?;
        let row = self.repository.load(kind, id)?.ok_or("not_found")?;
        Ok(Record {
            revision: row.revision,
            value: self
                .materialize_state(&row.state)?
                .ok_or("entity_deleted")?,
            pending_fields: vec![],
        })
    }
    fn metadata_record(&self, row: &crate::StoredEntity) -> Result<Record> {
        match self.materialize_state(&row.state) {
            Ok(value) => Ok(Record {
                revision: row.revision,
                value: value.ok_or("entity_deleted")?,
                pending_fields: vec![],
            }),
            Err(error) if error == "sync_field_pending" => Ok(Record {
                revision: row.revision,
                value: shufang_domain::sync::materialize(&row.state)?.ok_or("entity_deleted")?,
                pending_fields: row
                    .state
                    .fields
                    .iter()
                    .filter(|(_, field)| {
                        field
                            .value
                            .as_ref()
                            .is_some_and(|v| v.get("$blob").is_some())
                    })
                    .map(|(key, _)| key.clone())
                    .collect(),
            }),
            Err(error) => Err(error),
        }
    }
    pub fn entity_metadata(&self, kind: &str, id: &str) -> Result<Record> {
        valid_kind(kind)?;
        let row = self.repository.load(kind, id)?.ok_or("not_found")?;
        self.metadata_record(&row)
    }
    pub fn changes(&self, after: u64, limit: u32) -> Result<Vec<Change>> {
        self.repository.changes(after, limit)
    }
    pub fn local_value(&self, key: &str) -> Result<Option<(u64, Value)>> {
        self.repository.get_local(key)
    }
    pub fn transport_usage(&self, prefix: &str) -> Result<(u64, u64)> {
        if !["event:", "upload:"].contains(&prefix) {
            return Err("invalid_transport_prefix".into());
        }
        self.repository.local_usage(prefix)
    }
    pub fn purge_transport_cache(&mut self) -> Result<u64> {
        let now = self.runtime.now();
        Ok(self.repository.delete_expired_local("event:", now, 1000)?
            + self.repository.delete_expired_local("upload:", now, 1000)?)
    }
    pub fn set_local_value(&mut self, key: &str, expected: u64, value: &Value) -> Result<u64> {
        if self.receipt_scope {
            let mut locals = self
                .pending_local
                .take()
                .ok_or("receipt_multiple_commits")?;
            locals.push(crate::LocalCommit {
                key: key.into(),
                expected,
                value: value.clone(),
            });
            self.repository
                .commit_batch_local(&self.repository.clock()?, &[], &locals)?;
            return expected.checked_add(1).ok_or("revision_overflow".into());
        }
        self.repository.set_local(key, expected, value)
    }

    pub fn save_entity(
        &mut self,
        kind: &str,
        id: &str,
        patch: Value,
        unset: Vec<String>,
        expected: u64,
    ) -> Result<Record> {
        valid_kind(kind)?;
        let clock = self.repository.clock()?;
        let prior = self.repository.load(kind, id)?;
        if prior.as_ref().map_or(0, |r| r.revision) != expected {
            return Err("revision_conflict".into());
        }
        if prior.as_ref().is_some_and(|r| r.state.deleted) {
            return Err("entity_deleted".into());
        }
        let mut value = prior
            .as_ref()
            .map(|r| self.materialize_state(&r.state))
            .transpose()?
            .flatten()
            .unwrap_or(json!({}));
        let fields = patch.as_object().ok_or("invalid_patch")?;
        if fields.contains_key("id")
            || fields.contains_key("createdAt")
            || fields.contains_key("updatedAt")
            || unset
                .iter()
                .any(|k| ["id", "createdAt"].contains(&k.as_str()))
        {
            return Err("reserved_field".into());
        }
        for (key, item) in fields {
            value[key] = item.clone();
        }
        for key in unset {
            value.as_object_mut().unwrap().remove(&key);
        }
        if prior.is_none() {
            value["createdAt"] = self.runtime.now().into();
        }
        value["updatedAt"] = self.runtime.now().into();
        value["id"] = id.into();
        self.validate(kind, &value)?;
        if kind == "associations" {
            let pair = shufang_domain::associations::pair_key(
                &value["source"],
                &value["target"],
                text(&value, "direction")?,
            )?;
            for association in self.entities("associations")? {
                if association.value["id"] != id
                    && shufang_domain::associations::pair_key(
                        &association.value["source"],
                        &association.value["target"],
                        text(&association.value, "direction")?,
                    )? == pair
                {
                    return Err("association_exists".into());
                }
            }
            value["pairKey"] = pair.into();
            value["pairKeyVersion"] = 2.into();
        }
        let mut changes = BTreeMap::new();
        // A highlight and its generated note block are one core transaction,
        // regardless of which presentation or transport edits the highlight.
        if kind == "highlights" {
            let old = prior
                .as_ref()
                .map(|r| self.materialize_state(&r.state))
                .transpose()?
                .flatten();
            let old_note = old.as_ref().and_then(|v| v["noteId"].as_str());
            let new_note = value["noteId"].as_str();
            let note_ids: BTreeSet<_> = old_note.into_iter().chain(new_note).collect();
            for nid in note_ids {
                let mut note = self.entity("notes", nid)?;
                let mut content = text(&note.value, "content")?.to_owned();
                if let Some(old) = old.as_ref().filter(|v| v["noteId"] == nid) {
                    let book = self.entity("books", text(old, "bookId")?)?;
                    content =
                        replace_block(&content, &citation(old, text(&book.value, "title")?), "")
                            .trim()
                            .to_owned();
                }
                if new_note == Some(nid) {
                    let book = self.entity("books", text(&value, "bookId")?)?;
                    let block = citation(&value, text(&book.value, "title")?);
                    content = format!(
                        "{}{}{}",
                        content,
                        if content.is_empty() { "" } else { "\n\n" },
                        block
                    );
                }
                note.value["content"] = content.into();
                changes.insert(("notes".into(), nid.into()), Some(note.value));
            }
        }
        // Rename source titles only in exact generated citation blocks.
        if kind == "books" {
            if let Some(prior) = &prior {
                let old = self
                    .materialize_state(&prior.state)?
                    .ok_or("entity_deleted")?;
                if old["title"] != value["title"] {
                    for h in self
                        .entities("highlights")?
                        .into_iter()
                        .filter(|r| r.value["bookId"] == id && r.value["noteId"].is_string())
                    {
                        let nid = text(&h.value, "noteId")?;
                        let mut n = self.entity("notes", nid)?;
                        if let Some(v) = changes.get(&("notes".into(), nid.to_string())) {
                            n.value = Option::<Value>::clone(v).ok_or("not_found")?;
                        }
                        let old_block = citation(&h.value, text(&old, "title")?);
                        let new_block = citation(&h.value, text(&value, "title")?);
                        n.value["content"] =
                            replace_block(text(&n.value, "content")?, &old_block, &new_block)
                                .into();
                        changes.insert(("notes".into(), nid.into()), Some(n.value));
                    }
                }
            }
        }
        changes.insert((kind.into(), id.into()), Some(value));
        self.commit_values(&clock, changes)?;
        self.entity(kind, id)
    }

    fn commit_values(
        &mut self,
        clock: &str,
        changes: BTreeMap<(String, String), Option<Value>>,
    ) -> Result<()> {
        let mut next = clock.to_owned();
        let mut commits = Vec::new();
        let mut invalidations = BTreeMap::new();
        for ((kind, id), value) in changes {
            let prior = self.repository.load(&kind, &id)?;
            if kind == "books" {
                if let Some(old) = prior
                    .as_ref()
                    .map(|r| self.materialize_state(&r.state))
                    .transpose()?
                    .flatten()
                {
                    if let Some(hash) = old["contentHash"].as_str().filter(|s| !s.is_empty()) {
                        let key = format!("digest:{hash}");
                        if let Some((expected, mut cached)) = self.repository.get_local(&key)? {
                            if cached.is_object() {
                                cached["invalidated"] = true.into();
                            }
                            invalidations.insert(
                                key.clone(),
                                crate::LocalCommit {
                                    key,
                                    expected,
                                    value: cached,
                                },
                            );
                        }
                    }
                }
            }
            let expected = prior.as_ref().map_or(0, |r| r.revision);
            let mut fields = value
                .clone()
                .unwrap_or(json!({}))
                .as_object()
                .ok_or("invalid_record")?
                .clone();
            fields.remove("id");
            if value.is_some() {
                fields.insert("updatedAt".into(), self.runtime.now().into());
            }
            let patch = self.prepare_patch(flatten_fields(&kind, &fields)?)?;
            let unset = prior
                .as_ref()
                .map(|r| {
                    r.state
                        .fields
                        .keys()
                        .filter(|k| !patch.contains_key(*k))
                        .cloned()
                        .collect()
                })
                .unwrap_or_default();
            next = next_clock(&next, self.runtime.now())?;
            let operation = Operation {
                workspace_id: self.workspace.clone(),
                replica_id: self.replica.clone(),
                operation_id: self.runtime.new_id(),
                kind,
                entity_id: id,
                clock: next.clone(),
                patch,
                unset,
                deleted: value.is_none(),
            };
            let state = apply_operation(prior.as_ref().map(|r| &r.state), &operation)?;
            commits.push(Commit {
                expected,
                state,
                operation,
            });
        }
        let mut locals = if self.receipt_scope {
            self.pending_local
                .take()
                .ok_or("receipt_multiple_commits")?
        } else {
            Vec::new()
        };
        locals.extend(invalidations.into_values());
        self.repository.commit_batch_local(clock, &commits, &locals)
    }

    pub fn delete_entity(&mut self, kind: &str, id: &str, expected: u64) -> Result<()> {
        self.delete_entity_inner(kind, id, expected, false)
    }
    pub fn delete_legacy_note(&mut self, id: &str, expected: u64) -> Result<()> {
        self.delete_entity_inner("notes", id, expected, true)
    }
    fn delete_entity_inner(
        &mut self,
        kind: &str,
        id: &str,
        expected: u64,
        cascade_note: bool,
    ) -> Result<()> {
        let clock = self.repository.clock()?;
        let record = self.entity(kind, id)?;
        if record.revision != expected {
            return Err("revision_conflict".into());
        }
        let mut changes: BTreeMap<(String, String), Option<Value>> = BTreeMap::new();
        changes.insert((kind.into(), id.into()), None);
        for h in self.entities("highlights")? {
            let hid = text(&h.value, "id")?;
            if (kind == "books" && h.value["bookId"] == id) || (kind == "highlights" && hid == id) {
                changes.insert(("highlights".into(), hid.into()), None);
                if let Some(nid) = h.value["noteId"].as_str() {
                    let mut n = self.entity("notes", nid)?;
                    if let Some(Some(v)) = changes.get(&("notes".into(), nid.into())) {
                        n.value = v.clone();
                    }
                    let b = self.entity("books", text(&h.value, "bookId")?)?;
                    n.value["content"] = replace_block(
                        text(&n.value, "content")?,
                        &citation(&h.value, text(&b.value, "title")?),
                        "",
                    )
                    .trim()
                    .into();
                    changes.insert(("notes".into(), nid.into()), Some(n.value));
                }
            } else if kind == "notes" && h.value["noteId"] == id {
                if cascade_note {
                    changes.insert(("highlights".into(), hid.into()), None);
                    continue;
                }
                let mut v = h.value.clone();
                v.as_object_mut().unwrap().remove("noteId");
                v.as_object_mut().unwrap().remove("citation");
                changes.insert(("highlights".into(), hid.into()), Some(v));
            }
        }
        if kind == "books" {
            for target in ["associations", "translations", "mindMaps"] {
                for r in self.entities(target)? {
                    if r.value["bookId"] == id
                        || r.value["source"]["bookId"] == id
                        || r.value["target"]["bookId"] == id
                    {
                        changes.insert((target.into(), text(&r.value, "id")?.into()), None);
                    }
                }
            }
            for mut r in self.entities("studySets")? {
                if let Some(ids) = r.value["bookIds"].as_array_mut() {
                    let len = ids.len();
                    ids.retain(|v| v != id);
                    if len != ids.len() {
                        changes.insert(
                            ("studySets".into(), text(&r.value, "id")?.into()),
                            Some(r.value),
                        );
                    }
                }
            }
        }
        if kind == "folders" {
            let books = self.entities("books")?;
            let detach = crate::folder_deletion::books_to_detach(
                id,
                books.iter().map(|b| {
                    (
                        b.value["id"].as_str().unwrap_or_default(),
                        b.value["folderId"].as_str(),
                    )
                }),
            );
            let detach: BTreeSet<_> = detach.into_iter().collect();
            for mut b in books {
                if detach.contains(text(&b.value, "id")?) {
                    b.value.as_object_mut().unwrap().remove("folderId");
                    changes.insert(
                        ("books".into(), text(&b.value, "id")?.into()),
                        Some(b.value),
                    );
                }
            }
        }
        self.commit_values(&clock, changes)
    }

    pub fn link_citation(
        &mut self,
        highlight: &str,
        note: &str,
        highlight_revision: u64,
        note_revision: u64,
    ) -> Result<()> {
        let clock = self.repository.clock()?;
        let mut h = self.entity("highlights", highlight)?;
        let mut n = self.entity("notes", note)?;
        if h.revision != highlight_revision || n.revision != note_revision {
            return Err("revision_conflict".into());
        }
        let b = self.entity("books", text(&h.value, "bookId")?)?;
        let mut changes = BTreeMap::new();
        if let Some(old_id) = h.value["noteId"].as_str().filter(|i| *i != note) {
            let mut old = self.entity("notes", old_id)?;
            old.value["content"] = replace_block(
                text(&old.value, "content")?,
                &citation(&h.value, text(&b.value, "title")?),
                "",
            )
            .trim()
            .into();
            changes.insert(("notes".into(), old_id.into()), Some(old.value));
        }
        h.value["noteId"] = note.into();
        if h.value.get("citation").is_none() {
            h.value["citation"] = json!({"level":"content","chapterId":h.value["chapterId"]});
        }
        let block = citation(&h.value, text(&b.value, "title")?);
        let content = text(&n.value, "content")?;
        if !content.contains(&block) {
            n.value["content"] = format!(
                "{}{}{}",
                content,
                if content.is_empty() { "" } else { "\n\n" },
                block
            )
            .into();
        }
        changes.insert(("highlights".into(), highlight.into()), Some(h.value));
        changes.insert(("notes".into(), note.into()), Some(n.value));
        self.commit_values(&clock, changes)
    }

    pub fn set_review(&mut self, id: &str, enabled: bool, expected: u64) -> Result<Record> {
        let record = self.entity("highlights", id)?;
        if enabled {
            let now = self.runtime.now();
            let state = record.value.get("review").cloned().unwrap_or_else(
                || json!({"due":now,"reps":0,"lapses":0,"interval":0,"addedAt":now}),
            );
            self.save_entity("highlights", id, json!({"review":state}), vec![], expected)
        } else {
            self.save_entity("highlights", id, json!({}), vec!["review".into()], expected)
        }
    }

    pub fn review_queue(&self, study_set: Option<&str>) -> Result<Vec<Record>> {
        let books = study_set
            .map(|id| {
                self.entity("studySets", id)
                    .map(|r| r.value["bookIds"].clone())
            })
            .transpose()?;
        let now = self.runtime.now();
        let mut queue: Vec<_> = self
            .entities("highlights")?
            .into_iter()
            .filter(|r| {
                r.value["review"]["due"]
                    .as_u64()
                    .is_some_and(|due| due <= now)
                    && books.as_ref().is_none_or(|ids| {
                        ids.as_array()
                            .is_some_and(|ids| ids.contains(&r.value["bookId"]))
                    })
            })
            .collect();
        queue.sort_by_key(|r| {
            (
                r.value["review"]["due"].as_u64().unwrap_or(0),
                r.value["id"].as_str().unwrap_or("").to_owned(),
            )
        });
        Ok(queue)
    }

    pub fn review(&mut self, id: &str, rating: u8, expected: u64) -> Result<Record> {
        if !(1..=4).contains(&rating) {
            return Err("invalid_rating".into());
        }
        let h = self.entity("highlights", id)?;
        let now = self.runtime.now();
        let mut s = h
            .value
            .get("review")
            .cloned()
            .unwrap_or(json!({"due":now,"reps":0,"lapses":0,"interval":0,"addedAt":now}));
        let reps = s["reps"].as_u64().unwrap_or(0);
        let interval = s["interval"].as_f64().unwrap_or(0.0);
        let due = if rating == 1 {
            s["reps"] = 0.into();
            s["lapses"] = (s["lapses"].as_u64().unwrap_or(0) + 1).into();
            s["interval"] = 0.into();
            now + 300_000
        } else {
            s["reps"] = (reps + 1).into();
            if reps == 0 {
                match rating {
                    2 => now + 600_000,
                    3 => {
                        s["interval"] = 1.into();
                        now + 86_400_000
                    }
                    _ => {
                        s["interval"] = 2.into();
                        now + 172_800_000
                    }
                }
            } else {
                let days = (interval.max(1.0)
                    * match rating {
                        2 => 1.2,
                        3 => 2.2,
                        _ => 3.2,
                    })
                .round()
                .max(1.0) as u64;
                s["interval"] = days.into();
                now + days * 86_400_000
            }
        };
        s["due"] = due.into();
        s["lastRating"] = rating.into();
        s["lastReviewedAt"] = now.into();
        self.save_entity("highlights", id, json!({"review":s}), vec![], expected)
    }

    /// A session identifier and total active time make repeated heartbeats idempotent.
    pub fn checkpoint(
        &mut self,
        id: &str,
        session: &str,
        progress: Value,
        active_seconds: u64,
    ) -> Result<Record> {
        if session.is_empty() || session.len() > 128 || active_seconds > 86400 {
            return Err("invalid_reading_session".into());
        }
        for _ in 0..3 {
            let book = self.entity("books", id)?;
            let mut sessions = book.value["readingSessions"]
                .as_array()
                .cloned()
                .unwrap_or_default();
            let now = self.runtime.now();
            if let Some(existing) = sessions.iter_mut().find(|s| s["id"] == session) {
                let started = existing["startedAt"]
                    .as_u64()
                    .ok_or("invalid_reading_session")?;
                existing["endedAt"] = existing["endedAt"]
                    .as_u64()
                    .unwrap_or(started)
                    .max(started + active_seconds * 1000)
                    .into();
            } else {
                sessions.push(json!({"id":session,"bookId":id,"startedAt":now.saturating_sub(active_seconds*1000),"endedAt":now}));
            }
            match self.save_entity(
                "books",
                id,
                json!({"progress":progress,"readingSessions":sessions,"lastOpenedAt":now}),
                vec![],
                book.revision,
            ) {
                Err(e) if e == "revision_conflict" || e == "clock_conflict" => continue,
                result => return result,
            }
        }
        Err("revision_conflict".into())
    }

    pub fn search(&self, query: &str) -> Result<Vec<Value>> {
        let needle = query.trim().to_lowercase();
        if needle.is_empty() {
            return Ok(vec![]);
        }
        if needle.len() > 1024 {
            return Err("query_too_long".into());
        }
        let mut results = Vec::new();
        for kind in ["books", "notes", "highlights"] {
            for r in self.entities(kind)? {
                let mut searchable = String::new();
                for key in ["title", "author", "content", "text", "note"] {
                    if let Some(s) = r.value[key].as_str() {
                        searchable.push_str(s);
                        searchable.push('\n');
                    }
                }
                if kind == "books" {
                    if let Some(chapters) = r.value["chapters"].as_array() {
                        for c in chapters {
                            if let Some(paragraphs) = c["paragraphs"].as_array() {
                                for p in paragraphs {
                                    if let Some(s) = p.as_str() {
                                        searchable.push_str(s);
                                        searchable.push('\n');
                                    }
                                }
                            }
                        }
                    }
                }
                if searchable.to_lowercase().contains(&needle) {
                    results.push(json!({"kind":kind,"record":r}));
                }
                if results.len() >= 500 {
                    return Ok(results);
                }
            }
        }
        Ok(results)
    }

    fn validate(&self, kind: &str, v: &Value) -> Result<()> {
        let title = |key: &str| -> Result<()> {
            let s = text(v, key)?;
            if s.trim().is_empty() || s.chars().count() > 1000 {
                Err("invalid_title".into())
            } else {
                Ok(())
            }
        };
        match kind {
            "notes" => {
                title("title")?;
                if text(v, "content")?.len() > 4 * 1024 * 1024 {
                    return Err("content_too_large".into());
                }
            }
            "folders" => {
                title("name")?;
            }
            "books" => {
                title("title")?;
                text(v, "author")?;
                if ![
                    "pdf", "epub", "mobi", "azw3", "fb2", "txt", "builtin", "unknown",
                ]
                .contains(&text(v, "format")?)
                {
                    return Err("invalid_format".into());
                }
                let chapters = v["chapters"].as_array().ok_or("invalid_chapters")?;
                let mut ids = BTreeSet::new();
                for c in chapters {
                    let id = text(c, "id")?;
                    if !ids.insert(id) {
                        return Err("duplicate_chapter".into());
                    }
                    text(c, "title")?;
                    if !c["paragraphs"]
                        .as_array()
                        .is_some_and(|p| p.iter().all(Value::is_string))
                    {
                        return Err("invalid_paragraphs".into());
                    }
                }
                if v.get("outline").is_some() {
                    crate::outline::validate_book(v)?;
                }
                if let Some(f) = v.get("folderId") {
                    self.entity("folders", f.as_str().ok_or("invalid_folder")?)?;
                }
                if let Some(p) = v.get("progress") {
                    let ratio = p["ratio"].as_f64().ok_or("invalid_progress")?;
                    if !(0.0..=1.0).contains(&ratio)
                        || (!chapters.is_empty() && !ids.contains(text(p, "chapterId")?))
                    {
                        return Err("invalid_progress".into());
                    }
                }
            }
            "translations" => {
                let book = self.entity("books", text(v, "bookId")?)?;
                if v.get("chapterId").is_some()
                    && !book.value["chapters"]
                        .as_array()
                        .is_some_and(|c| c.iter().any(|c| c["id"] == v["chapterId"]))
                {
                    return Err("chapter_not_found".into());
                }
                if v.get("chapterId").is_none() && v.get("scope").is_none() {
                    return Err("chapter_not_found".into());
                }
                text(v, "text")?;
                text(v, "targetLang")?;
            }
            "highlights" => {
                self.validate_book_reference(v)?;
                text(v, "text")?;
                if let Some(n) = v.get("noteId") {
                    self.entity("notes", n.as_str().ok_or("invalid_note_id")?)?;
                }
            }
            "studySets" => {
                title("name")?;
                for b in v["bookIds"].as_array().ok_or("invalid_book_ids")? {
                    self.entity("books", b.as_str().ok_or("invalid_book_id")?)?;
                }
            }
            "associations" => {
                for key in ["source", "target"] {
                    let anchor = &v[key];
                    if !["text", "pdf"].contains(&anchor["kind"].as_str().unwrap_or(""))
                        || (anchor["kind"] == "text"
                            && ["paraIndex", "start", "end"]
                                .iter()
                                .any(|k| anchor.get(k).is_none()))
                        || (anchor["kind"] == "pdf" && anchor.get("pdfAnchor").is_none())
                    {
                        return Err("invalid_anchor".into());
                    }
                    self.validate_book_reference(&v[key])?;
                    text(&v[key], "text")?;
                }
                if !["bidirectional", "source-to-target"].contains(&text(v, "direction")?) {
                    return Err("invalid_direction".into());
                }
            }
            "mindMaps" => {
                title("title")?;
                validate_tree(&v["root"], 0, &mut BTreeSet::new())?;
                if let Some(b) = v.get("bookId") {
                    self.entity("books", b.as_str().ok_or("invalid_book_id")?)?;
                }
            }
            "preferences" => {}
            _ => return Err("invalid_kind".into()),
        }
        Ok(())
    }
    fn validate_book_reference(&self, v: &Value) -> Result<()> {
        let book = self.entity("books", text(v, "bookId")?)?;
        let level = v["citationLevel"].as_str().unwrap_or("content");
        if !["book", "chapter", "content"].contains(&level) {
            return Err("invalid_citation_level".into());
        }
        let has_anchor = ["paraIndex", "start", "end", "pdfAnchor"]
            .iter()
            .any(|k| v.get(k).is_some());
        if level == "book" {
            if has_anchor || v["chapterId"].as_str().is_some_and(|s| !s.is_empty()) {
                return Err("invalid_anchor".into());
            }
            return Ok(());
        }
        if level == "chapter" && has_anchor {
            return Err("invalid_anchor".into());
        }
        // Old content snapshots can be unlocated; exact anchors still validate.
        if level == "content"
            && !has_anchor
            && v["chapterId"].as_str().is_none_or(str::is_empty)
            && v.get("citationLevel").is_some()
        {
            return Ok(());
        }
        let chapter = text(v, "chapterId")?;
        let chapters = book.value["chapters"]
            .as_array()
            .ok_or("invalid_chapters")?;
        let chapter = chapters
            .iter()
            .find(|c| c["id"] == chapter)
            .ok_or("chapter_not_found")?;
        if v.get("paraIndex").is_some() || v.get("start").is_some() || v.get("end").is_some() {
            let index = v["paraIndex"].as_u64().ok_or("invalid_anchor")? as usize;
            let paragraph = chapter["paragraphs"]
                .get(index)
                .and_then(Value::as_str)
                .ok_or("invalid_anchor")?;
            let utf16: Vec<_> = paragraph.encode_utf16().collect();
            let start = v["start"].as_u64().ok_or("invalid_anchor")? as usize;
            let end = v["end"].as_u64().ok_or("invalid_anchor")? as usize;
            if start >= end
                || end > utf16.len()
                || String::from_utf16(&utf16[start..end]).ok().as_deref() != v["text"].as_str()
            {
                return Err("invalid_anchor".into());
            }
        }
        if let Some(anchor) = v.get("pdfAnchor") {
            let page = anchor["page"].as_u64().ok_or("invalid_pdf_anchor")?;
            if book.value["format"] != "pdf"
                || page == 0
                || page > chapters.len() as u64
                || chapters[(page - 1) as usize]["id"] != v["chapterId"]
            {
                return Err("invalid_pdf_anchor".into());
            }
            let rects = anchor["rects"].as_array().ok_or("invalid_pdf_anchor")?;
            if rects.is_empty() || rects.len() > 1000 {
                return Err("invalid_pdf_anchor".into());
            }
            for rect in rects {
                for key in ["x", "y", "width", "height"] {
                    if !rect[key].as_f64().is_some_and(|v| (0.0..=1.0).contains(&v)) {
                        return Err("invalid_pdf_anchor".into());
                    }
                }
                if rect["width"].as_f64().unwrap_or(0.0) <= 0.0
                    || rect["height"].as_f64().unwrap_or(0.0) <= 0.0
                    || rect["x"].as_f64().unwrap_or(0.0) + rect["width"].as_f64().unwrap_or(0.0)
                        > 1.000001
                    || rect["y"].as_f64().unwrap_or(0.0) + rect["height"].as_f64().unwrap_or(0.0)
                        > 1.000001
                {
                    return Err("invalid_pdf_anchor".into());
                }
            }
        }
        Ok(())
    }
}
fn valid_kind(kind: &str) -> Result<()> {
    if KINDS.contains(&kind) {
        Ok(())
    } else {
        Err("invalid_kind".into())
    }
}
fn text<'a>(v: &'a Value, key: &str) -> Result<&'a str> {
    v[key].as_str().ok_or_else(|| format!("invalid_{key}"))
}
fn validate_tree(v: &Value, depth: usize, ids: &mut BTreeSet<String>) -> Result<()> {
    if depth > 64 || ids.len() > 10_000 {
        return Err("mindmap_too_large".into());
    }
    if !ids.insert(text(v, "id")?.into()) {
        return Err("duplicate_node".into());
    }
    text(v, "text")?;
    for child in v["children"].as_array().ok_or("invalid_children")? {
        validate_tree(child, depth + 1, ids)?;
    }
    Ok(())
}
fn citation(h: &Value, book: &str) -> String {
    let id = h["id"]
        .as_str()
        .unwrap_or("")
        .bytes()
        .map(|b| {
            if b.is_ascii_alphanumeric() || b"_.~".contains(&b) {
                (b as char).to_string()
            } else {
                format!("%{b:02X}")
            }
        })
        .collect::<String>();
    let chapter = h["chapterTitle"].as_str().unwrap_or("");
    let body = match h["citation"]["level"].as_str().unwrap_or("content") {
        "book" => format!("> 书籍引用：[[{book}]]"),
        "chapter" => format!("> 章节引用：[[{book}]] → {chapter}"),
        _ => format!(
            "{}\n\n—— [[{book}]] → {chapter} → 具体内容",
            h["text"]
                .as_str()
                .unwrap_or("")
                .trim()
                .lines()
                .map(|s| format!("> {s}"))
                .collect::<Vec<_>>()
                .join("\n")
        ),
    };
    format!("<!-- shufang-citation-id:{id} -->\n{body}")
}
fn replace_block(content: &str, block: &str, replacement: &str) -> String {
    let mut output = String::new();
    let mut offset = 0;
    for (start, _) in content.match_indices(block) {
        let end = start + block.len();
        if (start == 0 || content.as_bytes()[start - 1] == b'\n')
            && (end == content.len()
                || content.as_bytes()[end] == b'\n'
                || content[end..].starts_with("\r\n"))
        {
            output.push_str(&content[offset..start]);
            output.push_str(replacement);
            offset = end;
        }
    }
    output.push_str(&content[offset..]);
    output
}
