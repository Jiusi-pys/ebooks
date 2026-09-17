# Application development notes

The maintained setup and deployment guides are [app README](README.md),
[English README](../README.md), and [中文 README](../README_zh.md).

- Runtime: Node.js 22.13+ and MySQL 8.4; Windows, Linux, and macOS are supported.
- Frontend: React 19, TypeScript, Vite 7, Tailwind CSS 3, and Radix UI components.
- Backend: Hono, tRPC, Drizzle ORM, and MySQL. Browser library requests use authenticated sessions.
- Book metadata, chapters, originals, covers, outlines, and reading state persist in MySQL; IndexedDB caches them locally.
- The library offers a manual “同步到 MySQL” action with confirmed success or retry feedback.

## Source layout

- `src/components/`: library, readers, and reusable UI.
- `src/hooks/`: application state and React hooks.
- `src/lib/`: parsers, IndexedDB cache, and library synchronization.
- `src/types/`: shared frontend types.
- `api/`: Hono/tRPC routes, authentication, and server utilities.
- `contracts/`: request and error contracts.
- `db/`: Drizzle schemas and committed migrations.
- `public/`: static assets, including the PDF worker.

Run `npm run check`, `npm run lint`, `npm test`, and `npm run build` from this directory.
Use `npm run test:mysql` for the configured MySQL integration suite.
Do not edit or commit generated `dist/` output, `.env`, credentials, or uploaded books.
