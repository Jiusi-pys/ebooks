# Shufang (書房)

[简体中文](README_zh.md)

Shufang is a reading and book-management workspace with a MySQL-backed library inspired by the
deep-reading workflow of MarginNote 4. It combines a multi-format reader,
annotations, hierarchical citations, passage associations, study sets,
mind maps, spaced review, and AI-assisted reading in one web application.

This is not a pixel-for-pixel MarginNote clone. Apple Pencil handwriting,
video timeline annotations, iCloud sync, native OCR, and Apple-platform
extensions are outside the current web scope.

## Implemented Features

- Import PDF, EPUB, DRM-free MOBI/AZW/AZW3 (including KF8), FB2, and TXT.
- Read PDFs in original-layout or reflow mode; annotate PDF text and retry
  failed document/page rendering.
- Build resizable two-, three-, or four-pane layouts with horizontal and
  vertical nesting. Study-set splits are scoped to the set; bookshelf splits
  default to the current book.
- Use synchronized Chinese/English bilingual reading for reflowable books.
- Switch reflowable books between continuous vertical scrolling and horizontal
  page turning with wheel, keyboard, and on-screen navigation.
- Highlight, annotate, tag, create cloze deletions, and cite at book, chapter,
  or exact-passage level.
- Link precise passages across books with directional or bidirectional
  associations and inspect the resulting graph.
- Organize storage folders separately from logical study sets; customize folder
  icons, book covers, outlines, and reader typography.
- Edit catalogue metadata such as title, contributors, publisher, publication
  date, languages, identifiers, series, subjects, description, edition, and
  rights, and mirror it to MySQL without rewriting the source ebook file.
- Synchronize browser IndexedDB and independent Windows/Linux MySQL workspaces
  through v2 operations, persistent receipts, field versions, and tombstones.
  HTTPS REST transfers metadata and complete file replicas in both directions.
- Create editable mind maps, review cards, and spaced-repetition queues.
- Use Codex through a local ChatGPT login, or select the optional DeepSeek API
  provider from the AI settings panel.
- Pin or auto-hide both reading sidebars; immersive mode hides both sidebars
  and the reader toolbar. The right panel can combine excerpts, annotations,
  and AI Q&A into one colour-coded chronological feed. Manage the MySQL-backed
  local username and password from the account panel.

## Global Search

Open search from the top of the workspace or press `Ctrl + K` (`⌘ + K` on
macOS), enter a keyword, and press Enter or click Search. The shortcut also
works in immersive reading, where the top entry is hidden. Matching uses
literal, case-insensitive substrings with leading and trailing query whitespace
removed; regular expressions and semantic search are not supported.

| Scope | Included content |
| --- | --- |
| 本书 (This book) | The current book's title, author, chapter titles, text, highlights, annotations, and notes linked through citations. Disabled when no book is open. |
| 本合集 (This study set) | Books belonging to the selected **study set**, their highlights and annotations, and citation-linked notes. Membership is independent of bookshelf folders; choose the set below the search input. |
| 文库全部内容 (Entire library) | All books, highlights, annotations, and notes loaded in the current workspace, including standalone notes. |

The **Result type** selector is independent of the scope selector. Choose
**书摘 (Excerpts)** to search only saved excerpts, **批注 (Annotations)** to
search annotation text, or **问答 (Q&A)** to search both questions and answers
recorded by AI; choose **全部内容 (All content)** to keep the complete search.

Reading defaults to the current book; a specific study-set page defaults to
that set; other pages default to the entire library. Results show their source
and a highlighted excerpt, with one result per matching paragraph. Open a text
or annotation result to navigate to its source, or a note result to select the
matching title/body text. PDF navigation switches reader mode when needed.

Search reports the result count and displays up to 200 entries. Narrow the scope
or refine the keyword for more specific results. Searches can be cancelled;
changing the query or scope cancels the previous search so late results cannot
replace the current input.

Search runs in the browser. PDFs without usable reflow text are extracted page
by page from the locally cached original, with progress feedback. Missing files,
extraction failures, and pages without extractable text are reported while other
content remains searchable. Text inside images is not searched; OCR is not
included. No database migration or additional search-service configuration is
required.

## Reader Workspace and Navigation

The left navigation displays feature icons by default; hover an icon to reveal
its name. Counts remain visible as small badges. Recent-reading rows reserve a
fixed cover column, truncate long titles in the remaining space, and clip the
vertical title label inside generated covers.

