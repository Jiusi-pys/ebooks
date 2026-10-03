> 当前状态（2026-10-03）：见[工程状态与验收门槛](current-status.md)。本文件中的日期/版本记录保留其历史范围；当前迁移为 MySQL 0014 / SQLite 0003 / IndexedDB 11，生产尚未正式切换。

# Windows completion plan (2026-10-03)

Baseline: the immutable 0.2.2 development ZIP and its acceptance ledger. Scope
is Windows, shared core, AI and independent service interaction. Native network
synchronization and further Web business migration remain deferred.

## Execution gates

1. EPUB: test local image and fragment links, cross-chapter footnotes, malformed
   paths, scripts and remote resources before implementation. Derive a bounded
   rendition from the immutable original; retain existing text and UTF-16
   paragraph anchors. Render structured data with DOM APIs, never imported HTML.
2. Outline: test immutable chapter entries, nested subtree movement, promotion
   after deletion, depth limits, invalid targets, revision conflicts and reopen.
   Business operations belong in application; Windows only sends commands.
3. Metadata: explicit lookup, selectable suggestions and revision-checked apply.
   Keep manual edits and covers unless the user selects replacement. Provider
   failures must leave records unchanged. Test HTTP failure and normalization.
4. Updates: versioned signed manifest, pinned verification key, size/hash checks,
   isolated staging and fresh version directories. Test invalid signatures,
   traversal, interrupted download, downgrade and launch failure. Back up data
   before migration; program rollback is not database rollback. Never silently
   trust an unsigned feed or overwrite a running installation.
5. REST: inventory every old v1 route and add contract fixtures for statuses,
   field mappings, null/unset, list filters, upserts and tombstones. Keep the
   adapter outside domain. Core invariants and transactions apply to every
   transport. Includes digest, due review, ask/translate, event/upload and webhook
   mutation/test contracts, not merely generic CRUD endpoints.
6. Acceptance: strict Rust/C#/Web checks, meaningful tests, installed Windows UI
   interaction, real AI using synthetic text, and clean Windows installation,
   import/read/cite/reopen/service/update/uninstall. Separate each evidence level.

## Data and compatibility design

SQLite migration 0002 remains the supported starting point; 0001 upgrades through
the complete immutable 0001->0002 chain. No historical SQL or archive is changed.
Rendition data is derived and not a persistent schema upgrade. Outline format v1
is an optional book field using the existing Web outline shape (id/title/depth/
chapterId/paraIndex/start/end). Missing outline materializes chapter defaults;
old paragraphs, identifiers and citations are not renumbered. Existing 0.2.2
readers ignore this additive field. Existing generic fields/outbox preserve it.
Any further persistent format change must add its own upgrade/recovery design
before code changes. Native network propagation remains disabled.

REST compatibility payloads also add optional `citationLevel` (missing means
existing content citations), `legacyFolder` and legacy translation `scope` /
`chapterTitle`. Unknown book format is accepted for registered text-only mirrors.
These fields use the existing revisioned JSON storage and need no SQL change;
old generic readers preserve them. Native network synchronization is deferred,
so older nodes do not receive newly accepted payloads automatically. REST wire
projection never exposes local original paths. Existing native CRUD remains
available under `/api/native/v1`; `/api/v1` adopts old Web response shapes.

Back up the online database and original files with the existing verified backup
command before installing. On failure, preserve originals and the failed version
directory; restore into a fresh workspace and validate before selecting it.
Never test migrations against the user's production workspace.

## Environment constraints observed

### Additive local formats and recovery

SQLite 0002 `local_values` stores version-1 delivery receipts (fingerprint),
chunk upload manifests/chunks/completion markers and digest caches. These are
node-local transport caches, never native synchronization records. Entity writes,
receipts and cache invalidation use one SQLite immediate transaction; a failed
commit records none of them. Book edits/deletion invalidate the previous hash's
digest in that same transaction. Old cache entries without `invalidated` remain
readable until their book changes. Receipt replays with a different fingerprint
are rejected. Uploads expire after 24 hours; expiry rejects further chunks.
New receipts and upload completion markers carry `expires` (7-day retention).
Before accepting an event the repository removes at most 1,000 expired local
transport rows; it never deletes entities, outbox, originals, jobs or credentials.
Historical local entries without expiry are retained. Transport quotas bound
receipt counts and upload slots/serialized bytes; quota failure leaves the
business transaction untouched. This is additive local-cache version 1 behavior,
not a SQLite schema or historical migration change.

Association updates add `pairKeyVersion: 2`, with the old Web percent-encoded
anchor identity. Existing rows are not rewritten: comparisons recompute identity
from anchors, and wire projection computes the same key. A normal revision-checked
edit writes version 2. Old paragraph IDs and association IDs remain unchanged.
Readers ignoring the marker preserve JSON fields; concurrent older native writers
against this workspace are unsupported. Stop all sessions before upgrading.
Legacy association snapshots preserve incoming `createdAt` / `updatedAt` in
optional `legacyCreatedAt` / `legacyUpdatedAt` fields; core-owned timestamps keep
their normal revision semantics. Old generic readers preserve these additive
fields, and legacy wire projection selects the snapshot timestamps when present.

The maintenance `update.lock` shared lease precedes database opening. The update
helper holds its exclusive lease while backing up SQLite, originals and local
credentials, then moves the verified bundle into a fresh version directory.
Only schema 2 releases are accepted by this updater; future schema transitions
require a separately designed and tested migration before changing that limit.
Keep the full 0001->0002 migration chain and immutable historical archives in
every bundle. Preserve the backup and failed installation on failure. Switching
the executable back does not undo database changes; recover data into a fresh
workspace from the backup and verify records/files before selecting it.

Codex login is available on the development host; no API secret was read or
printed. Windows Sandbox executable is absent. Hyper-V is installed but Get-VM
is denied by host authorization. A clean-host acceptance script can be delivered,
but its successful run cannot be claimed without an accessible clean host.

## Status

Plan recorded before runtime edits. Feature gates remain pending until their
tests and acceptance evidence are recorded; this document is not a pass report.
