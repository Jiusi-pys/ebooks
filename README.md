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
- Highlight, annotate, tag, create cloze deletions, and cite at book, chapter,
  or exact-passage level.
- Link precise passages across books with directional or bidirectional
  associations and inspect the resulting graph.
- Organize storage folders separately from logical study sets; customize folder
  icons, book covers, outlines, and reader typography.
- Create editable mind maps, review cards, and spaced-repetition queues.
- Use Codex through a local ChatGPT login, or select the optional DeepSeek API
  provider from the AI settings panel.

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

Open <http://127.0.0.1:3000/> and sign in with the `APP_ID` and `APP_SECRET`
from `app/.env`.

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

## Environment Configuration

Edit `app/.env`; never commit it. URL-encode special characters in the database
password before putting them in `DATABASE_URL`.

```dotenv
APP_ID=reader
APP_SECRET=replace-with-at-least-32-random-bytes
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
| `APP_ID`                | Local browser login name; required in production                           |
| `APP_SECRET`            | Login password and HMAC session-signing secret; required in production     |
| `DATABASE_URL`          | MySQL connection URI; required in production and by Drizzle commands       |
| `HOST` / `PORT`         | Production bind address and port; defaults to `127.0.0.1:3000`             |
| `PUBLIC_ORIGIN`         | Exact external origin behind a trusted TLS proxy, with no path             |
| `SESSION_TTL_SECONDS`   | Session lifetime, clamped to 300–604800 seconds                            |
| `SESSION_COOKIE_SECURE` | Force the session cookie's `Secure` flag                                   |
| `OPEN_API_KEY`          | Key for `/api/v1/*` machine clients; falls back to `APP_SECRET` when blank |
| `CODEX_*`               | Codex executable, default model/effort, and timeouts                       |
| `DEEPSEEK_*`            | Optional DeepSeek key and timeout                                          |

Keep `HOST=127.0.0.1` for a single-machine installation. If TLS terminates at a
reverse proxy, set `PUBLIC_ORIGIN` to the browser-visible origin, for example
`https://books.example.com`, and enable secure cookies. The application does not
trust client-supplied `X-Forwarded-*` headers for origin validation.

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
fails fast when `APP_ID`, `APP_SECRET`, or `DATABASE_URL` is missing.

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