Both sidebars can be pinned or set to auto-hide. On desktop, opening an
auto-hidden left sidebar shifts the top search bar and reader outline to the
right; opening the auto-hidden right reader panel reserves page space instead
of covering the text. Use the right-panel **合并 (Combine)** control to switch
between separate tabs and a single time-ordered feed. In the feed, excerpts,
annotations, and individual Q&A records are interleaved and marked in orange,
blue, and purple respectively.

Keyboard hints are kept out of the reading controls. Open **应用设置 (App
settings)** from the left sidebar to view the shortcut reference: `Ctrl/⌘ + K`
opens global search, `Esc` closes transient UI or exits immersive reading, and
`←/→` or `PageUp/PageDown` turn pages in paged reading.

## EPUB Navigation, Notes, and Typography

EPUB imports preserve navigation entries and paragraph anchors, including notes
stored in separate content documents. Recognized footnote references appear as
superscripts at 65% of the body font size. Click a reference to open its note;
press Escape or use the close button to dismiss it without leaving the text.
Footnotes are retained in the local book and the chunked MySQL mirror, whose
validation checks paragraph indexes, text ranges, and upload size limits.

Open **Aa 排版** in the reader toolbar to adjust the font, font size, line
spacing, paragraph spacing, letter spacing, page margins, and background.
Changes apply immediately and are saved in this browser. The settings panel
scrolls when needed and remains accessible outside clipped split panes.

- Paragraph spacing ranges from 0 to 3 em.
- Single-page continuous reading fills the available reading pane instead of
  being capped at 680 px. Bilingual and reference panes also use their available
  width.
- Page margins range from 16 to 480 px per side, capped at 25% of the pane width
  to retain space for text in narrow panes. Increase the margin for shorter lines
  on wide screens; existing preferences are preserved.
- These typography controls apply to reflowed text. For original-layout PDFs,
  switch to reflow mode to adjust text typography.

Parser, note interaction, upload validation, and EPUB-to-mirror regression tests
include a small synthetic EPUB fixture. To additionally test a local EPUB, set
`EPUB_MIRROR_TEST_FILE` to its absolute path and run
`npm test -- src/lib/epubMirror.test.ts` from `app/` (use `npm.cmd` on Windows).
This test does not write to MySQL or upload the source file.

## Architecture and Data Storage

The application is in [`app/`](app/):

```text
app/
├── src/          React 19 UI, readers, hooks, parsers, and IndexedDB access
├── api/          Hono server, tRPC procedures, auth, AI, and REST API
├── contracts/    Shared request and error contracts
├── db/           Drizzle schemas and MySQL migrations
├── public/       Static assets and the PDF.js worker
└── verifier/     Historical acceptance criteria and run records
```

With `SYNC_ENABLED=true`, each server has its **own MySQL database** and
SHA-256 content-addressed file directory (`SYNC_BLOB_DIR`). MySQL stores entity
state, field versions, operation history, tombstones, receipts, and replication
checkpoints. Original files and large derived content live in the file directory;
back up **both the database and this directory**. Mount the directory persistently
when using Docker. Accounts, passwords, sessions, and API keys do not replicate.

IndexedDB is an offline replica with a transactional outbox. Books, folders,
notes, excerpts/citations, associations, translations, mind maps, study sets,
review events, reading state, and allowlisted preferences synchronize through
`/api/v2`. The current browser schema is **v10**, which repairs missing stores
without clearing existing records. Unsent edits survive snapshot merges;
late operations cannot resurrect deleted entities. Restore creates a new ID.

Windows can initiate **both push and pull over HTTPS REST** to a public server;
no inbound Windows port or SSH tunnel is needed. Operations and file transfers
retry independently. Files use 256 KiB chunks, resumable sessions, and SHA-256
validation, with a server limit of 256 MiB per original file. Browser import
limits are listed below. Browser replicas download originals on demand and can
pin books for offline use.

Open **应用设置 → 同步与离线书籍** (App settings → Sync and offline books) for
pending changes, upload/download state, peer status, manual synchronization, and
offline pinning. There is no permanent bottom status badge. “当前节点已确认”
means the current server acknowledged browser edits; verify the other node's
content and file state before treating it as a second complete replica. Keep
the original browser open until its pending work finishes.

When `SYNC_ENABLED=false`, the older MySQL mirror/library endpoints remain
available. Enabling v2 imports their existing data and validates original-file
chunks before switching references; old records are retained. Old imports that
never saved originals require reimporting the source file. Do not disable v2 as
a rollback shortcut: new v2 edits are not copied back into the legacy tables.
See [migration, deployment, and backup/recovery](app/docs/workspace-sync.md).

