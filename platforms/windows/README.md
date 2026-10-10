> 当前状态（2026-10-03）：见[工程状态与验收门槛](../../docs/current-status.md)。本文件中的日期/版本记录保留其历史范围；当前迁移为 MySQL 0014 / SQLite 0003 / IndexedDB 11，生产尚未正式切换。

# Windows native desktop and service

The Windows application uses WinUI 3, a local WebView2 document renderer and
one Rust core with SQLite. It runs without Node, npm, MySQL or a .NET SDK.
Windows 10 1809+ x64 / Windows 11 and the Microsoft Edge WebView2 Runtime are
required. The self-contained package includes .NET and Windows App SDK.

## Install and launch

Extract the release ZIP, then run `powershell -ExecutionPolicy Bypass -File
install.ps1` from its directory. The installer verifies every manifest hash,
installs into a fresh per-user directory and creates a Start menu shortcut.
It does not enable the service or Windows startup. `-Destination <new-path>`
and `-NoShortcut` support isolated/portable installations. A manifest proves
integrity against that manifest, not publisher identity: this development
package is unsigned.

Launch `Shufang.Windows.exe`. The default isolated workspace is
`%LOCALAPPDATA%/Shufang/NativePreview`; `--workspace <absolute-new-directory>`
selects another workspace. Existing Web/MySQL/browser libraries are not silently adopted. Native v2
replication can be configured explicitly; actual HTTPS restore into separate
Windows/Linux workspaces has passed. This is not a production cutover.
Metadata with pendingFields is visible but cannot overwrite missing content.

## Desktop operations

- Import multiple PDF, EPUB, MOBI/AZW/AZW3, FB2 or TXT files; alternatively use
  Path import with one absolute filename per line. Jobs can be cancelled.
  DRM-encrypted Kindle files are rejected. Scanned PDFs need selectable text
  for extraction; the original page remains viewable. EPUB/Kindle/FB2 are
  normalized text readers, not layout-preserving publishers' renderers.
- Edit book metadata, folders, cover thumbnails and notes. Open a book to read,
  navigate chapters, search text, adjust typography or switch PDF original/reflow.
  Selections save UTF-16 or PDF geometry anchors. Highlights reappear on reopen.
- Cite a selection to a note; the note's source selector plus Read / Jump back
  returns to the passage. Pin two passages to create an association. Edit mind
  maps, study sets and tags/cloze from the navigation pane. Enroll highlights for
  review, select a study set to review only its due cards, reveal the answer and
  rate recall. Notes have native Markdown preview and clickable `[[wiki links]]`.
- AI settings support OpenAI, DeepSeek, Kimi, MiniMax and local Codex CLI.
  Enter a model and key, save, then test. Keys use Windows DPAPI and never enter
  replicated entity data. Codex must be separately installed/authenticated.
  Explicit Send transmits the displayed passage; whole-book digest transmits
  extracted text in bounded parts. Generated maps/cards/translations are
  validated before saving. Saved translations appear under their chapter.
- Settings can start/stop the independent service, opt into user-level login
  startup, copy its API token, manage webhook subscriptions/retries and create
  backups. Save port / Refresh remembers the port and shows current status; stop
  the service before changing its port. Closing the desktop leaves an explicitly started service running.

## Independent service

```
shufang-service.exe --workspace C:\path\to\workspace --port 31417
shufang-service.exe --workspace C:\path\to\workspace --stdio
```

HTTP binds only 127.0.0.1. `X-API-Key` is the desktop's copied service token.
`GET /health` is public; `/admin/status` and `POST /admin/stop` require the token.
For HTTPS reverse proxies, pass `--public-url https://books.example.com`;
TLS termination and external publication are the operator's responsibility.
No remote listener or firewall rule is created by this package.

