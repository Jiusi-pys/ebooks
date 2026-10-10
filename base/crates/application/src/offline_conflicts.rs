//! Local optimistic edits and decisions. The immutable operation log is never rewritten.
use crate::{
    Commit, CoreSession, LocalCommit, LogOperation, ReplicationRepository, Repository, Result,
    Runtime,
};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use shufang_domain::sync::{
    apply_operation, compare_clock, flatten_fields, next_clock, EntityState, Operation,
};
use std::collections::BTreeSet;

fn edit_key(kind: &str, id: &str) -> String {
    format!(
        "sync:edit:{:x}",
        Sha256::digest(format!("{kind}:{id}").as_bytes())
    )
}
fn fingerprint(value: &Value) -> String {
    format!("{:x}", Sha256::digest(value.to_string().as_bytes()))
}
fn state(value: &Value) -> Result<Option<EntityState>> {
    serde_json::from_value(value.clone()).map_err(|_| "invalid_sync_edit".into())
}
fn value(s: Option<&EntityState>, key: &str) -> Option<Value> {
    s.and_then(|s| s.fields.get(key))
        .filter(|f| !f.removed)
        .and_then(|f| f.value.clone())
}

impl<R: Repository, T: Runtime> CoreSession<R, T> {
    pub fn enable_sync_conflicts(&mut self) -> Result<()> {
        let (revision, current) = self
            .repository
            .get_local("sync:conflicts-enabled")?
            .unwrap_or((0, Value::Null));
        if current != true {
            self.repository
                .set_local("sync:conflicts-enabled", revision, &json!(true))?;
        }
        Ok(())
    }
    pub fn sync_conflicts_enabled(&self) -> Result<bool> {
        Ok(self
            .repository
            .get_local("sync:conflicts-enabled")?
            .is_some_and(|(_, v)| v == true))
    }
    pub fn local_replica_id(&self) -> &str {
        &self.replica
    }
    pub fn materialize_sync_conflict(&self, state: &EntityState) -> Result<Option<Value>> {
        self.materialize_state(state)
    }
    pub fn sync_edit(&self, kind: &str, id: &str) -> Result<Option<Value>> {
        Ok(self
            .repository
            .get_local(&edit_key(kind, id))?
            .map(|(_, v)| v)
            .filter(Value::is_object))
    }
    pub(crate) fn capture_sync_edit(
        &self,
        base: Option<&EntityState>,
        op: &Operation,
    ) -> Result<Option<LocalCommit>> {
        if !self.sync_conflicts_enabled()? || op.kind == "reviews" {
            return Ok(None);
        }
        let key = edit_key(&op.kind, &op.entity_id);
        let (expected, mut entry) = self.repository.get_local(&key)?.unwrap_or((0, Value::Null));
        if !entry.is_object() {
            entry = json!({"version":1,"base":base,"operations":[]});
        }
        let ids = entry["operations"]
            .as_array_mut()
            .ok_or("invalid_sync_edit")?;
        if ids.len() >= 10000 {
            return Err("sync_edit_queue_too_large".into());
        }
        ids.push(json!(op.operation_id));
        Ok(Some(LocalCommit {
            key,
            expected,
            value: entry,
        }))
    }
    pub fn sync_conflicts(&self) -> Result<Vec<Value>> {
        Ok(self
            .repository
            .get_local("sync:conflicts")?
            .map(|(_, v)| {
                v.as_object()
                    .map(|m| m.values().cloned().collect())
                    .ok_or("invalid_sync_conflicts")
            })
            .transpose()?
            .unwrap_or_default())
    }
    pub fn operation_withdrawn(&self, id: &str) -> Result<bool> {
        Ok(self
            .repository
            .get_local(&format!("sync:withdrawn:{id}"))?
            .is_some())
    }
    pub fn replication_entity_state(&self, kind: &str, id: &str) -> Result<Option<EntityState>> {
        Ok(self.repository.load(kind, id)?.map(|r| r.state))
    }
    pub fn inspect_sync_conflict(
        &mut self,
        peer: &str,
        op: &Operation,
        remote: Option<&EntityState>,
    ) -> Result<Option<Value>> {
        if op.replica_id != self.replica
            || op.kind == "reviews"
            || self.operation_withdrawn(&op.operation_id)?
        {
            return Ok(None);
        }
        let local = self
            .repository
            .load(&op.kind, &op.entity_id)?
            .ok_or("sync_local_entity_missing")?;
        let edit = self.sync_edit(&op.kind, &op.entity_id)?;
        let base = edit
            .as_ref()
            .map(|e| state(&e["base"]))
            .transpose()?
            .flatten();
        let keys: BTreeSet<_> = local
            .state
            .fields
            .keys()
            .chain(base.iter().flat_map(|s| s.fields.keys()))
            .filter(|k| !matches!(k.as_str(), "updatedAt" | "createdAt" | "#deleted"))
            .cloned()
            .collect();
        let local_deleted = local.state.deleted;
        let remote_deleted = remote.is_some_and(|r| r.deleted);
        let base_deleted = base.as_ref().is_some_and(|r| r.deleted);
        let changed = if edit.is_none() {
            remote.is_some()
        } else if local_deleted {
            remote_deleted != base_deleted
                || keys
                    .iter()
                    .any(|k| value(remote, k) != value(base.as_ref(), k))
        } else {
            remote_deleted != base_deleted
                || keys.iter().any(|k| {
                    value(Some(&local.state), k) != value(base.as_ref(), k)
                        && value(remote, k) != value(base.as_ref(), k)
                        && value(remote, k) != value(Some(&local.state), k)
                })
        };
        if !changed {
            if let Some((revision, mut index)) = self.repository.get_local("sync:conflicts")? {
                let key = edit_key(&op.kind, &op.entity_id);
                let entries = index.as_object_mut().ok_or("invalid_sync_conflicts")?;
                if entries.get(&key).is_some_and(|r| r["peer"] == peer) {
                    entries.remove(&key);
                    self.repository
                        .set_local("sync:conflicts", revision, &index)?;
                }
            }
            return Ok(None);
        }
        let (revision, index) = self
            .repository
            .get_local("sync:conflicts")?
            .unwrap_or((0, json!({})));
        let mut index = index.as_object().cloned().ok_or("invalid_sync_conflicts")?;
        let key = edit_key(&op.kind, &op.entity_id);
        let mut conflict = json!({"id":key,"peer":peer,"kind":op.kind,"entityId":op.entity_id,"localState":local.state,"remoteState":remote,"localRevision":local.revision,"legacy":edit.is_none(),"operations":edit.as_ref().map(|e|e["operations"].clone()).unwrap_or(json!([op.operation_id]))});
        conflict["fingerprint"] = fingerprint(&conflict).into();
        if index.get(&key) != Some(&conflict) {
            index.insert(key, conflict.clone());
            self.repository
                .set_local("sync:conflicts", revision, &Value::Object(index))?;
        }
        Ok(Some(conflict))
    }
    /// Validate the preview and atomically replace the local projection, append new
    /// resolution operations, and explicitly withdraw the rejected outbox entries.
    pub fn resolve_sync_conflict(
        &mut self,
        id: &str,
        expected: &str,
        choice: &str,
    ) -> Result<Value> {
        if !["local", "remote", "copy"].contains(&choice) {
            return Err("invalid_conflict_choice".into());
        }
        let (revision, index) = self
            .repository
            .get_local("sync:conflicts")?
            .ok_or("sync_conflict_not_found")?;
        let mut index = index.as_object().cloned().ok_or("invalid_sync_conflicts")?;
        let conflict = index.get(id).cloned().ok_or("sync_conflict_not_found")?;
        let kind = conflict["kind"].as_str().ok_or("invalid_sync_conflict")?;
        let entity_id = conflict["entityId"]
            .as_str()
            .ok_or("invalid_sync_conflict")?;
        let prior = self
            .repository
            .load(kind, entity_id)?
            .ok_or("sync_conflict_preview_changed")?;
        if conflict["fingerprint"] != expected || conflict["localRevision"] != prior.revision {
            return Err("sync_conflict_preview_changed".into());
        }
        let local = state(&conflict["localState"])?.ok_or("invalid_sync_conflict")?;
        let remote = state(&conflict["remoteState"])?;
        if local != prior.state {
            return Err("sync_conflict_preview_changed".into());
        }
        let copy = choice == "copy"
            || (choice == "local" && remote.as_ref().is_some_and(|r| r.deleted) && !local.deleted);
        if copy && local.deleted {
            return Err("sync_conflict_deleted_copy".into());
        }
        if copy
            && ![
                "books",
                "folders",
                "notes",
                "highlights",
                "translations",
                "mindMaps",
                "studySets",
            ]
            .contains(&kind)
        {
            return Err("sync_conflict_copy_requires_dependencies".into());
        }
        let clock = self.repository.clock()?;
        let mut next = clock.clone();
        for field in remote.iter().flat_map(|s| s.fields.values()) {
            let p = field.version.split(':').take(2).collect::<Vec<_>>();
            if p.len() != 2 {
                return Err("invalid_remote_field_version".into());
            }
            let c = format!(
                "{}:{}",
                p[0].parse::<u64>()
                    .map_err(|_| "invalid_remote_field_version")?,
                p[1].parse::<u64>()
                    .map_err(|_| "invalid_remote_field_version")?
            );
            shufang_domain::sync::validate_received_clock(&c, self.runtime.now())?;
            if compare_clock(&next, &c)?.is_lt() {
                next = c;
            }
        }
        let chosen = if choice == "remote" || copy {
            remote.as_ref()
        } else {
            Some(&local)
        };
        let chosen_payload = chosen
            .map(|s| self.materialize_state(s))
            .transpose()?
            .flatten();
        let mut targets = vec![(
            kind.to_owned(),
            entity_id.to_owned(),
            chosen_payload,
            remote.clone(),
            prior.revision,
        )];
        let copy_id = if copy {
            Some(self.runtime.new_id())
        } else {
            None
        };
        if let Some(id) = &copy_id {
            let copies = if ["books", "folders"].contains(&kind) {
                self.conflict_container_copies(kind, entity_id, id)?
            } else {
                vec![(
                    kind.to_owned(),
                    id.clone(),
                    self.materialize_state(&local)?.ok_or("invalid_sync_copy")?,
                )]
            };
            if copies.len() >= 10000 {
                return Err("sync_conflict_dependency_limit".into());
            }
            targets.extend(
                copies
                    .into_iter()
                    .map(|(kind, id, value)| (kind, id, Some(value), None, 0)),
            );
        }
        let mut commits = vec![];
        let mut locals = vec![];
        for (kind, target, payload, server, expected_revision) in targets {
            let mut fields = payload
                .as_ref()
                .and_then(Value::as_object)
                .cloned()
                .unwrap_or_default();
            fields.remove("id");
            if payload.is_some() {
                fields.insert("updatedAt".into(), self.runtime.now().into());
            }
            let patch = self.prepare_patch(flatten_fields(&kind, &fields)?)?;
            let unset = server
                .iter()
                .flat_map(|s| s.fields.keys())
                .filter(|k| !patch.contains_key(*k))
                .cloned()
                .collect();
            next = next_clock(&next, self.runtime.now())?;
            let op = Operation {
                workspace_id: self.workspace.clone(),
                replica_id: self.replica.clone(),
                operation_id: self.runtime.new_id(),
                kind: kind.clone(),
                entity_id: target.clone(),
                clock: next.clone(),
                patch,
                unset,
                deleted: payload.is_none(),
            };
            shufang_domain::sync_validation::validate_patch(&op)?;
            let state = apply_operation(server.as_ref(), &op)?;
            let key = edit_key(&kind, &target);
            let edit_revision = self.repository.get_local(&key)?.map_or(0, |(r, _)| r);
            locals.push(LocalCommit {
                key,
                expected: edit_revision,
                value: json!({"version":1,"base":server,"operations":[op.operation_id]}),
            });
            commits.push(Commit {
                expected: expected_revision,
                state,
                operation: op,
            });
        }
        for op_id in conflict["operations"]
            .as_array()
            .ok_or("invalid_sync_conflict")?
        {
            let op_id = op_id.as_str().ok_or("invalid_sync_conflict")?;
            let key = format!("sync:withdrawn:{op_id}");
            let expected = self.repository.get_local(&key)?.map_or(0, |(r, _)| r);
            locals.push(LocalCommit{key,expected,value:json!({"version":1,"reason":"explicit-conflict-resolution","choice":choice,"fingerprint":conflict["fingerprint"]})});
        }
        index.remove(id);
        locals.push(LocalCommit {
            key: "sync:conflicts".into(),
            expected: revision,
            value: Value::Object(index),
        });
        self.repository
            .commit_sync_resolution(&clock, &commits, &locals, id, expected)?;
        Ok(json!({"copyId":copy_id,"completed":true}))
    }
}

