> 当前状态（2026-10-03）：见[工程状态与验收门槛](current-status.md)。本文件中的日期/版本记录保留其历史范围；当前迁移为 MySQL 0014 / SQLite 0003 / IndexedDB 11，生产尚未正式切换。

# Final Windows acceptance plan

Approved execution: complete the remaining Windows acceptance tasks. Native
cross-device replication and further Web business migration remain deferred.
Use isolated workspaces and synthetic documents only; preserve existing releases.

1. TDD: reproduce rapid native edits/deletion before webhook polling. Preserve
   each committed payload atomically, including deletion's prior value and
   related book/folder context; queue stable retries from that snapshot.
2. Inventory old REST routes and source schemas. Add valid/default/null/invalid
   fixtures across resources, events, uploads and AI. Compare actual wire shape
   and status. Repair failures through the compatibility adapter, not the view.
3. Exercise renderer/outline reopen, metadata preservation/error, external OAuth
   client flow, signed update success/failure and uninstall/data retention.
4. Execute full Rust/C#/Web/deployment checks and migration/archive hashes, build
   a fresh release, then rerun installed process and PowerShell 5.1 acceptance.
5. Clean Windows, real reboot/login, paid providers and production signing need
   supplied environments/configuration. Never infer these passes from mocks,
   development-host runs, self-signed test keys or startup registry inspection.

## Additive journal snapshot v1 design before implementation

Starting point: SQLite 0002 and legacy change-log rows. Keep SQL and historical
archives immutable. Store `journal:<sequence>` JSON in existing private local
values in the same IMMEDIATE transaction as entity/outbox/change-log writes.
Format version 1 contains committed Record (prior Record for a delete) and only
related book/folder Records. Change DTO gains an optional snapshot. Old rows
have no snapshot and use explicitly legacy fallback; no fictitious backfill.
Older 0002 binaries retain these values but do not consume them. Older concurrent
writers are unsupported: stop all writers before upgrading. No network protocol
or IndexedDB changes. These records follow journal retention and are included in
workspace backups; don't expire undelivered history or silently rewrite receipts.
Failure rolls back both snapshot and business writes. Restore a complete backup
into a fresh workspace with writers closed; executable rollback is not SQL rollback.
Tests: empty/new history, sequential edits then delete, reopen, revision failure
with no orphan snapshot, receipt atomicity and old rows without snapshot.

## Review

The plan keeps domain/application independent of WinUI/React. Snapshot capture
belongs to the repository transaction; REST projection and webhook transport stay
in the service adapter. No schema changes, production data writes or existing
archive modifications are required. External-environment gates remain pending
until actual evidence is available.