### Verified deployment status — 2026-09-27

- Windows: `http://127.0.0.1:3000`, node `windows-personal`.
- Cloud: `https://us.jiusi.org`, node `linux-personal`.
- Shared workspace: `personal-workspace`; separate databases and file replicas.
- Transport: outbound HTTPS REST push/pull from Windows; cloud
  `SYNC_PEERS_JSON=[]`. SSH is only a test/deployment-management tool.
- Runtime synchronization release: `60997bd`. At the 18:11 Asia/Shanghai check,
  both nodes reported sequence `137`; Windows reported zero replication failures.
  These counters are a dated observation and increase with subsequent edits.
- Real HTTPS acceptance: 4,955 ms Windows → cloud and 3,771 ms cloud → Windows
  metadata visibility; cross-chunk file checksums matched in both directions.
  See [acceptance report](app/docs/sync-https-acceptance.md).
- Pairing was checked at 18:11: token issuance `201`, authenticated access `200`,
  revocation `200`, revoked-token access `401`. The temporary credential was revoked.
- Tests at that release: 479 passed, 15 optional integration tests skipped.
  Windows process auto-start/supervision and native iOS/Xcode verification remain
  pending. Windows Node and Docker/MySQL must stay running; no webhook is required.

## Requirements

| Dependency | Requirement                                                 |
| ---------- | ----------------------------------------------------------- |
| Node.js    | `20.19+` or `22.12+`; Node 22 LTS or 24 is recommended      |
| npm        | Included with Node.js; the lockfile is committed            |
| MySQL      | MySQL 8.4 recommended and validated                         |
| Browser    | A current Chromium, Edge, Firefox, or Safari with IndexedDB |
| Codex CLI  | Optional, but required for the default AI provider          |
| Git        | Needed to clone and update the repository                   |

## Quick Start

Clone the repository and enter the application directory:

```bash
git clone git@github.com:Jiusi-pys/ebooks.git
cd ebooks/app
```

On Windows PowerShell, use the `.cmd` launchers. They bypass systems where
PowerShell blocks `npm.ps1` without changing the machine execution policy:

```powershell
npm.cmd ci
Copy-Item .env.example .env
```

On Linux or macOS:

```bash
npm ci
cp .env.example .env
```

Complete the MySQL and `.env` configuration below, then run:

```powershell
# Windows PowerShell
npm.cmd run db:migrate
npm.cmd run dev
```

```bash
# Linux / macOS
npm run db:migrate
npm run dev
```

Open <http://127.0.0.1:3000/>. On an empty user table, sign in once with the
`APP_ID` and `APP_SECRET` from `app/.env`, then choose a username and a new
password. Every later login is verified against MySQL; the bootstrap credentials
are no longer accepted. Usernames are encrypted at rest and passwords are stored
only as salted scrypt hashes. Production deployments must also keep the
independent `APP_DATA_SECRET` stable.

## Platform Setup Tutorials