impl<R: Repository + ReplicationRepository, T: Runtime> CoreSession<R, T> {
    pub fn has_unsent_local_edits(&self, key: &str) -> Result<bool> {
        let mut after = self
            .sync_checkpoint(key)?
            .1
            .as_str()
            .unwrap_or("0")
            .parse()
            .map_err(|_| "invalid_sync_checkpoint")?;
        loop {
            let rows = self.replication_operations(after, 100)?;
            for row in &rows {
                if row.operation.replica_id == self.replica
                    && !self.operation_withdrawn(&row.operation.operation_id)?
                {
                    return Ok(true);
                }
            }
            if rows.len() < 100 {
                return Ok(false);
            }
            after = rows.last().ok_or("sync_queue_stalled")?.sequence;
        }
    }
    pub fn recognize_received_sync_edit(&mut self, op: &Operation) -> Result<()> {
        let key = edit_key(&op.kind, &op.entity_id);
        if let Some((revision, mut entry)) = self
            .repository
            .get_local(&key)?
            .filter(|(_, v)| v.is_object())
        {
            let ids = entry["operations"]
                .as_array_mut()
                .ok_or("invalid_sync_edit")?;
            if ids.iter().any(|id| id == &op.operation_id) {
                ids.retain(|id| id != &op.operation_id);
                if ids.is_empty() {
                    entry = Value::Null;
                } else {
                    let base = state(&entry["base"])?;
                    entry["base"] = serde_json::to_value(apply_operation(base.as_ref(), op)?)
                        .map_err(|_| "invalid_sync_edit")?;
                }
                self.repository.set_local(&key, revision, &entry)?;
            }
        }
        Ok(())
    }
    pub fn check_sync_precondition(
        &self,
        op: &Operation,
        expected: Option<&EntityState>,
    ) -> Result<bool> {
        if let Some(prior) = self.repository.operation(&op.operation_id)? {
            if !shufang_domain::sync::equivalent_operation(&prior, op) {
                return Err("operation_id_reused".into());
            }
            return Ok(true);
        }
        if self
            .replication_entity_state(&op.kind, &op.entity_id)?
            .as_ref()
            != expected
        {
            return Err("sync_precondition_failed".into());
        }
        Ok(false)
    }
    pub fn acknowledge_guarded_sync(
        &mut self,
        key: &str,
        expected: u64,
        row: &LogOperation,
        receipts: &Value,
    ) -> Result<()> {
        crate::sync_receipts::validate_sync_receipts(
            std::slice::from_ref(&row.operation.operation_id),
            receipts,
        )?;
        let mut locals = vec![LocalCommit {
            key: key.into(),
            expected,
            value: json!(row.sequence.to_string()),
        }];
        let edit_key = edit_key(&row.operation.kind, &row.operation.entity_id);
        if let Some((revision, mut entry)) = self
            .repository
            .get_local(&edit_key)?
            .filter(|(_, v)| v.is_object())
        {
            let ids = entry["operations"]
                .as_array_mut()
                .ok_or("invalid_sync_edit")?;
            if ids.iter().any(|id| id == &row.operation.operation_id) {
                ids.retain(|id| id != &row.operation.operation_id);
                if ids.is_empty() {
                    entry = Value::Null;
                } else {
                    let base = state(&entry["base"])?;
                    entry["base"] =
                        serde_json::to_value(apply_operation(base.as_ref(), &row.operation)?)
                            .map_err(|_| "invalid_sync_edit")?;
                }
                locals.push(LocalCommit {
                    key: edit_key,
                    expected: revision,
                    value: entry,
                });
            }
        }
        self.repository
            .commit_batch_local(&self.repository.clock()?, &[], &locals)
    }
    pub fn advance_withdrawn_sync(
        &mut self,
        key: &str,
        expected: u64,
        row: &LogOperation,
    ) -> Result<()> {
        if !self.operation_withdrawn(&row.operation.operation_id)? {
            return Err("sync_operation_not_withdrawn".into());
        }
        self.repository
            .set_local(key, expected, &json!(row.sequence.to_string()))?;
        Ok(())
    }
}
