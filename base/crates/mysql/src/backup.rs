//! Consistent data backup. Restore uses the separately migrated target schema;
//! arbitrary DDL supplied by a backup is never executed.
use super::*;
use base64::{engine::general_purpose::STANDARD, Engine};
use serde::{Deserialize, Serialize};
#[derive(Serialize, Deserialize)]
pub struct Dump {
    pub format: u32,
    pub database: String,
    pub tables: Vec<Table>,
}
#[derive(Serialize, Deserialize)]
pub struct Table {
    pub name: String,
    pub columns: Vec<String>,
    pub rows: Vec<Vec<Cell>>,
}
#[derive(Serialize, Deserialize)]
pub enum Cell {
    Null,
    Bytes(String),
    Int(i64),
    UInt(u64),
    Float(u32),
    Double(u64),
    Date(u16, u8, u8, u8, u8, u8, u32),
    Time(bool, u32, u8, u8, u8, u32),
}
fn quote(name: &str) -> Result<String> {
    if name.is_empty()
        || name.len() > 64
        || !name.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_')
    {
        return Err("invalid_backup_identifier".into());
    }
    Ok(format!("`{name}`"))
}
fn encode(value: mysql::Value) -> Cell {
    match value {
        mysql::Value::NULL => Cell::Null,
        mysql::Value::Bytes(v) => Cell::Bytes(STANDARD.encode(v)),
        mysql::Value::Int(v) => Cell::Int(v),
        mysql::Value::UInt(v) => Cell::UInt(v),
        mysql::Value::Float(v) => Cell::Float(v.to_bits()),
        mysql::Value::Double(v) => Cell::Double(v.to_bits()),
        mysql::Value::Date(a, b, c, d, e, f, g) => Cell::Date(a, b, c, d, e, f, g),
        mysql::Value::Time(a, b, c, d, e, f) => Cell::Time(a, b, c, d, e, f),
    }
}
fn decode(value: &Cell) -> Result<mysql::Value> {
    Ok(match value {
        Cell::Null => mysql::Value::NULL,
        Cell::Bytes(v) => {
            mysql::Value::Bytes(STANDARD.decode(v).map_err(|_| "invalid_backup_cell")?)
        }
        Cell::Int(v) => mysql::Value::Int(*v),
        Cell::UInt(v) => mysql::Value::UInt(*v),
        Cell::Float(v) => mysql::Value::Float(f32::from_bits(*v)),
        Cell::Double(v) => mysql::Value::Double(f64::from_bits(*v)),
        Cell::Date(a, b, c, d, e, f, g) => mysql::Value::Date(*a, *b, *c, *d, *e, *f, *g),
        Cell::Time(a, b, c, d, e, f) => mysql::Value::Time(*a, *b, *c, *d, *e, *f),
    })
}
impl MysqlRepository {
    pub fn dump(&self) -> Result<Dump> {
        let mut db = self.pool.get_conn().map_err(failure)?;
        let database: String = db
            .query_first("SELECT DATABASE()")
            .map_err(failure)?
            .ok_or("invalid_database")?;
        let mut tx = db
            .start_transaction(
                TxOpts::default()
                    .set_with_consistent_snapshot(true)
                    .set_isolation_level(Some(mysql::IsolationLevel::RepeatableRead)),
            )
            .map_err(failure)?;
        let names:Vec<String>=tx.query("SELECT table_name FROM information_schema.tables WHERE table_schema=DATABASE() AND table_type='BASE TABLE' ORDER BY table_name").map_err(failure)?;
        let mut tables = Vec::new();
        for name in names {
            let columns:Vec<String>=tx.exec("SELECT column_name FROM information_schema.columns WHERE table_schema=DATABASE() AND table_name=? ORDER BY ordinal_position",(&name,)).map_err(failure)?;
            let rows: Vec<mysql::Row> = tx
                .query(format!("SELECT * FROM {}", quote(&name)?))
                .map_err(failure)?;
            tables.push(Table {
                name,
                columns,
                rows: rows
                    .into_iter()
                    .map(|r| r.unwrap().into_iter().map(encode).collect())
                    .collect(),
            });
        }
        tx.commit().map_err(failure)?;
        Ok(Dump {
            format: 1,
            database,
            tables,
        })
    }
}
pub fn restore(url: &str, dump: &Dump) -> Result<String> {
    if dump.format != 1 || dump.tables.len() > 1000 {
        return Err("invalid_mysql_backup".into());
    }
    let opts = Opts::from_url(url).map_err(|_| "invalid_restore_database_url")?;
    let mut db = Conn::new(opts).map_err(failure)?;
    super::database_gate(&mut db)?;
    let database: String = db
        .query_first("SELECT DATABASE()")
        .map_err(failure)?
        .ok_or("invalid_database")?;
    if database == dump.database {
        return Err("restore_requires_distinct_database".into());
    }
    let names:Vec<String>=db.query("SELECT table_name FROM information_schema.tables WHERE table_schema=DATABASE() AND table_type='BASE TABLE'").map_err(failure)?;
    let expected: std::collections::BTreeSet<_> = names.iter().cloned().collect();
    let actual: std::collections::BTreeSet<_> =
        dump.tables.iter().map(|t| t.name.clone()).collect();
    if actual.len() != dump.tables.len() || actual != expected {
        return Err("restore_schema_mismatch".into());
    }
    for table in &dump.tables {
        let columns:Vec<String>=db.exec("SELECT column_name FROM information_schema.columns WHERE table_schema=DATABASE() AND table_name=? ORDER BY ordinal_position",(&table.name,)).map_err(failure)?;
        if columns != table.columns {
            return Err("restore_schema_mismatch".into());
        }
        let count: u64 = db
            .query_first(format!("SELECT COUNT(*) FROM {}", quote(&table.name)?))
            .map_err(failure)?
            .ok_or("invalid_database")?;
        if count != 0 && table.name != "__drizzle_migrations" {
            return Err("restore_database_not_empty".into());
        }
    }
    db.query_drop("SET FOREIGN_KEY_CHECKS=0").map_err(failure)?;
    let mut tx = db.start_transaction(TxOpts::default()).map_err(failure)?;
    for table in &dump.tables {
        if table.name == "__drizzle_migrations" {
            continue;
        }
        let fields = table
            .columns
            .iter()
            .map(|v| quote(v))
            .collect::<Result<Vec<_>>>()?
            .join(",");
        let sql = format!(
            "INSERT INTO {} ({fields}) VALUES ({})",
            quote(&table.name)?,
            vec!["?"; table.columns.len()].join(",")
        );
        for row in &table.rows {
            if row.len() != table.columns.len() {
                return Err("invalid_backup_row".into());
            }
            tx.exec_drop(
                &sql,
                mysql::Params::Positional(row.iter().map(decode).collect::<Result<Vec<_>>>()?),
            )
            .map_err(failure)?;
        }
    }
    // All publisher foreign keys must still hold; reenabling FK checks alone
    // does not validate rows inserted while they were disabled.
    let keys:Vec<(String,String,String,String,String,u64)>=tx.query("SELECT constraint_name,table_name,column_name,referenced_table_name,referenced_column_name,ordinal_position FROM information_schema.key_column_usage WHERE table_schema=DATABASE() AND referenced_table_name IS NOT NULL ORDER BY table_name,constraint_name,ordinal_position").map_err(failure)?;
    let mut groups: std::collections::BTreeMap<(String, String, String), Vec<(String, String)>> =
        std::collections::BTreeMap::new();
    for (name, table, column, parent, parent_column, _) in keys {
        groups
            .entry((name, table, parent))
            .or_default()
            .push((column, parent_column));
    }
    for ((_, table, parent), columns) in groups {
        let on = columns
            .iter()
            .map(|(c, p)| Ok(format!("c.{}=p.{}", quote(c)?, quote(p)?)))
            .collect::<Result<Vec<_>>>()?
            .join(" AND ");
        let valid = columns
            .iter()
            .map(|(c, _)| Ok(format!("c.{} IS NOT NULL", quote(c)?)))
            .collect::<Result<Vec<_>>>()?
            .join(" AND ");
        let sql = format!(
            "SELECT COUNT(*) FROM {} c LEFT JOIN {} p ON {on} WHERE {valid} AND p.{} IS NULL",
            quote(&table)?,
            quote(&parent)?,
            quote(&columns[0].1)?
        );
        let bad: u64 = tx
            .query_first(sql)
            .map_err(failure)?
            .ok_or("invalid_database")?;
        if bad != 0 {
            return Err("restore_foreign_key_mismatch".into());
        }
    }
    let epochs: Vec<String> = tx
        .query("SELECT workspace FROM sync_heads")
        .map_err(failure)?;
    for workspace in epochs {
        tx.exec_drop(
            "UPDATE sync_heads SET epoch=? WHERE workspace=?",
            (uuid::Uuid::new_v4().to_string(), workspace),
        )
        .map_err(failure)?;
    }
    tx.query_drop("DELETE FROM sync_cursors").map_err(failure)?;
    tx.query_drop("DELETE FROM rust_local_values WHERE local_key LIKE 'sync:receive:%' OR local_key LIKE 'sync:snapshot-at:%' OR local_key LIKE 'sync:incoming:%' OR local_key LIKE 'sync:incoming-page:%'").map_err(failure)?;
    tx.commit().map_err(failure)?;
    // Dedicated connection closes here; FK checks never leak into a pool.
    Ok(database)
}
