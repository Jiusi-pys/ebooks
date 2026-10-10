> 当前状态（2026-10-03）：见[工程状态与验收门槛](current-status.md)。本文件中的日期/版本记录保留其历史范围；当前迁移为 MySQL 0014 / SQLite 0003 / IndexedDB 11，生产尚未正式切换。

# Windows delivery contract

For 0.3.3, the additional completed gates and external prerequisites are in
`windows-final-acceptance-20261003.md`. Its actual REST/MySQL, historical webhook,
OAuth client, uninstall and startup-entry results supersede the older limits
listed here. Clean Windows, production signing/deployment and real login/reboot
remain separate environment gates.

## Approved scope (2026-10-03)

Deliver a standalone WinUI desktop, local document rendering, Rust business
use cases, AI providers and an independently running REST/MCP/OAuth/webhook
host. No Node/MySQL runtime dependency. The original phase deferred native sync;
the later approved continuation implemented native v2 replication and verified
actual HTTPS restore. Full Web business migration and production cutover remain
incomplete; current results supersede the historical phase limits below.

## Implementation inventory

The Windows implementation now provides the following paths through the Rust
core. This inventory describes implemented behavior; the evidence and remaining
acceptance limits below determine what has actually been verified.

- Library/folders, editable metadata and cover thumbnails, multi-file import,
  cancellation, Unicode text search and immutable original-file storage.
- PDF original/reflow; normalized EPUB, MOBI/AZW/AZW3, FB2 and TXT chapter text.
- EPUB local PNG/JPEG/WebP images, spine/non-spine footnotes with return,
  EPUB 3 navigation and EPUB 2 NCX nested fragment destinations; editable
  advanced outline with stable chapter/UTF-16 anchors.
- EPUB metadata extraction and opt-in OpenLibrary candidate lookup/preview/apply.
  Work-level search candidates may combine editions; verify ISBN/date/language.
- Chapter navigation, text search, font size/line spacing/theme, exact UTF-16/PDF
  selections, durable highlights, reading checkpoints and history.
- Native Markdown note preview and wiki links, source citations with jump-back, transactional deletion/relationship
  cleanup, associations/graph, editable mind maps, study sets, review enrollment/due queues and review ratings.
- AI question/answer, passage translation, hierarchical whole-book digest,
  structured mind maps/cards, validated result persistence and chapter translations.
- DPAPI provider keys, streamed partial responses, bounded requests/responses,
  cancellation, timeouts, incomplete-output detection and transient HTTP retry.
- Independent REST + MCP stdio/HTTP, PKCE OAuth read-only access and durable
  HMAC webhooks with retry management. Desktop/service share the same SQLite.
- Desktop service controls, per-workspace process lock, opt-in user login startup,
  online backup/new-directory restore, checksummed self-contained ZIP installer.
- RSA-3072 pinned-key update feed, opt-in startup checks, signed archive staging,
  exclusive workspace maintenance, pre-update backup, ready/version confirmation
  and old-program restart on failed launch. A failed launch does not undo SQL.

Native CRUD/use cases are exposed under `/api/native/v1`; `/api/v1` preserves
legacy resource shapes and adds event mirroring, chunked import, digest/due,
ask/translate and numeric webhook identifiers. Business writes, event receipts
and completed uploads commit atomically. Transport caches have quotas/expiry;
historical cache rows without expiry are retained. See the completion plan for
additive payload compatibility and the completion acceptance record for limits.

## SQLite 0002 migration design

Starting points: empty native database (0) and published preview schema 0001.
Append 0002 after 0001 without changing either the original SQL or receipt.
0002 adds a durable entity-change journal and revisioned private local values.
The journal feeds local desktop/service refresh, not cross-device replication.
Private values hold local infrastructure state; credentials are opaque OS-store
references, never plaintext provider keys. Existing entity and outbox records
retain their contents and identities.

The migrator validates all existing receipts before executing every missing
version inside one IMMEDIATE transaction. Record version/checksum only after
each successful step. Reopening is idempotent. Failed DDL rolls back the entire
upgrade; unknown future versions and checksum drift are rejected. Old 0001
binaries must refuse version 2 instead of opening it. This is the compatibility
boundary for the preview, not an automatic downgrade facility.

Before upgrading a populated workspace, stop all desktop/service writers and
copy its SQLite database (including any outstanding WAL) and original-file
store to an independent backup. Restore only while all handles are closed.
Executable rollback cannot undo a database upgrade. Package the full migration
chain and append an immutable archive and SHA-256 manifest under
app/db/migration-history. Migration source archives are not user-data backups.

Required migration tests: empty 0->2, 1->2 with retained entities/outbox,
reopen, duplicate invocation, interrupted/failed step 2, corrected retry,
checksum mismatch and future-version rejection. Use temporary databases only.

