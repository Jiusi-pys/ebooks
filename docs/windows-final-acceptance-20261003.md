> 当前状态（2026-10-03）：见[工程状态与验收门槛](current-status.md)。本文件中的日期/版本记录保留其历史范围；当前迁移为 MySQL 0014 / SQLite 0003 / IndexedDB 11，生产尚未正式切换。

# Final Windows acceptance ledger

Scope remains Windows, shared core, AI and independent service. Native cross-end
replication and further Web business migration are deferred. All test data is
synthetic and isolated. Historical releases and migration archives are preserved.

## Completed gates

- Added actual HTTP differential execution against the old Hono/MySQL router and
  a separately running native service. Thirty scenarios cover resource defaults,
  large/empty notes, strict/stripped fields, metadata normalization/calendar/
  language/rating constraints, highlights/null clearing/tags/cloze/review/QA,
  translations, mindmap defaults, association identity/idempotence/conflict/PATCH,
  chapters/state/missing reads, digest/due and event duplicate/conflict receipts.
  Per-node timestamps/revisions are normalized for comparisons. Validation-error
  statuses are compared; the old Zod diagnostic formatting is not replicated.
  Existing Rust tests cover upload atomicity, webhook numeric IDs/HMAC/retries,
  note deletion/citation relationships and error paths.
- Repaired defects exposed by those comparisons, including note default/length,
  custom mirror formats, translation/mindmap book-title snapshots, metadata and
  highlight validation, recursive mindmap defaults and association PATCH shape.
- Journal snapshots v1 are atomic with entity/outbox writes. Rapid create/edit/
  delete then reopen produces the committed First/Second/Second payloads, never
  three copies of latest state. Receipt failure leaves no orphan journal record.
  Old journal rows without snapshots retain the explicit legacy fallback; their
  historical values cannot be reconstructed or certified retroactively.
- Executed MySQL integration and migration fixtures in an isolated MySQL 8.4
  container. This found four SQL offset names mapped to incorrect domain names;
  a focused regression test and corrected mapping preserve exact anchors. Run
  global legacy-import integration fixtures serially to isolate whole-database
  scans. This is a repair of existing import code, not new native network work.
- A separate Python HTTP OAuth client verified discovery, PKCE/consent, bad owner
  token, one-use code, read-only scope/admin denial, refresh rotation/replay and
  revocation against an actual service process. No user/client secrets were used.
- Re-executed real authenticated Codex native question/answer and REST ask/
  translate with synthetic tree-count and book sentences. Results persisted and
  reopened. Logs: `.tools/final-live-native-ai.log`, `.tools/final-live-rest-ai.log`.
- EPUB unsupported asset isolation and percent-encoded footnotes pass regression
  tests. PNG/JPEG/WebP are the supported raster formats; SVG/GIF rendering and
  publisher layout are not advertised. UI image/footnote/navigation/metadata
  evidence from the completion ledger remains applicable.
- The headless `--service-start` entry started an independent service and exited;
  the authenticated client remained usable and stopped cleanly. This does not
  stand in for actual Windows login/reboot.
- Uninstall removes hash-matching installation files only, rejects running
  installation processes and preserves modified/unlisted files, nested user data
  and the independent workspace. An isolated install/acceptance/uninstall test
  verified every workspace file hash was retained.

## Final verification commands and evidence

Use `platforms/windows/tests/rest-differential.py <native-directory> --full`
with RUN_MYSQL_INTEGRATION=1, RUN_MYSQL_MIGRATION_FIXTURE=1 and a fresh isolated
DATABASE_URL/SYNC_TEST_DATABASE_URL. OPEN_API_KEY must be a synthetic test key.
Do not run these against production. All new test sources are delivered in the
repository; release source archives also include the Web oracle/test sources.

Evidence: `.tools/final-native-web-mysql.log`, `.tools/rest-differential-final.log`,
`.tools/final-acceptance-rust.log`, `.tools/final-acceptance-clippy.log`,
`.tools/final-acceptance-tscheck.log`, `.tools/final-acceptance-lint.log`,
`.tools/uninstall-green/uninstall-result.json`, `.tools/startup-entry-032/`.
The final package verification is recorded separately after building an immutable
new version; prior 0.3.2/0.3.1/0.3.0/0.2.2 are never overwritten.

## Remaining external gates — not passed

1. Clean Windows 10/11 host: Sandbox is absent; Hyper-V is present but VM access
   is denied by host authorization. No accessible clean Windows machine has been
   provided. SDK-free acceptance on the development host is not a clean-host pass.
2. Actual login/reboot on that test machine. The host has not been rebooted or its
   existing startup preferences changed for these isolated tests.
3. Production Authenticode identity, publisher private key/pinned public key and
   production HTTPS update feed. Ephemeral test signatures verify the protocol,
   not publisher identity or deployment. No production domains/keys were supplied.
4. Other paid AI providers and a real external OAuth application's TLS/proxy
   deployment require their configurations. Authenticated Codex and independent
   local HTTP OAuth client are passed; this is not every third-party provider.

The user has been asked for these environments/configuration locations without
requesting secret contents. No elapsed time or absent reply counts as approval or
as test evidence. The entire acceptance cannot be declared passed until these
external gates have actual evidence.

SQLite stays 0002. Journal v1 is additive private JSON with optional Change DTO
snapshot. Stop older writers before upgrade, back up the complete workspace, and
restore only into a new directory with writers closed. See the final acceptance
plan for execution order and compatibility. No historical SQL/ledger was edited.
