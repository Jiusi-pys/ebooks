# US 四项集成失败的 TDD 修复

本轮基于 `2ffca98c6b64e6f0a21c89ad24c06b96c2114330`，处理一次 Mirror 校验差异和三次 MySQL 快照夹具失败。执行顺序见 [修复计划](../plans/2026-10-11-reader-integration-fixes.md)。已有 EPUB 前端适配继续保留在工作树，本次仅提交后端修复、相关测试与文档，不部署服务。

## 问题和修复

- `base/crates/service/src/legacy.rs`：Mirror 的 note.created / note.updated 现在复用 `reader_event::normalize`，在回执读取、记录和笔记变更之前拒绝缺失、null、负数、小数或字符串 updatedAt。其他 Mirror 事件及 SyncEntities 路径保持原逻辑。
- `app/api/v1.native-differential.test.ts`：回执正例补齐合法 updatedAt，并分别要求 Hono 和原生端返回 200 / 200 / 409。新增两个差分用例覆盖创建和更新的错误时间值、拒绝时笔记不变、同一 deliveryId 修正后可成功。
- `base/crates/service/tests/legacy.rs`：新增对应的两项原生路由回归，检查无效事件不修改笔记，也不消耗 deliveryId；随后正确提交、精确重放、冲突重放分别为 200 / 200 / 409。墓碑正例补齐事件时间，仍必须返回 409。
- `app/api/sync/snapshots.mysql.test.ts`：begin/finish 使用固定现代墙钟 `Date.UTC(2026, 0, 1)` 加原有相对偏移。makeOperation 的逻辑时钟、原子合并、回滚、游标冲突及代理字符断言保留。未修改 MySQL 严格模式、schema 或历史迁移。

## 先失败

1. US 原 53 项在未修复源码和原 Linux 二进制上再次执行：49 通过、4 失败、0 跳过，32.16 秒。失败与此前相同：Mirror 接受不完整笔记事件；三项快照在 created_at 写入 1970-01-01 00:00:00.001 时失败。
2. 新增两项 Rust 路由回归在旧实现上均失败：缺失 updatedAt 时实际 200，期望 400；命令退出码 101。
3. 新增差分测试最初随完整 55 项执行时有 5 项失败，其中合法重试的原生端返回 400，未把该轮当作精准缺陷复现。随后独立运行同一差分文件、使用旧服务二进制，得到 30 通过、2 失败（4.74 秒）；两项明确失败于实际 200、期望 400，响应为 `{"ok":true,"mirrored":true}`。正例补齐后的回执测试在旧二进制也通过，说明原回执失败不是重放算法缺陷。

## 修复后的检查

| 检查 | 结果 |
| --- | --- |
| Windows Rust legacy 路由 | 9 通过、0 失败 |
| 本机 Docker Linux Rust service 全部默认测试 | 86 通过、0 失败、5 显式 ignored |
| Web `npm run check` / `npm run lint` / `npm run build` | 全部通过 |
| Web `npm test` | 703 通过、55 按环境开关跳过；140 文件中 132 通过、8 跳过 |
| 部署 supervisor `python -m unittest discover -s deploy -p 'test_*.py'` | 15 通过 |
| Rust fmt 与修改后的 TS 类型/定向 lint | 通过 |

Linux Rust 首次缺少 CI 指定的合成 `SHUFANG_CREDENTIAL_KEY`，一个 webhook 用例因密钥缺失失败。按已有 native-core CI 的公共隔离测试键补齐后，完整默认服务测试通过；没有修改 webhook 实现或断言。

US 修复后整组 **55/55 通过，0 失败、0 跳过**（8 文件，32.69 秒，退出码 0），包含原 53 项和新增 2 项。真实 `old_v2` Rust 子测试另为 1 通过、0 ignored（0.28 秒），实际完成 MySQL/Hono 与原生 SQLite 的操作和原文件交换。本地跳过的 55 项已由该组 US 执行覆盖；合并两次不同环境的 Web 验证范围，共 758 个用例均有通过结果，不代表 758 项都在 US 重跑。

| US 测试文件 | 通过 |
| --- | ---: |
| `api/library.mysql.integration.test.ts` | 3 |
| `api/v1.mysql.integration.test.ts` | 6 |
| `api/v1.native-differential.test.ts` | 32 |
| `api/lib/migration-mysql.integration.test.ts` | 1 |
| `api/lib/rust-migration.mysql.integration.test.ts` | 3 |
| `api/sync/native.mysql.test.ts` | 1 |
| `api/sync/snapshots.mysql.test.ts` | 3 |
| `api/sync/store.mysql.test.ts` | 6 |

US 为 MySQL 8.4.11，保持 `STRICT_TRANS_TABLES`、`NO_ZERO_IN_DATE`、`NO_ZERO_DATE` 等原严格模式。每轮临时库和账号均清理，前后数据库名称集合一致；测试容器及独立原生服务已停止，临时依赖、二进制和凭据已删除。三个生产容器的 ID、镜像、启动时间、运行状态前后一致。清理后根分区约 275 MiB 可用、`/dev/shm` 仅用 12 KiB。

证据：

- [原四项失败复现](../evidence/us-integration-fixes-20261011/baseline-results.json)
- [新增两项差分回归在旧服务失败](../evidence/us-integration-fixes-20261011/focused-red-results.json)
- [修复后 55 项结果](../evidence/us-integration-fixes-20261011/green-results.json)
- [执行、MySQL 模式及数据库/生产状态检查](../evidence/us-integration-fixes-20261011/execution-summary.json)
- [当前工作树源码 SHA-256](../evidence/us-integration-fixes-20261011/source-manifest.json)；测试前后逐文件一致。清单含已有未提交 EPUB 前端文件，不能当作本轮提交的文件清单。

本轮 Linux 原生服务 SHA-256：`3fb487e5b9b19e1102604501c2840898ef174d6274379926f2e36eb427714f4d`；old_v2 二进制：`904197965c5d56ed14b69e973af2e0e62b7c59d68c960b17febb24242c73d6b4`。原始红绿、构建、Web 检查和清理记录保存在本机插件仓库 `.local/reader-fix-us/`，不提交二进制、生产凭据或生成目录。

## 验证范围

US 使用独立 MySQL 数据库和临时账号、独立 SQLite 工作区、合成 token 及 loopback 端口，实际执行现有全部 16 个迁移。Linux 原生服务和 old_v2 测试由本机 Docker 基于当前源码构建，在 US 实际运行；没有模拟 Cargo 或同步服务成功。上传的 616 个源码文件逐个校验 SHA-256。

本地 Rust 默认忽略的五项分别要求真实 Codex 配额、隔离 MySQL MCP、Node 账号移交夹具、Hono/MySQL old_v2 同步和独立 HTTPS 恢复对端。其中 old_v2 已由 US 集成驱动实际执行，其余四项不属于本轮四个失败的修复范围。没有真实账号 UI、生产部署或全部平台验收。