## Additive preferences compatibility

The optional `preferences/windows-service.port` value uses the existing revisioned
entity contract (valid desktop ports 1024–65535, default 31417 when absent). No SQL,
IndexedDB structure or existing entity payload is rewritten. Existing schema-0002
workspaces open directly; older 0002 desktop builds retain this value but ignore
it. Review enrollment uses the existing optional `highlights.review` structure;
turning it off explicitly removes enrollment and turning it on creates a due card.
Repeat enrollment preserves review history. Backup/restore includes both values;
restore into a new directory remains the failure-recovery path. Tests verify
empty defaults, persisted values after reopening and optimistic-revision failure.

## Verification ledger

Verified on this Windows development machine in isolated temporary workspaces:

| Layer | Evidence |
| --- | --- |
| Rust core/native/service | Completion suite: 55 tests pass / 5 dependency or live-service tests opt-in; Release Clippy all targets with warnings denied passes |
| Native document dependencies | 2 explicitly enabled tests pass with packaged PDFium and libmobi |
| Renderer | 5 Node tests cover Unicode anchors, asynchronous PDF/jump ordering and EPUB image/footnote mapping |
| C# bridge/ViewModel | Real DLL/SQLite smoke passes: Unicode, restart, conflicts, editor draft, Chinese/emoji search, reading/editor conflict handling, review enrollment, port persistence, Markdown tokens, outbox |
| Existing Web | TypeScript check, lint, build pass; Vitest 566 pass / 15 MySQL integration tests skipped in this run |
| Deployment | 11 Python supervisor tests pass |
| Migration archives | 0001 archive: 33 files; 0002 archive: 34 files; archive/extracted/live SHA-256 all match |
| Release/installer | Self-contained publish and isolated manifest-verified installation; runs with invalid DOTNET_ROOT and multilevel lookup disabled |
| Real service process | Desktop-to-REST and REST-to-desktop visibility, 401, single instance, HTTP/stdio MCP, graceful stop pass |
| Actual UI | Chinese note create/reopen, native Markdown preview/wiki-link navigation, TXT import/read/selection, PDF import/original/select/cite/reopen/jump/reflow, cloze enrollment/reveal/rating, service start, stop and survival after actual window close |

Screenshots are under `docs/evidence/windows-20261003/`. The PDF interaction test
found two defects that were repaired: mapped WebView resources bypass the request
handler, and jump messages could run before asynchronous PDF initialization.
See the [WebView2 request behavior](https://github.com/MicrosoftDocs/edge-developer/blob/main/microsoft-edge/webview2/how-to/webresourcerequested.md).
The latter also has a renderer regression test. Native note preview additionally
normalizes WinUI CR line endings; its block/token regression checks preserve
Unicode, quotes and literal untrusted HTML. No production books, original
Web databases or OS startup preferences were changed by acceptance tests.

Additional completion evidence is recorded in
`docs/windows-completion-acceptance-20261003.md`. Real authenticated Codex calls
passed native question/answer and REST question/answer/translation with persisted
results; an actual OpenLibrary lookup and Windows candidate application passed.
Actual Windows screenshots also show EPUB images, footnote return and nested
outline navigation. Update tests proved successful installation, rejection of
mutable staging tampering, and old-program restart after missing readiness.

## Remaining acceptance limits

This is an unsigned development executable release. The update protocol uses
cryptographic signatures, but production trust keys/feed and Authenticode are
not configured. Other paid AI providers, external OAuth clients/reverse-proxy
TLS, Windows login/reboot startup and clean Windows 10/11 machines were not
tested. The portable acceptance script passed on the development host; it does
not certify a clean host. Windows Sandbox is absent and available Hyper-V
inspection is denied by host authorization. Original and reflow PDF was tested with
a synthetic single-page PDF; broad real-document/font/layout coverage remains.

The normalized reader does not preserve publisher layout. EPUB SVG/GIF images,
embedded cover extraction and broad real-publication coverage are not verified.
Legacy REST route/payload and atomic mirroring tests pass, but an exhaustive
differential corpus against every old validation/default/error combination has
not been executed. Native webhook journal events without a mirror snapshot can
project the latest entity state after rapid edits rather than each intermediate
historical state. These are remaining Windows acceptance limits. Native cross-device replication, real-library
adoption and the remaining existing Web business-layer migration remain deferred
by the user's instruction.

SQLite preview compatibility: current migrations support 0→2 and 1→2. There is
no populated pre-0001 native release to use as a multi-version historical fixture;
0→2 executes both steps, but is not represented as a populated historical jump.
Backup restores originals and private state; encrypted credentials only decrypt
for the original Windows user/machine. Program rollback does not reverse schema.
