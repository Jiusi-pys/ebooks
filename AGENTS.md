> 当前状态（2026-10-03）：见[工程状态与验收门槛](docs/current-status.md)。本文件中的日期/版本记录保留其历史范围；当前迁移为 MySQL 0014 / SQLite 0003 / IndexedDB 11，生产尚未正式切换。

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

Vitest covers backend and frontend modules; UI tests select jsdom where needed. Every backend behavior change must add focused tests near the module it covers. Exercise success, validation failure, and database/error paths. Before submitting, run `npm run check`, `npm run lint`, `npm test`, and `npm run build`. Deployment supervisor tests run from the repository root with `python -m unittest discover -s deploy -p 'test_*.py'`.

## 数据库迁移硬性规定（多端异步升级）

本项目部署于多个独立节点，客户端和服务器可能跨多个版本异步更新。以下规则为强制发布门槛：

1. **先设计迁移，再改数据库。** 每次涉及 MySQL schema、数据格式、约束、索引、数据回填或浏览器 IndexedDB 结构的设计，必须同时给出版本化迁移脚本或升级步骤、旧版本起点、执行顺序、兼容范围、数据备份与失败恢复方案。不得仅修改 schema 后依靠手工 SQL 或生产 `db:push` 完成升级。
2. **历史迁移不可变，只能追加。** 完整保留 `app/db/migrations/` 的全部 SQL、`meta/_journal.json` 历史条目及快照；禁止删除、覆盖、重新编号、重排或 squash 已发布迁移。修复旧迁移产生的问题时追加新的向前修复迁移。IndexedDB 已发布升级分支也必须保留，支持从任意仍受支持的旧版本顺序升级。
3. **保留独立历史备份。** 每次新增迁移时，在 `app/db/migration-history/` 新增截至该版本的完整迁移归档与 SHA-256 校验清单，注明来源提交、覆盖版本及恢复方式；既有归档不得覆盖或删除。发布镜像必须携带完整可执行迁移链，发布记录须关联历史备份。迁移脚本备份不等同于数据库及原文件的数据备份，两者均需安排。
4. **一次更新补齐所有中间版本。** 更新器根据本节点已应用版本，按序执行全部尚未执行的迁移；不得只执行最新版脚本，也不得要求用户逐版安装应用。重复运行应跳过已成功记录的迁移；失败不得误记成功或启动依赖未完成迁移的新程序。MySQL DDL 可能部分生效，必须设计并验证失败恢复路径。
5. **跨版本验证是发布前置条件。** 数据库变更必须测试空库初始化、上一版本升级、至少一个跨多个版本的旧库一次升级、重复执行、失败恢复和数据保留。IndexedDB 有变更时同样测试跳版本升级及原记录保留。使用隔离测试库/客户端，不得把生产书库作为破坏性迁移测试环境；未完成这些验证不得宣称迁移已验收。
6. **保证混合版本兼容。** 优先采用先扩展、后迁移、最后清理的分阶段方案；删除或重命名字段、收紧约束等破坏性修改必须说明旧节点兼容窗口、同步协议影响及维护步骤。容器回滚不能撤销数据库迁移，禁止将程序回滚表述成数据库回滚。
7. **文档随版本更新。** 同步更新迁移说明、部署/恢复文档与验收记录，明确最新迁移版本、支持的升级起点、归档位置、实际验证结果和未验证限制；代码、迁移、备份和文档必须在同一发布中交付。

迁移源文件遵循 `.gitattributes` 使用 LF 换行，避免 Windows/Linux 产生不同的执行哈希；遇到历史 CRLF/LF 差异时保留原文件及证据，不得改写数据库迁移账本掩盖差异。

## Commit & Pull Request Guidelines

Use short, imperative subjects, optionally scoped, such as `feat(reader): add citation navigation`. Keep commits focused. Pull requests should explain behavior and schema changes, list verification commands, link relevant issues, and include screenshots or recordings for UI changes. Never commit `.env`, credentials, uploaded books, or generated build output. Migration history archives required above are versioned source backups, not build output.
