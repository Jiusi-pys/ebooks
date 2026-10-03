> 当前状态（2026-10-03）：见[工程状态与验收门槛](current-status.md)。本文件中的日期/版本记录保留其历史范围；当前迁移为 MySQL 0014 / SQLite 0003 / IndexedDB 11，生产尚未正式切换。

# Windows completion acceptance — 2026-10-03

Scope: Windows desktop, shared Rust core, real AI and independent local service.
Native cross-device replication and further Web business migration remain
deferred. This record supplements the immutable 0.2.2 acceptance record.

## Verified implementation and evidence

| Gate | Observed result |
| --- | --- |
| TDD / Rust | EPUB images/non-spine notes, EPUB 3 navigation, EPUB 2 NCX nested fragment navigation, outline edits/validation, metadata merge/cache invalidation, legacy REST, receipt atomicity/expiry and update maintenance have regression tests. Release workspace suite: 55 pass, 5 opt-in. Release Clippy all targets denies warnings. |
| Native parsers | Both explicitly enabled PDFium and upstream Kindle fixture tests pass using pinned dependencies. |
| Renderer | Five Node tests pass; local image/footnote rendition matches immutable paragraphs and UTF-16 anchors. |
| Existing Web / deployment | TypeScript check, lint and build pass; Vitest 566 pass / 15 MySQL integration cases skipped. Python deployment suite: 11 pass. |
| C# / core | Actual DLL/SQLite smoke exercises Unicode, reopen, conflicts, drafts, search, review, port persistence and the cross-language update lock. |
| Actual Windows UI | EPUB local image, non-spine footnote display/return, nested outline jump and OpenLibrary candidate preview/application passed. See screenshots below. |
| Real AI | Authenticated Codex native question/answer passed in 9.24 s with persisted result/reopen. Live independent REST ask and translate passed in 18.34 s using model `gpt-6.1-sol`, low effort. Synthetic texts only; no user books sent. |
| Real metadata | OpenLibrary search for public ISBN 9780140328721 returned Fantastic Mr Fox / Roald Dahl. UI application preserved manual title/author. Work-level candidate editions require human verification. |
| Signed update validation | Wrong key/signature, downgrade, invalid Windows paths, traversal, duplicate/extra files, size/hash mismatch, modified contents and cancellation are rejected. Real 0.3.0 archive passes all-file verification. |
| Update execution | Isolated 0.2.2→0.3.0 update produced a backup, version-ready confirmation and active pointer. Hardened helper discarded tampered staged reader/manifest and re-extracted the signed archive. Synthetic correctly signed package that never reports GUI readiness triggered timeout, terminated only its new process and restarted the old GUI; backup and failed version were retained. `databaseRollback=false`. |
| Portable acceptance | Packaged script passed on the development host: manifest, C ABI reopen, independent process, authentication, two-way shared data and backup. `cleanHostAttested=false`. |

Final source is packaged as 0.3.2. The immutable 0.3.1 test package also passed
all-file archive validation and isolated installation. Running its acceptance
through Windows PowerShell 5.1 exposed a null process ExitCode after WaitForExit;
retaining the process handle immediately after Start-Process fixed the script,
and the 5.1 rerun passed against that same release. 0.3.2 includes this fix.
The 0.3.1 hardened update integration also passed with a deliberately modified
staged reader and manifest; the installed reader matched the signed ZIP.

Screenshots:

- `evidence/windows-epub-return-20261003.png`
- `evidence/windows-outline-jump-20261003.png`
- `evidence/windows-metadata-20261003.png`

Local machine-readable evidence is under `.tools/release-acceptance-0.3.0/`,
`.tools/update-hardening-success/` and `.tools/update-hardening-failed-start/`.
Logs of final source checks are `.tools/completion-release-tests.log` and
`.tools/completion-clippy.log`. These directories are not user data and are not
source archives. The package carries allowlisted source and migration backups;
the final ZIP checksum is recorded externally to avoid self-referential hashes.

## Compatibility and recovery

SQLite remains 0002; no historical SQL or migration ledger was changed by these
completion features. Outline, legacy timestamps/fields and update preferences
are additive payloads; old clients can retain unknown fields. Local receipts,
uploads, digest caches and webhook state use existing revisioned private values.
Business write + receipt + upload completion is one SQLite transaction.
Unknown historical caches without an expiry are retained, not silently deleted.

Updater acquires the maintenance lease before backup/migration/start. It freshly
extracts the signed ZIP rather than trusting a mutable staging manifest. Success
requires matching package version and schema readiness. Executable restart is
not database rollback. Recovery for incompatible schema requires restoring the
complete backup into a new directory with all writers closed. DPAPI credentials
remain bound to the original Windows user/machine. Source migration archives
are distinct from user-data backups.

## Unverified / blocked gates

- **Clean Windows is blocked:** Sandbox executable is unavailable; Hyper-V
  inspection is denied by host authorization. No other clean machine was
  supplied. Development-host acceptance must not be represented as clean-host
  certification. The portable script is ready for Windows 10/11 execution.
- Production update URL/trust key and Authenticode are not configured. Test
  signatures use ephemeral local keys. WebView2 Evergreen remains required.
- Real AI proves the authenticated Codex adapter only; other paid providers,
  external OAuth clients/TLS, reboot/login startup and uninstall were not tested.
- EPUB SVG/GIF, embedded cover extraction and full publisher layout are outside
  the verified rendition. Broad real-document/font/publication testing remains.
- All legacy routes are present and focused valid/invalid/error cases pass,
  but exhaustive differential verification of every old schema/default/error
  combination is not complete. Native webhook events without mirror snapshots
  can project the latest state after rapid edits rather than every intermediate
  state. Do not claim unconditional full legacy parity.
- Native migration tests cover empty 0→2, populated 1→2, idempotence, failure
  recovery, checksum and future-version rejection. There is no populated
  pre-0001 released native database fixture; empty 0→2 is not such a fixture.

No production library, existing MySQL/IndexedDB data, startup preferences,
shortcuts or firewall settings were modified by these isolated completion tests.
