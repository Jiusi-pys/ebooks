//! Append-only runner for the existing Drizzle MySQL ledger.
use mysql::{prelude::Queryable, Conn};
use serde::Deserialize;
use sha2::{Digest, Sha256};
use std::{collections::BTreeMap, path::Path};
type Result<T> = std::result::Result<T, String>;
#[derive(Clone)]
pub struct Migration {
    pub tag: String,
    pub when: u64,
    pub hash: String,
    pub statements: Vec<String>,
}
#[derive(Deserialize)]
struct Entry {
    idx: usize,
    when: u64,
    tag: String,
}
#[derive(Deserialize)]
struct Journal {
    dialect: String,
    entries: Vec<Entry>,
}
pub fn read_chain(root: &Path) -> Result<Vec<Migration>> {
    let journal: Journal = serde_json::from_slice(
        &std::fs::read(root.join("meta/_journal.json")).map_err(|_| "migration_journal_missing")?,
    )
    .map_err(|_| "invalid_migration_journal")?;
    if journal.dialect != "mysql" {
        return Err("invalid_migration_dialect".into());
    }
    let mut last = 0;
    let mut chain = Vec::new();
    for (index, entry) in journal.entries.into_iter().enumerate() {
        if entry.idx != index
            || entry.when <= last
            || !entry.tag.starts_with(&format!("{index:04}_"))
            || !entry
                .tag
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b == b'_')
        {
            return Err("invalid_migration_order".into());
        }
        last = entry.when;
        let bytes = std::fs::read(root.join(format!("{}.sql", entry.tag)))
            .map_err(|_| "migration_source_missing")?;
        if bytes.contains(&b'\r') {
            return Err(format!("migration_line_endings_mismatch:{}", entry.tag));
        }
        let text = String::from_utf8(bytes.clone()).map_err(|_| "invalid_migration_encoding")?;
        let statements = text
            .split("--> statement-breakpoint")
            .filter(|v| !v.trim().is_empty())
            .map(str::to_owned)
            .collect();
        chain.push(Migration {
            tag: entry.tag,
            when: entry.when,
            hash: format!("{:x}", Sha256::digest(&bytes)),
            statements,
        });
    }
    Ok(chain)
}
// Verified production history: 0014 was executed with CRLF before LF packaging.
// See the immutable 20261005-production-mysql0014-line-endings archive.
// This narrowly recognizes those exact bytes without rewriting the ledger.
fn recorded_hash_matches(m: &Migration, hash: &str) -> bool {
    m.hash == hash
        || (m.tag == "0014_workspace_sync"
            && m.when == 1790469000000
            && m.hash == "6aa0d710b0e63a5eaac84f106ecff5a764cf8b1e553b9644d38f3e26a7c100b7"
            && hash == "0d33a43b95cc793c398193ac609bb0db2c88118a27db925c2be820884f6438d1")
}
pub fn apply(db: &mut Conn, chain: &[Migration]) -> Result<usize> {
    super::database_gate(db)?;
    let result = (|| {
        db.query_drop("CREATE TABLE IF NOT EXISTS __drizzle_migrations(id SERIAL PRIMARY KEY,hash TEXT NOT NULL,created_at BIGINT)").map_err(super::failure)?;
        let rows: Vec<(String, u64)> = db
            .query("SELECT hash,created_at FROM __drizzle_migrations ORDER BY created_at")
            .map_err(super::failure)?;
        let mut recorded = BTreeMap::new();
        for (hash, when) in rows {
            if recorded.insert(when, hash).is_some() {
                return Err("duplicate_migration_ledger_entry".into());
            }
        }
        for (&when, hash) in &recorded {
            let m = chain
                .iter()
                .find(|m| m.when == when)
                .ok_or("database_migration_ahead_or_unknown")?;
            if !recorded_hash_matches(m, hash) {
                return Err(format!("migration_hash_mismatch:{}", m.tag));
            }
        }
        let mut missing = false;
        for m in chain {
            if !recorded.contains_key(&m.when) {
                missing = true;
            } else if missing {
                return Err("migration_ledger_gap".into());
            }
        }
        let mut applied = 0;
        for m in chain.iter().filter(|m| !recorded.contains_key(&m.when)) {
            // MySQL DDL auto-commits. Never record completion before every statement succeeds.
            for (index, sql) in m.statements.iter().enumerate() {
                db.query_drop(sql).map_err(|_|format!("migration_statement_failed:{}:{}; partial DDL may remain; use documented forward repair or isolated restore",m.tag,index+1))?;
            }
            db.exec_drop(
                "INSERT INTO __drizzle_migrations(hash,created_at) VALUES(?,?)",
                (&m.hash, m.when),
            )
            .map_err(super::failure)?;
            applied += 1;
        }
        Ok(applied)
    })();
    // Release just this named lock, leaving any writer lease untouched.
    let database: Option<String> = db
        .query_first("SELECT DATABASE()")
        .map_err(super::failure)?;
    if let Some(database) = database {
        let lock = format!("shufang-restore-{:x}", Sha256::digest(database.as_bytes()));
        let _ = db.exec_drop("DO RELEASE_LOCK(?)", (&lock[..64],));
    }
    result
}
pub fn migrate(url: &str, root: &Path) -> Result<usize> {
    let chain = read_chain(root)?;
    let mut db = Conn::new(mysql::Opts::from_url(url).map_err(|_| "invalid_database_url")?)
        .map_err(super::failure)?;
    apply(&mut db, &chain)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn recognizes_only_the_verified_historical_bytes_and_keeps_source_validation() {
        let mut m = Migration {
            tag: "0014_workspace_sync".into(),
            when: 1790469000000,
            hash: "6aa0d710b0e63a5eaac84f106ecff5a764cf8b1e553b9644d38f3e26a7c100b7".into(),
            statements: vec![],
        };
        let old = "0d33a43b95cc793c398193ac609bb0db2c88118a27db925c2be820884f6438d1";
        assert!(recorded_hash_matches(&m, old));
        assert!(!recorded_hash_matches(&m, &"0".repeat(64)));
        m.hash = "changed-source".into();
        assert!(!recorded_hash_matches(&m, old));
        m.hash = old.into();
        m.tag = "0013_other".into();
        assert!(!recorded_hash_matches(
            &m,
            "6aa0d710b0e63a5eaac84f106ecff5a764cf8b1e553b9644d38f3e26a7c100b7"
        ));
    }
}