The following paths produce the same development environment. Install Node from
the official LTS downloads or a version manager, then verify `node --version`
is `20.19+` or `22.12+`; Vite enforces that range. MySQL 8.4 is the tested
database version. Use the official [Node/npm installation guide](https://docs.npmjs.com/downloading-and-installing-node-js-and-npm)
and [MySQL installation guide](https://dev.mysql.com/doc/refman/8.0/en/installing.html)
when your platform requires a different installation method.

### Windows 10/11 (PowerShell)

1. Install Git for Windows, Node LTS, and MySQL 8.4 using their installers. In
   MySQL Installer, keep the server configured as a Windows service.
2. Open a new PowerShell window and verify `git --version`, `node --version`,
   and `mysql --version`. If PowerShell blocks `npm.ps1`, use `npm.cmd` and
   `npx.cmd`; do not weaken the machine execution policy.
3. Create the database and application account with the SQL below, then clone,
   configure, migrate, and start:

```powershell
git clone git@github.com:Jiusi-pys/ebooks.git
Set-Location ebooks\app
npm.cmd ci
Copy-Item .env.example .env
# Edit .env, then:
npm.cmd run db:migrate
npm.cmd run dev
```

### Ubuntu/Debian Linux

1. Install a supported Node release through a version manager or the official
   Node distribution. If the distribution package does not provide MySQL 8.4,
   use Oracle's MySQL APT repository instead of treating MariaDB as the tested
   replacement.
2. Start MySQL with systemd and confirm both versions:

```bash
sudo systemctl enable --now mysql
node --version
mysql --version
```

3. Create the database/account below, then run:

```bash
git clone git@github.com:Jiusi-pys/ebooks.git
cd ebooks/app
npm ci
cp .env.example .env
# Edit .env, then:
npm run db:migrate
npm run dev
```

### macOS (Homebrew)

Install Node 22 and the tested MySQL series, start the database service, and
then use the same clone/configure/migrate steps. Homebrew publishes a
[`mysql@8.4` formula](https://formulae.brew.sh/formula/mysql@8.4); use its
current instructions if formula names change.

```bash
brew install node@22 mysql@8.4
brew services start mysql@8.4
node --version
mysql --version
git clone git@github.com:Jiusi-pys/ebooks.git
cd ebooks/app
npm ci
cp .env.example .env
# Edit .env, then:
npm run db:migrate
npm run dev
```

After `npm run dev`, open <http://127.0.0.1:3000/>. The Vite development server
also mounts the Hono API, so the browser UI and `/api/*` use this single origin.

## MySQL Setup

Start MySQL using your normal service manager, then connect as an administrator
and create an application database and user. The host in the MySQL account must
match the host used in `DATABASE_URL`.

```sql
CREATE DATABASE shufang
  CHARACTER SET utf8mb4
  COLLATE utf8mb4_0900_ai_ci;
CREATE USER 'shufang'@'127.0.0.1'
  IDENTIFIED BY 'replace-with-a-long-random-password';
GRANT ALL PRIVILEGES ON shufang.* TO 'shufang'@'127.0.0.1';
```

Set the server's `max_allowed_packet` to `256M` so large extracted-book mirrors
can be promoted safely. Add this under `[mysqld]` in the server configuration,
restart MySQL, and verify the effective value:

```ini
[mysqld]
max_allowed_packet=256M
```

```sql
SHOW VARIABLES LIKE 'max_allowed_packet';
```

Common configuration locations include MySQL's `my.ini` under
`C:\ProgramData\MySQL\` on Windows, `/etc/mysql/` on Linux, and the Homebrew
MySQL configuration directory on macOS. The exact service name and path depend
on the installation method.

Before updating an existing installation, back up the database and always run
`npm run db:migrate` rather than `db:push`. The committed migration sequence is
forward-only through `0013_confused_amphibian`. Migration 0013 adds
`mirror_books.reader_data`, `mirror_books.source_manifest`, and
`library_source_chunks` for reading state and original files. The migration
runner skips migrations already recorded as applied.

## Environment Configuration

Edit `app/.env`; never commit it. URL-encode special characters in the database
password before putting them in `DATABASE_URL`.

```dotenv
APP_ID=reader
APP_SECRET=replace-with-at-least-32-random-bytes
APP_DATA_SECRET=replace-with-an-independent-32-byte-secret
APP_SESSION_SECRET=replace-with-an-independent-32-byte-secret
HOST=127.0.0.1
PORT=3000
PUBLIC_ORIGIN=
SESSION_TTL_SECONDS=43200
SESSION_COOKIE_SECURE=false
OPEN_API_KEY=replace-with-a-separate-machine-client-key

DATABASE_URL=mysql://shufang:encoded-password@127.0.0.1:3306/shufang

CODEX_BIN=codex
CODEX_MODEL=gpt-5.6-terra
CODEX_REASONING_EFFORT=medium
CODEX_TIMEOUT_MS=180000
CODEX_LOGIN_TIMEOUT_MS=300000

DEEPSEEK_API_KEY=
DEEPSEEK_TIMEOUT_MS=180000
```

Generate a suitable `APP_SECRET` with one of these commands:

```powershell
# Windows PowerShell
[Convert]::ToHexString(
  [Security.Cryptography.RandomNumberGenerator]::GetBytes(32)
).ToLower()
```

```bash
# Linux / macOS
openssl rand -hex 32
```

| Variable                | Purpose                                                                    |
| ----------------------- | -------------------------------------------------------------------------- |
| `APP_ID`                | One-time bootstrap login name; needed only while `app_users` is empty      |
| `APP_SECRET`            | One-time bootstrap password; not used for new username encryption          |
| `APP_DATA_SECRET`       | Independent username-encryption key (minimum 32 bytes)                     |
| `APP_SESSION_SECRET`    | Independent session-signing key (minimum 32 bytes); optional for local use |
| `DATABASE_URL`          | MySQL connection URI; required in production and by Drizzle commands       |
| `HOST` / `PORT`         | Production bind address and port; defaults to `127.0.0.1:3000`             |
| `PUBLIC_ORIGIN`         | Exact external origin behind a trusted TLS proxy, with no path             |
| `SESSION_TTL_SECONDS`   | Session lifetime, clamped to 300–604800 seconds                            |
| `SESSION_COOKIE_SECURE` | Force the session cookie's `Secure` flag                                   |
| `OPEN_API_KEY`          | Owner key for machine APIs and v2 credential issuance; distinct from node tokens |
| `SYNC_ENABLED`          | Enable v2 workspace replication (`false` by default) |
| `SYNC_WORKSPACE_ID`     | Same workspace ID on paired servers |
| `SYNC_NODE_ID`          | Stable, unique identity for this database; different on each server |
| `SYNC_BLOB_DIR`         | Persistent SHA-256 file directory; include in backups |
| `SYNC_PEERS_JSON`       | Array of target `{id,url,token}` objects; `[]` for passive cloud nodes |
| `AUTO_UPDATE_*`         | Optional daily Git updater; keep disabled during controlled migrations |
| `CODEX_*`               | Codex executable, default model/effort, and timeouts                       |
| `DEEPSEEK_*`            | Optional DeepSeek key and timeout                                          |

Keep `HOST=127.0.0.1` for a single-machine installation. If TLS terminates at a
reverse proxy, set `PUBLIC_ORIGIN` to the browser-visible origin, for example
`https://books.example.com`, and enable secure cookies. The application does not
trust client-supplied `X-Forwarded-*` headers for origin validation.

When `APP_DATA_SECRET` or `APP_SESSION_SECRET` is blank, the server generates a
strong key in `app/.runtime/data-secret` or `app/.runtime/session-secret` and
reuses it on later starts. Persist or back up both ignored files. Losing the
session key signs users out; losing the data key after account migration makes
the encrypted username unrecoverable. Production and container deployments
should configure both values explicitly or mount the entire `.runtime`
directory on durable storage. Values shorter than 32 bytes are rejected.

Upgrading an existing installation: keep the old `APP_SECRET`, configure and
persist `APP_DATA_SECRET`, restart, then sign out and sign in once. A successful
database login automatically re-encrypts the username with the new data key;
after that migration, the bootstrap secret may be rotated or removed. Keep
`OPEN_API_KEY` separate from login credentials. When blank, owner-key machine
access is disabled; already-issued workspace node tokens remain independent.

## HTTPS Workspace Sync: Configure URL, Obtain ID and Token

Windows can push and pull through the cloud's public HTTPS API. It does not need
a public address or an incoming connection. The cloud may keep
`SYNC_PEERS_JSON=[]`; an empty cloud peer-status object is expected in this mode.
SSH tunnels are unnecessary. Webhooks are not currently implemented; periodic
REST exchange also recovers changes missed while either node was offline.

### 1. Configure the two nodes

Example cloud environment (persist the database and file directory):

```dotenv
SYNC_ENABLED=true
SYNC_WORKSPACE_ID=personal-workspace
SYNC_NODE_ID=linux-personal
SYNC_BLOB_DIR=/app/.runtime/blobs/personal-workspace
SYNC_PEERS_JSON=[]
OPEN_API_KEY=<independent-long-random-owner-key>
AUTO_UPDATE_ENABLED=false
```

Example Windows `app/.env`, before pairing:

```dotenv
SYNC_ENABLED=true
SYNC_WORKSPACE_ID=personal-workspace
SYNC_NODE_ID=windows-personal
SYNC_BLOB_DIR=.runtime/production/blobs
SYNC_PEERS_JSON=[]
AUTO_UPDATE_ENABLED=false
```

Keep the existing database, login, and encryption configuration. Apply migrations
and restart after changing environment variables. Both servers must use the same
workspace, with different stable node IDs. Do not rename an existing database's
node/workspace to turn it into a new replica. The cloud owner configures
`OPEN_API_KEY` in its protected environment (currently `/opt/shufang/.env.sync`
on `us.jiusi.org`); it cannot be retrieved through an API. If absent, set it and
restart the cloud first. It is separate from the account password and `APP_SECRET`.

### 2. Obtain the target ID and issue a token

| Value | Where to obtain it | Where to use it |
| --- | --- | --- |
| Target node ID | `GET /api/v2/capabilities` → `nodeId` | `SYNC_PEERS_JSON[].id` |
| Workspace ID | Same response → `workspaceId` | Matching `SYNC_WORKSPACE_ID` and request header |
| Credential label | Chosen in `POST /api/v2/peers` → `id` | Later credential revocation; **not** the target node ID |
| Node token | `POST /api/v2/peers` → `token` | `SYNC_PEERS_JSON[].token` and bearer authentication |

Run the following in PowerShell from `app/`, after configuring the local
environment above. Enter the **target cloud's owner key** when prompted. This
creates a fresh credential, checks it, and updates only `SYNC_PEERS_JSON` in
the local `.env`. It does not print the key or token. Keep the displayed
credential label for revocation. Pairing replaces the local peer list with this
single target; preserve additional peers separately if you use more than one.

```powershell
$ErrorActionPreference = "Stop"
$remote = "https://us.jiusi.org".TrimEnd('/')
$envPath = (Resolve-Path -LiteralPath .env).Path
$secureKey = Read-Host "Target server OPEN_API_KEY" -AsSecureString
$ownerKey = [Net.NetworkCredential]::new("", $secureKey).Password
$ownerHeaders = @{ "X-API-Key" = $ownerKey }
$caps = Invoke-RestMethod "$remote/api/v2/capabilities" `
  -Headers $ownerHeaders -MaximumRedirection 0 -TimeoutSec 30
if ($caps.version -ne 2) { throw "Target must support protocol v2" }
$workspaceLine = @(Get-Content -LiteralPath $envPath -Encoding UTF8 | Where-Object {
  $_ -match '^\s*SYNC_WORKSPACE_ID\s*='
})
if ($workspaceLine.Count -ne 1) { throw "Set one SYNC_WORKSPACE_ID in .env first" }
$localWorkspace = ($workspaceLine[0] -split '=', 2)[1].Trim().Trim('"').Trim("'")
if ($localWorkspace -ne $caps.workspaceId) {
  throw "Workspace mismatch: target is $($caps.workspaceId); inspect configuration first"
}
$credentialId = "windows-pair-" + [Guid]::NewGuid().ToString("N")
$body = @{ id = $credentialId } | ConvertTo-Json -Compress
$issued = Invoke-RestMethod "$remote/api/v2/peers" -Method Post `
  -Headers $ownerHeaders -ContentType "application/json" -Body $body `
  -MaximumRedirection 0 -TimeoutSec 30
$nodeHeaders = @{
  Authorization = "Bearer $($issued.token)"
  "X-Workspace-Id" = $caps.workspaceId
}
$verified = Invoke-RestMethod "$remote/api/v2/capabilities" `
  -Headers $nodeHeaders -MaximumRedirection 0 -TimeoutSec 30
if ($verified.nodeId -ne $caps.nodeId) { throw "Target identity changed" }
$peerJson = ConvertTo-Json -InputObject @(@{
  id = $caps.nodeId; url = $remote; token = $issued.token
}) -Compress
$lines = @(Get-Content -LiteralPath $envPath -Encoding UTF8 | Where-Object {
  $_ -notmatch '^\s*SYNC_PEERS_JSON\s*='
})
[IO.File]::WriteAllLines($envPath,
  [string[]]($lines + "SYNC_PEERS_JSON=$peerJson"),
  [Text.UTF8Encoding]::new($false))
Write-Host "Target: $($caps.nodeId); workspace: $($caps.workspaceId)"
Write-Host "Credential label (save for revocation): $credentialId"
Remove-Variable secureKey, ownerKey, ownerHeaders, issued, nodeHeaders, peerJson
```

The resulting setting has this shape (use actual values from the API):

```dotenv
SYNC_PEERS_JSON=[{"id":"linux-personal","url":"https://us.jiusi.org","token":"<issued-token>"}]
```

Use the server root URL, without `/api/v2`, a query, or a fragment. Keep `.env`
private and out of Git. The server stores only a token digest: plaintext is
returned at issuance, not through a later retrieval endpoint. If lost, issue a
fresh credential and revoke the old one. Reissuing the **same credential label**
replaces its token immediately; fresh labels avoid interrupting existing peers.

Restart the local service to load the setting. For the native Windows deployment,
after stopping its existing Node process and with `dist/` built:

```powershell
powershell -File scripts/start-sync-windows.ps1 -EnvFile .env
```

Do not start a second process on port 3000. Keep Node and MySQL running.

### 3. Check synchronization, replace a server, or revoke access

Open **应用设置 → 同步与离线书籍** on both browsers. The Windows peer should show
recent success without errors. Authenticated `GET /api/v2/status` reports node,
workspace, sequence, and outgoing peer state. Equal sequence numbers alone do
not prove data equality: create a small item on each side and confirm it appears
on the other, then check file availability separately. See the dated
[HTTPS acceptance report](app/docs/sync-https-acceptance.md) for real two-node
results, and [the synchronization guide](app/docs/workspace-sync.md) for protocol,
backup, and recovery details.

To change only the hostname of the same server/database, update the peer `url`
in `.env` and restart Windows. For a replacement node, configure its persistent
storage and workspace first, then repeat pairing against its HTTPS URL to obtain
its actual node ID and a new token. Preserve the previous database and files
until the new replica has caught up; changing a URL alone does not migrate data.

To revoke a credential, authenticate with the target's owner key and use the
**credential label saved above**, not `linux-personal`:

```powershell
$remote = "https://us.jiusi.org"
$credentialId = Read-Host "Credential label to revoke"
$secureKey = Read-Host "Target server OPEN_API_KEY" -AsSecureString
$ownerHeaders = @{ "X-API-Key" = [Net.NetworkCredential]::new("", $secureKey).Password }
$escapedId = [Uri]::EscapeDataString($credentialId)
Invoke-RestMethod "$remote/api/v2/peers/$escapedId" -Method Delete `
  -Headers $ownerHeaders -MaximumRedirection 0 -TimeoutSec 30
Remove-Variable secureKey, ownerHeaders
```

Revoked tokens receive `401`; the affected sender needs a fresh token and restart.
Owner-only pairing rejects node-token credentials. An incorrect workspace header
also rejects node access. If a pairing command fails after issuance, revoke its
new credential label before retrying to avoid leaving unused credentials active.

## Codex with ChatGPT Login (No OpenAI API Key)

Install the Codex CLI for the same operating-system user that runs Shufang. npm
works on all supported systems:

```powershell
# Windows PowerShell
npm.cmd install -g @openai/codex
codex login
codex login status
```

```bash
# Linux / macOS
npm install -g @openai/codex
codex login
codex login status
```

Complete the browser flow using **Sign in with ChatGPT**. A headless machine can
use `codex login --device-auth`. The application calls `codex exec`, accepts only
a ChatGPT-authenticated session, and rejects API-key authentication to avoid
OpenAI API billing. It does not copy `auth.json`: the CLI resolves its own cached
credentials. See the official [Codex CLI guide](https://learn.chatgpt.com/docs/codex/cli)
and [authentication guide](https://learn.chatgpt.com/docs/auth).

Each reading request runs in a temporary directory with an ephemeral,
read-only Codex session. Shell, web, browser, plugin, memory, and other unrelated
tools are disabled, and application/API secrets are removed from the child
environment. The defaults are `gpt-5.6-terra` and `medium`; the AI settings panel
can select the other model/effort values supported by this build.

## Optional DeepSeek Provider

DeepSeek is separate from the no-API-key Codex path and uses DeepSeek API
billing. Either set `DEEPSEEK_API_KEY` on the server or enter a key in AI
settings; a UI-entered key is kept only in browser `sessionStorage`. The current
build exposes:

- Models: `deepseek-v4-flash`, `deepseek-v4-pro`,
  `deepseek-v4-flash-vision-exp`
- Effort: `none`, `low`, `high`, `max`

The current adapter sends text messages only, including when the selected model
name contains `vision`.

Use **Test connection** in AI settings before running translation, chat, mind-map
generation, or AI card creation.

## Production Start

Run migrations before each deployment, then build and start the combined static
frontend and Hono server:

```powershell
# Windows PowerShell
npm.cmd run db:migrate
npm.cmd run build
npm.cmd run start
```

```bash
# Linux / macOS
npm run db:migrate
npm run build
npm run start
```

`npm run start` sets `NODE_ENV=production` cross-platform. Production startup
fails fast when `DATABASE_URL` is missing. `APP_ID` and `APP_SECRET` are also
needed only for the first login while the user table is empty.

### Server administrator installation and updates

Administrators do not need Codex or Claude Code. Install Git, Node.js 22.13+
and MySQL on the server, then clone this repository and configure `app/.env`.
The file contains deployment-specific secrets and must never be committed or
replaced by Git.

```bash
git clone https://github.com/Jiusi-pys/ebooks.git shufang
cd shufang/app
cp .env.example .env
# Edit .env: DATABASE_URL, APP_DATA_SECRET, APP_SESSION_SECRET, PUBLIC_ORIGIN, …
npm ci
npm run db:migrate
npm run build
```

To update an existing server, first back up its MySQL database. Keep the
existing `app/.env` and, when secrets are not configured through environment
variables, keep the persistent `app/.runtime/` directory. Then run:

```bash
cd /srv/shufang
git pull --ff-only origin main
cd app
npm ci
npm run db:migrate
npm run build
```

Restart the process using the same supervisor that runs the deployment. For
example:

```bash
# systemd: replace shufang with the actual service name
sudo systemctl restart shufang
sudo systemctl status shufang

# PM2
pm2 restart shufang
```

For Docker deployments, rebuild the image and recreate the container using the
existing `--env-file app/.env` and persistent database configuration. Do not
use `db:push` for production upgrades; `npm run db:migrate` records completed
migrations and applies only the pending ones. After the server restarts, users
only need to refresh the browser; their MySQL-backed books and accounts remain
in place.

### Optional container build

The image deliberately does not contain `.env` or Codex credentials:

```bash
docker build -t shufang ./app
docker run --rm --name shufang \
  -p 127.0.0.1:3000:3000 \
  --env-file app/.env \
  -v shufang-runtime:/app/.runtime \
  -e HOST=0.0.0.0 \
  shufang
```

Keep `SYNC_BLOB_DIR` under `/app/.runtime` to persist files in the named volume.
Back up that volume together with MySQL; neither alone is a complete workspace.
`DATABASE_URL` must point to a MySQL address reachable from the container
(`host.docker.internal` is commonly available with Docker Desktop). The image
does not install Codex or copy its credential store. Prefer the local Node.js
start path for ChatGPT-login Codex, or deliberately provision the CLI and its
credential store at runtime without baking credentials into the image.

## Open API

`GET /api/v2/openapi.json` exposes the authenticated workspace-sync contract;
a checked-in copy is [available here](app/docs/openapi-v2.json). See the pairing
section above for owner versus node credentials. `/api/v1` and `/api/library`
remain compatibility endpoints and use the unified store when v2 is enabled.

`GET /api/v1/` returns the legacy machine-readable endpoint directory. All resource
routes require either `X-API-Key: <OPEN_API_KEY>` or
`Authorization: Bearer <OPEN_API_KEY>`. The API covers books and chapters,
highlights, review cards, associations, notes, folders, translations, mind maps,
events, and webhooks. Browser event writes may instead use the signed application
session and same-origin checks.
If `OPEN_API_KEY` is blank, machine access is disabled rather than falling back
to `APP_SECRET`.

## Supported-file Limits

- PDF, EPUB, MOBI/AZW/AZW3, and FB2: 128 MiB per file.
- TXT: 64 MiB per file with automatic UTF-8, UTF-16, and common Chinese encoding
  detection.
- PDFs over 600 pages remain available in original-layout mode but do not get a
  potentially incomplete reflow copy.
- DRM-protected Kindle files and KFX are unsupported.
- The server mirror has a 96 MiB encoded upload limit and uses resumable chunks.
- The original-file endpoint supports up to 256 MiB in 256 KiB chunks; browser
  import limits above still apply.

## Quality Checks

Run these before committing:

```bash
npm run check
npm test
npm run lint
npm run build
npx drizzle-kit check
```

Vitest covers backend API behavior and browser-side storage/parser utilities.
For real-database coverage, run `npm run test:mysql` against a migrated test
database with `DATABASE_URL` and `OPEN_API_KEY` configured. These tests create
and clean up their own records, including original-file upload/download checks.
See [`AGENTS.md`](AGENTS.md) for contributor conventions.

## Troubleshooting

- **Changes are missing on the other node:** open **应用设置 → 同步与离线书籍**,
  finish browser pending work, and check the peer error/last-success time. Confirm
  the target URL, workspace, node ID, and token; restart the Node process after
  changing `.env`. Passive cloud `peers={}` is expected. Compare actual records
  and files on both nodes; matching sequence counts alone are not proof.
- **IndexedDB object store not found:** refresh to load the v10 repair migration;
  close older tabs if they block the upgrade. Do not clear browser storage: it may
  contain the only copy of unsent edits or original files.

- **PowerShell blocks `npm.ps1`:** use `npm.cmd` and `npx.cmd`; no execution-policy
  change is required.
- **The login page says authentication is not configured:** populate `APP_ID`
  and `APP_SECRET`, then restart the server.
- **Migration or mirror connection fails:** confirm that MySQL is running, the
  account host matches `DATABASE_URL`, and the password is URL-encoded.
- **Codex is available but rejected:** run `codex login status`. If it reports an
  API key, run `codex logout` and sign in again with ChatGPT.
- **Mutation requests return 403 behind a proxy:** configure the exact HTTPS
  `PUBLIC_ORIGIN` and restart Shufang.
- **Port 3000 is occupied:** stop the existing process or set another `PORT` for
  the production server. For development, use `npm run dev -- --port 3001`.
