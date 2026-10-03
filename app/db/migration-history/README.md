> 当前状态（2026-10-03）：见[工程状态与验收门槛](../../../docs/current-status.md)。本文件中的日期/版本记录保留其历史范围；当前迁移为 MySQL 0014 / SQLite 0003 / IndexedDB 11，生产尚未正式切换。

# 历史迁移备份（不可变）

这里保存完整迁移源文件的独立归档，不参与运行时迁移扫描。实际执行目录仍为
`app/db/migrations/`。保留旧归档；新增迁移时追加新归档和清单，不能覆盖旧文件。

## 当前基线

- `20261003-through-mysql0014-sqlite0001.tar.gz`：完整保留 MySQL
  `0000–0014` 及 meta，并加入新建原生 SQLite `0001`，共 33 个文件。
  对应 manifest 标注来源提交及未提交的新 SQLite 源文件，逐文件和归档
  SHA-256 均已校验。SQLite 升级与数据恢复步骤见
  `docs/native-core-migration.md`；这不代表跨端同步或 MySQL 升级已重新验收。
- `20260927-through-0014.tar.gz`：从 `0000` 到 `0014_workspace_sync` 的
  15 个 SQL、15 个 schema 快照、journal 和 `.gitkeep`，共 32 个文件。
- 对应 `.manifest.json` 记录来源提交、归档 SHA-256 及每个文件的 SHA-256。
- 内容取自来源提交的 Git blob（仓库规范内容），不受 Windows 工作区 CRLF
  转换影响。归档无数据库内容、账号或环境配置。
- 已验证归档条目数量及每个文件的 SHA-256 与清单一致。

## 校验与恢复

1. 用 `sha256sum`（Linux）或 `Get-FileHash -Algorithm SHA256`（PowerShell）
   对照清单的 `archiveSha256`。
2. 将归档解压到新建的临时目录；文件路径以 `app/db/migrations/` 开头。
3. 对照清单逐文件核验 SHA-256，再与目标发布的迁移链比较。
4. 只有丢失/损坏的迁移源文件才从归档恢复；不得用旧归档覆盖新增迁移。
   将恢复的完整迁移链随应用构建发布，再执行迁移入口。

该备份不能恢复数据库业务数据，也不能撤销 DDL；实际升级前另行备份数据库、
原文件与节点配置。历史迁移是否能从某个旧库顺利升级，必须通过隔离数据库验证，
不能以归档校验通过代替跨版本升级验收。

## 一次跨多版本升级

目标版本须携带全部历史 SQL 与 journal。MySQL 迁移入口为
`npm run db:migrate` / 发布镜像内 `node dist/migrate.js`，按 journal 顺序补齐
尚未记录的迁移。不要逐版安装应用，不要只复制最新一个 SQL，不要对生产使用
`db:push`。IndexedDB 则保留版本化 upgrade 分支，在打开新版数据库时补齐升级。

完整强制约束见仓库根目录 `AGENTS.md` 的“数据库迁移硬性规定”。

## Native SQLite 0002 archive (2026-10-03)

`20261003-through-mysql0014-sqlite0002.tar.gz` preserves 34 files: the unchanged
32-file MySQL 0000–0014 chain and native SQLite 0001/0002. Its manifest records
source HEAD, each source hash and the archive hash. Both the archive bytes and
all extracted/live files were verified on Windows. The 0001 archive remains
unchanged. Native migration tests cover 0→2, 1→2 retention, repeat opens, failed
step rollback/retry, checksum and future-version rejection. No MySQL or IndexedDB
schema change is part of this Windows phase. See `docs/windows-delivery.md`.

## Native SQLite 0003 archive (2026-10-03)

`20261003-through-mysql0014-sqlite0003.tar.gz` and its immutable manifest
preserve 35 files: the complete unchanged MySQL 0000–0014 chain and native
SQLite 0001–0003. Archive and extracted/live hashes were rechecked. Tests cover
empty initialization, 0002→0003, 0001→0003 in one open, repeated execution,
transactional failed-DDL rollback/retry, original records/log preservation,
checksum drift and future-version rejection. SQLite 0003 adds replication epoch
and fixed snapshots; peer checkpoints reuse local_values. MySQL/IndexedDB schemas
are unchanged in this phase. Existing 0001/0002 archives remain immutable.

Older binaries cannot open SQLite 0003. Close old writers, take an online
workspace backup including originals, sync objects/chunks and encrypted local
credentials, and keep the independent deployment key when applicable. Restore
to a new directory using the matching program/key; executable rollback does not
roll back the database. See `docs/native-sync-execution.md` for the prior design
and `docs/native-sync-acceptance-20261003.md` for current evidence and open gates.

## IndexedDB 0011 archive (2026-10-03 continuation)

`20261003-through-mysql0014-sqlite0003-indexeddb0011.tar.gz` and its
immutable manifest preserve 42 files, including the unchanged MySQL chain,
SQLite 0001–0003, and browser migration descriptions/source snapshots through
0011. Hashes of the archive and its extracted entries were verified. Historical
source snapshots preserve their original bytes and are not overwritten as later
business code evolves. MySQL remains 0014 and SQLite remains 0003.

Browser 0011 appends the field-outbox format marker in the existing syncMeta
store. Tests cover 8/9/10→11, new databases, repeated open, pending operations
and drafts retention, and injected upgrade abort followed by retry. Existing
upgrade branches remain intact. Take an independent browser export before
upgrade; this migration-source archive is not a book/data backup. An unpaired
legacy workspace is rejected without clearing its pending outbox and still
requires an explicit export/import transition before production release.
