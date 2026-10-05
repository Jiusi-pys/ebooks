# Rust 后端功能补齐计划

基线：base ade79bea381a088e42c215d8e4cca57c3f249aba。
目标：现有服务器全部后端能力由 Rust 提供，保留客户端和前端现有契约，
团队规模不超过 10 人。候选验收前不改变生产写入权。

## 顺序与测试门槛

1. 冻结当前 boot/auth/library/v1/v2/tRPC/MCP 的路径、方法、授权、请求和响应。
   生产 v1 sync bridge 与早期 mirror REST 是两套契约；保留默认旧契约，增加
   明确的生产同步实体契约模式，不用字段猜测请求来自哪个客户端。
   先红测试完整实体、ID、正文、阅读进度、书籍/文件夹过滤和缺失对象，
   然后补实现；旧模式回归测试必须继续通过。
2. 主存储确定保留 MySQL。实现服务器仓库适配并复用现有账本与账户；
   SQLite 仅继续用于本地工作区，不承担 MySQL 生产写入。
3. 鉴权：兼容 session v2 HMAC、用户 credentialVersion、过期与撤销、AES-GCM
   用户名、scrypt 密码、初始化/登录/资料/退出、CSRF、登录退避和并发哈希限制。
   使用 Node 生成固定测试向量，Rust 验证，再反向验证；拒绝过期、篡改、
   改密后的旧 cookie、跨站写入和未完成初始化的业务请求。
4. library：完整书籍状态、目录、阅读进度、原文件分块/完整性、上传幂等。
   events：全部事件、重复 delivery、墓碑、版本兼容；不得把投影相同当成写入相同。
5. AI/tRPC：保持批量/单调用编码、错误、provider/model/effort、Codex 登录、
   摘要持久化和删除生命周期、翻译/问答/脑图/卡片；测试超时、取消、限流。
6. MCP/OAuth：现有两代协议、路由头、六个工具响应和 scopes；统一 REST/MCP
   底层用例，测试授权边界和过期 refresh token。保持现有公网地址。
7. 整库/单条版本恢复、手动删除、同步世代、节点认证、单写入者恢复切换，
   用独立库/工作区测试。新增结构必须先追加迁移、完整历史归档及恢复说明。
8. Windows/Linux 测试、Node check/lint/test/build、部署监督器检查；真实隔离
   MySQL、HTTPS、两节点验收。停写备份并异机复制，最后切换公网与写入权；
   首次 Rust 写入后的回退必须保留新增数据。

## 设计审核

Tier 3：账户与生产数据。理解检查确认生产 `/api/v1` 是 materialize 后完整实体，
不是 `legacy::project` 的旧镜像摘要。反例检查包括同名 ID、原字段缺失与 null、
大字段 blob 未就绪、跨节点重复/乱序、改密后的旧 session 和恢复世代。
验证检查要求 HTTP 差分和存储/恢复实际测试，禁止用静态检查替代部署验收。
建议最终写入切换由具有不同工具或先验的独立维护者审核；当前未获得该结论。

用户已确认保留 MySQL。Rust 复用既有账户和同步表、历史操作 ID 与世代；
SQLite 保留给本地工作区。生产依旧由 Node 单写入。本文不是完成证明。

## 当前实现与证据（持续更新）

- MySQL 保留为服务器主库。新增 0015 三张 Rust 元数据表及不可变历史归档；
  SQLite 继续用于本地工作区。
- 实际隔离 MySQL 8.4：Node 和 Rust 迁移器分别通过空库、0011 跳版本、0014
  升级、重复执行、0015 部分 DDL 失败后重跑及账户保留。Rust 校验完整账本
  哈希和顺序，不改写旧记录，失败不记成功。
- 原子提交、错误 revision 回滚、重启保留、同步快照、单条版本恢复/手动删除、
  整库恢复/新 epoch/清除接收游标、写入者排他和释放后接管均通过真实 MySQL。
- Node 的 AES-GCM/scrypt 账户和 v2 cookie 在真实 MySQL HTTP 交接测试通过；
  改账户后旧 cookie 撤销。旧 webhook 保留事件、失败次数、停用状态、
  legacy ID 和签名密钥；密钥迁入私有凭据文件，不进入出站记录。
- AI/tRPC 六类调用、批量信封、临时 API Key、HTTP 取消和并发边界通过注入测试；
  摘要在 MySQL 保留共享书籍引用，最后引用删除后清理，拒绝迟到结果。
  Codex 仅允许 ChatGPT 登录执行；尚未进行真实外部 AI 付费调用或 Codex 登录。
- 生产 events 保留原元数据，操作、收据、webhook 出站记录同事务；分块导入
  验证边界并支持重试和既有 MySQL 暂存内容。MCP 拒绝未到齐正文。
- 当前 Windows 全量 Rust 回归通过；Node check/lint 通过，611 tests 通过
  （53 skipped）、build 通过；部署监督器 11 tests 通过。后续新增代码需继续
  完成相关回归。Linux 最新候选正在重建。
- 生产仍由 Node 独占写入，最新候选尚未切换。实际 HTTPS、跨节点混合版本、
  最终发布包/生产账号/OAuth/原文件交接、公网切换和 base 提交尚未完成。

## 整库恢复的故障边界

目标必须是独立、已迁移、空的 MySQL 库；禁止运行 Node 写入者。Rust 打开和
恢复通过数据库级初始化锁串行化。恢复复制数据并改变所有同步世代，保留原
操作，清除接收游标。数据库提交和文件系统发布不能组成同一事务：验证后的
文件保留在同卷恢复目录，先写 restore.pending，数据库提交后写
restore.database-committed，再发布目录。发布失败保留已恢复数据库及原文件，
错误提供恢复目录；带 restore.pending 的工作区禁止启动。运维必须核对独立库
和提交标记后完成目录发布并清除 pending，不能把容器回退称为数据库回退。

## Latest isolated runtime gates

- Windows and Linux full Rust regression plus Clippy passed; Linux tests inject the
  documented public test credential key. No production credential is used by tests.
- The real Node/MySQL v2 peer exchanged notes, retried IDs, and transferred original
  source chunks with the current Rust core. Public HTTPS -> Windows replication passed.
- Isolated HTTPS/MySQL CRUD, restart-safe idempotency, all six MCP tools, individual
  record restoration and manual version deletion passed. A live test exposed a double
  clock read; the core now assigns default creation timestamps using one operation
  clock, with an advancing-clock regression and compatibility for persisted candidates.
- Whole-library restoration to a separate migrated MySQL database changed the epoch,
  preserved originals/operations, created a safety backup, stopped the old writer before
  activating the restored writer, and rejected a second writer. The already synchronized
  Windows client subsequently reconnected successfully to the restored HTTPS service.
- An isolated copy of production matched Node for seven complete entity kinds,
  accepted the actual persisted owner cookie, imported OAuth/webhooks and matched all
  nine original files. Its migration preserved the verified historical 0014 CRLF hash.
  The explicit alias and immutable evidence archive are described in the 0015 plan.
- Production remains Node until the final consistent backup, independent copy,
  migration and deployment checks complete. This is not a claim of production cutover.

## 最终生产状态（2026-10-05）

已完成一致性停写备份及独立副本校验、0015 追加迁移、原账号/OAuth/原文件交接与生产 Rust 切换。旧 Node 容器停止且关闭自动重启。最新实际结果及仍未验证的外部服务范围见[最终验收](evidence/rust-production-20261005.md)；以上候选阶段状态为历史记录。
