# Repository Guidelines

## Project Structure & Module Organization

The application lives in `app/`. Frontend React code is under `app/src/`: pages compose screens, `components/` contains feature and reusable UI components, `hooks/` holds React hooks, and `lib/` contains parsing, reading, and storage utilities. The Hono/tRPC backend is in `app/api/`; shared request and error contracts belong in `app/contracts/`. Drizzle schema, relations, and seed logic are under `app/db/`. Static files, including the PDF.js worker, live in `app/public/`. Treat `app/dist/` and `app/node_modules/` as generated content.

## Build, Test, and Development Commands

Run commands from `app/` after `npm ci`.

- `npm run dev` starts the Vite frontend and Hono API on port 3000.
- `npm run check` runs strict TypeScript project checks without emitting files.
- `npm run lint` checks TypeScript, React Hooks, and Vite refresh rules.
- `npm test` runs the Vitest suite once.
- `npm run build` produces the browser bundle and Node server in `dist/`.
- `npm run format` applies the repository Prettier configuration.
- `npm run db:generate` creates Drizzle migrations; `npm run db:migrate` applies them.

Copy `.env.example` to `.env` for local configuration. Production requires `APP_ID`, `APP_SECRET`, and a MySQL `DATABASE_URL`.

## Coding Style & Naming Conventions

Use TypeScript with strict typing and 2-space indentation. Prettier enforces double quotes, semicolons, trailing ES5 commas, 80-column lines, and LF endings. Use `PascalCase` for React components and exported types, `camelCase` for functions and hooks (`useLibrary`), and descriptive lowercase filenames for utilities. Prefer configured aliases such as `@/`, `@contracts/`, and `@db/` over long relative imports.

## Testing Guidelines

Vitest uses a Node environment and discovers `api/**/*.test.ts` and `api/**/*.spec.ts`. No tests are currently checked in, so every backend behavior change should add focused tests near the module it covers. Exercise success, validation failure, and database/error paths. Before submitting, run `npm run check`, `npm run lint`, `npm test`, and `npm run build`.

## Commit & Pull Request Guidelines

Git history is not included in this workspace, so no existing commit convention can be verified. Use short, imperative subjects, optionally scoped, such as `feat(reader): add citation navigation`. Keep commits focused. Pull requests should explain behavior and schema changes, list verification commands, link relevant issues, and include screenshots or recordings for UI changes. Never commit `.env`, credentials, uploaded books, or generated build output.
