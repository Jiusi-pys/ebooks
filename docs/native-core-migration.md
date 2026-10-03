> 当前状态（2026-10-03）：见[工程状态与验收门槛](current-status.md)。本文件中的日期/版本记录保留其历史范围；当前迁移为 MySQL 0014 / SQLite 0003 / IndexedDB 11，生产尚未正式切换。

> Historical foundation design below. Native network replication is now implemented;
> actual HTTPS restore has passed on isolated Windows/Linux workspaces. Full Web
> migration and production cutover remain incomplete. See [current status](current-status.md).

# Shared core implementation and migration contract

Approved target: Rust domain/application, injected repositories, WASM for the
existing React application, C ABI for WinUI/C# and future native clients,
local-first data, optional standalone HTTP/MCP/OAuth/webhook host.

## Storage versions and supported starting points

- Existing MySQL chain: 0000 through 0014_workspace_sync; do not modify it.
- Existing browser database: shufang version 10; preserve all historical branches.
- New native SQLite chain: 0001, starting from an empty database (version 0).
- Existing browser/MySQL data is not implicitly adopted by the native adapter.
  A verified export/import or v2 replication path is required before using real data.
- SQLite is a separate adapter and never opens a MySQL or browser database file.

## SQLite 0001 execution and recovery

The new database stores workspace/replica identity, the local logical clock,
versioned entity states, durable outgoing operations, and migration receipts.
Initialize under a single SQLite IMMEDIATE transaction. Record migration 0001
only after all DDL and identity initialization succeeds; commit atomically.
Repeat opening skips the migration only when its version/checksum match. Refuse
unknown future versions, checksum drift, or workspace/replica identity mismatch.
An interrupted transaction must roll back on reopen. Never mark failures applied.

Each entity update, revision check, clock update, and outgoing operation insert
commits atomically. A duplicate operation ID or stale revision rolls back all of
them. No network requests occur inside this transaction. Use WAL with full
synchronous durability and a bounded busy timeout.

Before upgrading a populated native database, close all connections and copy the
database plus associated file store (or use SQLite's online backup API). Never
copy a live main database without its WAL state. Failed upgrades keep the old
version usable; restoring a backup requires stopping all readers/writers and
restoring the database and files together. Reverting an executable is not a
database rollback. Version 0001 has no upgrade from a published SQLite version.

## Archives and acceptance

New migration archives go under app/db/migration-history with immutable SQL,
the complete existing MySQL SQL/meta chain, source HEAD, and SHA-256 manifest.
Archives are source backups, not backups of user data. No production data is
used for migration tests. Test empty initialization, reopen, failure rollback,
unknown-version rejection, identity mismatch, checksum mismatch, and retention.
Cross-version upgrade acceptance must be extended when SQLite 0002 is added.

## Feature parity gates (all required for final delivery)

1. Framework-free core and native/WASM bindings, contract and architecture tests.
2. Local book import/storage, all current formats, original PDF and reflow reader.
3. Reading progress/history, selections, highlights, citation notes and cleanup.
4. Library/folders, metadata, global search, associations, graph and mind maps.
5. Study sets/reviews, bilingual reading, AI providers and local Codex adapter.
6. Existing Web/backend integration; mixed old/new workspace-v2 convergence.
7. WinUI native UI, account/settings, packaging, startup and update recovery.
8. Standalone REST, MCP stdio/HTTP, OAuth and webhook host with lifecycle tests.
9. Versioned export/import including blobs, tombstones and pending operations.
10. Android/iOS/Linux binding examples; platform runtime verification separately.

This document is an execution contract, not a claim that these gates passed.

## Confirmed compatibility gate

On 2026-10-03, a differential test found that the existing JavaScript operation
path preserves an unpaired UTF-16 surrogate while serde_json rejects it. The
production field-operation/snapshot adapter now keeps field values in call-local
host slots: Rust receives only references and version metadata, and returned
references resolve to unchanged host values. Tests cover unpaired surrogates,
special field names, colliding marker-like user objects, and a 17 MiB field.
Core clocks, operation application and snapshot merging are enabled through
this boundary. Direct native JSON commands still have a 16 MiB request limit.
Native projection does not yet reproduce localeCompare ordering for all legacy
reading-session IDs. The raw native JSON interface must not be used to migrate
a real legacy library before its lossless text/large-payload gates are closed.
Flattening, projection, schema validation and canonical hashing remain in the
production TypeScript compatibility layer; complete feature parity is pending.

## Verification record — 2026-10-03

Implemented and verified for the current foundation:

- `npm run check`, `npm run lint`, and `npm run build` pass. The existing
  bundle-size, dynamic-import and browser externalization warnings remain.
- Full Vitest run: 117 files, 581 tests passed, including the opt-in MySQL
  integration and migration fixtures on an isolated disposable MySQL 8.4 instance.
- Rust workspace: 12 tests passed on Windows and in a Linux container;
  `cargo clippy --workspace --all-targets --locked -- -D warnings` passes on Windows.
- C# smoke test passes through the real native DLL and SQLite: Unicode,
  persistence after restart, stale-revision rejection, durable outbox, and
  preservation of the editor draft after failed validation.
- WinUI x64 Debug build passes with zero warnings/errors. Interactive window
  acceptance, release installer and update recovery have not been verified.
- Deployment supervisor: 11 Python tests pass.
- Final runtime source builds in Docker. The image starts against the isolated
  test database, serves the homepage, and rejects an unauthenticated library
  request. All 32 packaged MySQL migration files and the independent archive
  match their SHA-256 manifest; all 33 migration source files match locally.

The implemented native dependency path is View -> ViewModel -> C# marshal bridge
-> Rust use case -> Repository port -> SQLite adapter. Binding commands do not
read the repository directly. The existing backend no longer imports business
types or citation helpers from the React source tree.

This is a foundation and an offline-note slice. Native network replication,
blob/file synchronization, real-library migration, the remaining use cases,
the full Windows UI, direct AI providers and standalone service mode are not
implemented. Android/iOS bindings are source examples without platform build or
device validation; Linux core tests do not constitute Linux UI acceptance.
Existing React hooks still contain business orchestration that must be moved
before the entire application can meet the final dependency boundary.
