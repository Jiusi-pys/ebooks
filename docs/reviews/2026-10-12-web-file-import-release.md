# Web File import hotfix (2026-10-12)

Source baseline: `b134b73`. This isolated release adds only the File/Blob
recognition fix and its regression tests; the separate EPUB layout work in the
primary working tree is not part of this release.

The previous source preparation code recognized `[object Blob]` but not browser
`[object File]`. It consequently omitted `size` from `validateSourceLink`, causing
the shared Rust/WASM boundary to return `invalid_command` before any import write.
The native Blob brand check accepts real File and Blob objects, including foreign
realm objects, while preserving ArrayBuffer support and rejecting spoofed tags.

Validation on this release candidate:

- New regression before fix: File import failed with `invalid_command`; the other
  three cases passed.
- `npm run check`, `npm run lint`, and `npm run build`: passed.
- `npm test -- --maxWorkers=4`: 632 passed, 55 skipped (127 passed test files,
  8 skipped). Skipped external integration tests are not acceptance evidence.
- `python -m unittest discover -s deploy -p 'test_*.py'`: 15 passed.
- Native browser at isolated `http://127.0.0.1:5193`: actual fixture EPUB parsed
  and imported as `[object File]`, 1,931 source bytes, one chapter and paired
  book/source operations. Stored source SHA-256:
  `c12c968282274919fb1023c007f15569c60c6f4bb936e63675a1c7d54a0b1f07`.
- Existing build warnings remain: large bundle, mixed static/dynamic imports and
  browser externalization of `stream` from `sax`.

Release scope: static browser assets only. No MySQL/SQLite/IndexedDB schema,
Rust server process, credentials or business data changes. Production acceptance
is recorded separately after the actual static switch; these candidate checks
alone do not claim a production book import.