Legacy REST resources under `/api/v1`: books, folders, notes, highlights, associations,
translations, mindmaps, studysets. GET lists/reads, POST creates, PATCH updates,
DELETE removes. Lists and bodies preserve legacy wrappers/`extId`; Bearer API
tokens and `X-API-Key` are accepted. `/api/v1/events` uses delivery receipts and
chunked import; `/ask`, `/translate`, `/digest/:contentHash` and `/review/due`
are available. Native revisioned CRUD lives under `/api/native/v1`: use
`revision` or `If-Match` to prevent stale writes. Native import uses
multipart `POST /books/import`; poll returned job with `GET /jobs/{id}` and cancel
with DELETE. POST `/search`, `/ai`, `/citations`, `/highlights/{id}/review` exposes
use cases. `POST /highlights/{id}/review-enrollment` accepts `enabled` and
`expected`; `GET /review-queue?studySet=<optional-id>` returns due records. MCP `/mcp` or stdio provides six read-only tools. OAuth discovery,
PKCE S256 consent, one-use codes, rotating refresh and revocation are supported;
OAuth access is read-only and cannot inspect private jobs or administration.
Webhooks use stable delivery IDs, optional HMAC SHA-256 and persistent retries.
After eight failed attempts a delivery remains available for manual retry.
Consumers must deduplicate delivery IDs.

## Backup, migration and recovery

SQLite schema is 0003. Empty databases run 0001 through 0003; 0001/0002 upgrade directly,
and successful receipts are skipped. Failed migration steps roll back. Unknown
future versions/checksum drift fail closed. The package includes the full SQL
chain and immutable source archives under `migrations/`. See
`docs/windows-delivery.md` in the source tree for actual verification.

The backup command uses an online SQLite snapshot plus originals and encrypted
credentials with SHA-256 checks. Restore verifies contents in staging and only
creates a new directory. DPAPI keys require the same Windows user/machine.
To update manually, back up first, stop all writers, install a new program
version alongside the old one, then launch with the same workspace. Re-enable
login startup from the new version if previously enabled. An executable rollback
does not downgrade SQLite: restore the complete pre-upgrade workspace into a new
directory before using an older binary. Never copy only a live .sqlite3 file
without its WAL.

## Metadata, EPUB and signed updates

EPUB imports extract OPF metadata and EPUB 3/EPUB 2 NCX navigation. The reader
shows bounded local PNG/JPEG/WebP images, footnotes and return navigation.
Advanced outline edits retain chapter and paragraph anchors. Metadata lookup
offers OpenLibrary candidates for explicit review; search can mix editions.

Configure an HTTPS update-feed URL and the publisher's RSA public PEM in Windows
settings. Startup checks are opt-in; installing requires the update dialog.
The helper verifies the signed archive again, holds an exclusive workspace lock,
backs up data and waits for the new version's ready signal. Failure restarts the
old executable and retains backup/evidence; it does not roll back the database.
Publish a feed with a separately managed private key (never commit that key):

```powershell
dotnet run --project platforms/windows/UpdatePublisher -- 0.3.3 https://downloads.example.com/Shufang-0.3.3-win-x64.zip ./Shufang-0.3.3-win-x64.zip C:/secure/publisher-private.pem ./0.3.3.feed.json
```

Run the packaged acceptance script on a new test workspace. It needs 64-bit
PowerShell, not development SDKs, Node, Python or MySQL. `-CleanHostAttested`
is a human assertion about the environment and must only be used on an actual
clean Windows host. WebView2 Evergreen is still a desktop prerequisite.

```powershell
./acceptance.ps1 -EvidenceDirectory C:/tests/shufang-033
```

## Build and verify from source

Uninstall with `./uninstall.ps1` after closing this installation's desktop,
service and updater. It removes hash-matching release files and this version's
startup/shortcut references; workspaces, originals, backups, modified and
unlisted files are preserved. Final acceptance results and external environment
gates are in `docs/windows-final-acceptance-20261003.md`.

From repository root, with Rust MSVC, VS 2022 Build Tools/CMake, .NET 8 SDK and
Node installed:

```powershell
npm ci --prefix app
./platforms/windows/native/build.ps1
cargo test --manifest-path base/Cargo.toml --workspace --locked
cargo build --manifest-path base/Cargo.toml -p shufang-bindings -p shufang-service --locked
dotnet run --project platforms/windows/CoreBridge.Smoke/CoreBridge.Smoke.csproj
dotnet build platforms/windows/Shufang.Windows/Shufang.Windows.csproj -p:Platform=x64
node --test platforms/windows/reader.test.mjs
./platforms/windows/package.ps1 -Version 0.3.3
python platforms/windows/service-smoke.py <published-directory>
```

PDFium is pinned by archive SHA-256; libmobi is pinned to v0.12 commit with
source/build recipe and license included. `release-manifest.json` records the
source commit, uncommitted-state inventory and per-file hashes. Keep the full
uncommitted patch with this development build; a HEAD alone does not reproduce it.
