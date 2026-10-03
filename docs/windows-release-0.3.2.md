> 当前状态（2026-10-03）：见[工程状态与验收门槛](current-status.md)。本文件中的日期/版本记录保留其历史范围；当前迁移为 MySQL 0014 / SQLite 0003 / IndexedDB 11，生产尚未正式切换。

# Windows 0.3.2 package verification

Verified 2026-10-03 after the immutable ZIP was built. This external record is
not part of that ZIP or its archived source; do not rebuild/overwrite the same
release version to insert a self-referential checksum.

Package: `.tools/releases/Shufang-0.3.2-win-x64.zip`

SHA-256:
`6F53C72AC6F773216203C1C65A894CDB4DF601FDF477B1184774734CF37E9944`

Source commit: `f6879718dbc2333b3d39dcfafadb6b8318e0047e` plus the working-tree
source captured inside `native-source.tar.gz`; HEAD alone is not this release.
`release-manifest.json` records per-file hashes and the working-tree inventory.

Passed against this exact release:

- Full archive staging validation: signed size/hash, all listed files, extras,
  migration retention and executable requirements.
- Isolated hash-verified installation with `-NoShortcut` into
  `.tools/install-acceptance/0.3.2`.
- Packaged acceptance under Windows PowerShell 5.1: C ABI / SQLite reopen,
  independent service, 401, shared data, closed-workspace backup. Evidence:
  `.tools/release-acceptance-0.3.2-ps5/acceptance.json`.
- Actual service process smoke: shared SQLite, independent lifetime,
  authentication, single instance, MCP HTTP/stdio and graceful shutdown.
- Both immutable native migration archives match their recorded archive SHA;
  all 67 archived source hashes across the 0001/0002 manifests match live source.
- No test Shufang GUI/service/updater processes remained at final inspection.

The source checks and live AI/UI/update integration results are detailed in
`windows-completion-acceptance-20261003.md`. Clean-host attestation is false:
this was a development Windows machine. Production keys/feed, Authenticode,
clean Windows 10/11, reboot/login startup and full legacy REST differential
parity are not certified by this artifact. SQLite remains version 0002.
