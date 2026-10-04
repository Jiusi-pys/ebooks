# 后端修复记录（2026-10-05，base 工作树）

本次仅修改后端和测试；生产部署与恢复切换结果见
[验收记录](evidence/mcp-production-20261005.md)。Node/MySQL 继续作为过渡服务，新增的
可恢复版本管理由 Rust/SQLite 原生服务承载。应用数据库版本仍为 MySQL 0014、
SQLite 0003、IndexedDB 11；没有修改已发布迁移或增加 schema。

## 行为与边界

- Rust OAuth 记录已消费刷新令牌到授权族的关系，重放会在同一持久事务中撤销该授权
  仍有效的访问及刷新令牌。Node 和 Rust 的匿名 DCR 注册在 24 小时后清理未被
  待决请求、授权码或有效授权引用的客户端；已有记录无时间戳时先获得完整宽限期。
- Node 与 Rust 的 HTTP MCP 对带 `Origin` 的请求要求与配置的公开源精确一致，
  否则返回 403；无 `Origin` 的机器客户端仍可访问，Rust stdio 不受该 HTTP
  边界影响。Node 需设置 `MCP_PUBLIC_ORIGIN` 或精确的 `PUBLIC_ORIGIN`；仅凭
  请求 `Host` 不推断可信公网源。MCP 工具名、snake_case 入参及输出对象已统一到
  现有 Node 契约，Rust 暂兼容旧驼峰入参。随后将 Node SDK 升至 v2，HTTP 与 stdio
  同时支持 2026-07-28 新协议及旧版初始化；Node 旧 HTTP 客户端继续收到 JSON
  响应。Rust HTTP/stdio 增加新版发现、逐请求元数据与 HTTP 路由头校验。
- 同步快照每页限制为 15 MiB 的序列化 JSON，单条超过上限时显式拒绝；接收端
  上限仍为 16 MiB。旧 Node 和 Rust 的网络快照保留一天供断点续传，超过期限
  在新快照创建时回收。`version-` 前缀的手动历史版本不参加自动清理。
- Rust 原生 `POST/GET /api/native/v1/versions` 创建/列出可选版本。版本包含
  SQLite 固定实体状态及完整 ZIP 备份（数据库、原文件、同步对象与加密凭据）。
  `DELETE /api/native/v1/versions/{id}` 手动删除选定版本；
  `POST /api/native/v1/versions/{id}/entities/{kind}/{entityId}/restore`
  从该版本恢复单条记录，可传 `operationId` 和可选 `newEntityId`，写入新的同步
  操作。`POST /api/native/v1/versions/{id}/restore` 先创建当前工作区安全备份，
  再把所选完整版本解压、校验到独立的新工作区，并返回目标路径。管理员须停旧
  写入者、核验新工作区与独立凭据密钥后切换服务路径；接口不会覆盖运行中的库。
  安全备份也在版本列表中以 `safety` 类型呈现，可由所有者按 ID 手动删除。
  所有版本接口由服务所有者令牌保护。网络同步快照不是完整数据备份。
- 完整备份恢复在发布新工作区前更换 `sync_epoch` 并清理旧入站暂存/游标，迫使
  节点重新核对该世代。Rust 终态作业会从内存表逐出，持久结果仍可查询；旧
  Node 兼容写入成功后继续分发订阅 WebHook，重复操作不重复分发。
- 新追加的迁移源码归档只修复 Windows 工作区字节与 Git blob 不一致的问题；
  旧归档保持不可变。详见[历史迁移备份](../app/db/migration-history/README.md)。

## 验证与未完成范围

隔离工作树的 `cargo test --workspace --quiet`、
`cargo clippy --workspace --all-targets -- -D warnings`、`npm run check`、
`npm run lint`、`npm test`、`npm run build` 与部署监护脚本测试通过。版本测试
覆盖整库创建/恢复到新目录、单条记录回写、手动删除、安全备份与新同步世代；
OAuth/MCP/分页/作业均有回归测试。生产 MySQL、真实 HTTPS、跨节点恢复及
恢复后的单写入者切换已按上述验收记录完成。Node/MySQL 尚未提供由应用手动
选择并删除的整库历史版本；该功能由 Rust/SQLite 原生服务提供。跨节点长期
运行仍需观察。Node WebHook 仍沿用原有进程内投递机制，崩溃窗口下的可靠
投递须另行设计持久队列。2026-07-28 MCP 协议的 Node SDK v2 路径已有新旧客户
端合成测试，并在生产 HTTPS 入口用真实客户端通过。Rust MCP 路径目前是服务端
契约测试，尚未以真实跨进程客户端验证，不将其等同于生产 MCP 验收。
部署与验收门槛另见
[MCP 升级与服务验收计划](mcp-deployment-plan-20261005.md)。
