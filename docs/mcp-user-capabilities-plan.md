# MCP 全部用户能力扩展方案

基线 base 4c783e7。用户明确授权完整书库用户能力，排除同步等控制层。

## 边界与实现

- 业务白名单：书籍/文件夹/笔记/书摘/关联/翻译/脑图/学习集/阅读偏好 CRUD，原文和章节、封面与元数据、阅读进度及记录、复习及引用，导入及原文件分块上传，用户 AI 配置与所有 AI 调用、作业查询取消、版本列表创建删除及单条恢复。保留现有六个工具。
- 禁止通用 HTTP 调用、任意 workspace action、客户端文件路径/数据库引用；不开放同步配置/收发、节点、机器 token、账户登录/凭据、部署/服务启停、自启动和 webhook 管理。
- HTTP 与 stdio 使用同一异步工具调度和业务白名单。写工具复用权威业务校验、revision 冲突与操作幂等；只读 Host 禁止写工具。原文分块返回并提供完整的续读游标；文件导入接收编码内容而非服务器任意路径。
- OAuth 新增 library:write；默认新授权明确说明完整读写能力。旧 library:read grant 不自动升级，刷新不提升 scope，HTTP MCP 按真实令牌 scope 过滤目录并验证调用。控制接口仍不可被 OAuth 写 scope 调用。授权页按请求 scope 文案显示权限。
- 用户已选择仅开放单条版本恢复；不开放整库恢复和写入者切换。版本可列出、创建和手动删除，单条恢复复用现有业务流程。
- 无 schema/数据格式/迁移变化，继续保留 MySQL 0015 / SQLite 0003 / IndexedDB 11；不修改 UI。

## 审核与 TDD 门槛

设计自检：catalog 不能绕过白名单；只读凭据不提升；已存在工具兼容；业务错误和协议错误分离；未知字段/不合法范围拒绝；不返回内部路径及控制凭据；AI 费用操作明确标注非只读。按照 MCP 2025-11-25 tools 规范提供 schema、annotations、structuredContent 及 isError。

先添加失败测试，再实现：目录覆盖/控制排除、读写 scope 与刷新保持、正常 CRUD/封面/章节/复习/引用、revision 冲突及幂等、分页完整性、文件导入/原文边界、只读副本写入拒绝、版本生命周期、AI 使用既有校验。随后运行 Rust 工作区测试/Clippy、旧 Node check/lint/test/build、部署监督器测试，记录真实数据库和生产未验证边界。

依据：https://modelcontextprotocol.io/specification/2025-11-25/server/tools 与 https://modelcontextprotocol.io/specification/2025-11-25/basic/authorization。
