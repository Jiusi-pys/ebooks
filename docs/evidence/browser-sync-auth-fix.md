# 浏览器工作区同步鉴权修复

用户报告书库初始化失败：同步服务不可用 (401)。在生产使用服务端短时测试会话复现：/api/auth/profile 返回 200，而 /api/v2/capabilities 返回 401；会话/用户名/密钥不输出、不提交。

原因：现有网页 workspaceSync 只发送同源 Cookie，Node v2 适配器支持此路径；Rust v2 只接收机器/节点令牌。修复在未提供机器鉴权头时复用现有 browser/library 中间件，校验已设置账号、当前 credentialVersion、会话有效期和写入同源，并返回 no-store。显式错误机器凭证不降级为 Cookie；节点工作区限制和 peer 管理权限保持原逻辑。

TDD：修复前有效 Cookie 访问 capabilities 失败（401 而非 200）；修复后 capabilities、changes、entities 和同源快照通过，匿名/旧 bootstrap/撤销 Cookie/错误 key+正常 Cookie 被拒绝，跨站快照写入 403。Windows 浏览器及机器鉴权回归、Clippy 通过；Linux 全工作区 140 passed、0 failed、14 ignored 及 Clippy 通过。无前端、数据库结构、历史迁移或客户端界面修改。

Linux 服务 SHA-256：`9209e46207c22660e5245bc07f86102840bb4ca10089165517b9d0250cb8254f`。随后采用一致性备份、完整迁移检查和单写入者监督器发布；实际 HTTPS 发布结果见补充记录。
