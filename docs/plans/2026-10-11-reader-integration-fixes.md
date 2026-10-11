# 阅读器四项 US 集成失败修复计划

> 已完成：原 53 项在 US 先复现 4 项失败；新增 Rust 和差分回归先失败，修复后 US 55/55 通过，本地常规检查通过。见 [红绿结果与验收范围](../reviews/2026-10-11-us-integration-fixes.md)。

## 范围与设计审查

本轮处理基线 `2ffca98` 的四项已确认失败：Mirror 笔记事件缺失 `updatedAt` 仍被接受，以及三项快照测试向 MySQL TIMESTAMP 写入 `now=1`。保留现有未提交 EPUB 前端适配；只提交本轮后端、测试和文档，推送当前 `codex/shared-core-delivery-automation` 分支，不部署生产。

设计核对：Hono 的 note.created / note.updated 均要求非负整数 updatedAt；Rust reader_event::normalize 已表达该约束，可供 Mirror 复用。校验必须早于回执查询/写入和业务变更。保持其他 Mirror 事件和 SyncEntities 的既有行为，不扩展本轮范围。快照的墙钟时间与 makeOperation 的逻辑时间含义不同；仅替换 begin/finish 的墙钟夹具，保留操作时钟和所有数据完整性断言。

不修改 schema、历史迁移或 MySQL 严格模式，因此不新增迁移。遵守根 AGENTS.md 的隔离库要求及后端就近回归要求。

## TDD 和验收顺序

1. 在 US 隔离测试库和独立原生服务重跑现有 53 项，保存 49 通过 / 4 失败的当前复现及原始响应。
2. 添加原生服务回归和 Hono/原生差分回归：note.created / updated 无时间或错误时间拒绝，不写笔记、不消耗回执；修正载荷后同 deliveryId 可成功，正确重放 200、不同重放 409。先在旧实现运行确认失败。
3. Mirror 复用现有笔记事件验证；回执测试补齐合法 updatedAt 并明确断言 200/200/409；快照夹具使用固定现代墙钟及相对偏移。测试不靠放宽断言变绿。
4. 运行 Rust 相关及服务回归、本地 npm check/lint/test/build、部署 supervisor 测试；在 US 重跑原 53 项及新增回归，实际执行 MySQL/Hono/原生 SQLite 路径。
5. 记录源码和 Linux 二进制 SHA-256、红绿结果、剩余跳过与限制；清理临时数据库、账号、容器和文件，核对生产容器状态未变。
6. 全部要求检查通过后更新阅读器状态/验收文档，以及插件仓库中指向这四项失败的后续状态；分仓库提交并推送。

US 磁盘空间不足以编译 Rust，因此 Linux 二进制在本机 Docker 用当前源码构建，再上传至 US 实际运行。所有服务和数据库验收均使用合成数据，不调用生产账号。
