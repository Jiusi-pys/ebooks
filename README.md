# Shufang (書房)

[简体中文](README_zh.md)

Shufang is a local-first reading and book-management workspace inspired by the
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
- Keep local IndexedDB and the optional MySQL mirror consistent across book,
  note, highlight, citation, association, and digest deletion. Event receipts,
  tombstones, transactional citation cleanup, and forward-only migrations make
  late browser events safe to retry.
- Create editable mind maps, review cards, and spaced-repetition queues.
- Use Codex through a local ChatGPT login, or select the optional DeepSeek API
  provider from the AI settings panel.
- Pin or auto-hide both reading sidebars; immersive mode hides both sidebars
  and the reader toolbar. Manage the MySQL-backed local username and password
  from the account panel.

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

Browser IndexedDB is the primary store. Original PDFs are retained there for
original-layout rendering; reflowable formats are stored as parsed chapters
rather than as their source file. When MySQL is configured, extracted metadata,
chapter text, annotations, relationships, translations, mind maps, and event
receipts are mirrored to the server for AI and machine clients. Original files
are not uploaded by the normal browser import flow.

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
forward-only through `0012_add_highlight_name`; it includes reconciliation for
older mirror data and can be run repeatedly safely.

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
| `OPEN_API_KEY`          | Key for `/api/v1/*` machine clients; blank disables the machine API        |
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
`OPEN_API_KEY` separate from login credentials; when blank, protected machine
routes return `503` and remain disabled.

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

### Optional container build

The image deliberately does not contain `.env` or Codex credentials:

```bash
docker build -t shufang ./app
docker run --rm --name shufang \
  -p 127.0.0.1:3000:3000 \
  --env-file app/.env \
  -e HOST=0.0.0.0 \
  shufang
```

`DATABASE_URL` must point to a MySQL address reachable from the container
(`host.docker.internal` is commonly available with Docker Desktop). The image
does not install Codex or copy its credential store. Prefer the local Node.js
start path for ChatGPT-login Codex, or deliberately provision the CLI and its
credential store at runtime without baking credentials into the image.

## Open API

`GET /api/v1/` returns the machine-readable endpoint directory. All resource
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
See [`AGENTS.md`](AGENTS.md) for contributor conventions.

## Troubleshooting

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
