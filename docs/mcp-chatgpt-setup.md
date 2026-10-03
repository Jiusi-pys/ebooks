> 当前状态（2026-10-03）：见[工程状态与验收门槛](current-status.md)。本文件中的日期/版本记录保留其历史范围；当前迁移为 MySQL 0014 / SQLite 0003 / IndexedDB 11，生产尚未正式切换。

# ChatGPT 连接书房 MCP

## 配置

在 ChatGPT 的插件目录中添加 MCP 应用：

| 项目 | US 部署的值 |
| --- | --- |
| 名称 | 书房读书记录 |
| 服务器 URL | `https://us.jiusi.org/mcp` |
| 身份验证 | OAuth |
| 客户端注册方式 | 动态客户端注册（DCR） |
| Token 端点身份验证 | `none` |
| 默认请求权限范围 | `library:read` |
| 客户端 ID / 密钥 | 不手工填写，由 DCR 生成 ID；公共客户端不使用密钥 |

自动发现后应显示：

- 授权服务器：`https://us.jiusi.org`
- 授权地址：`https://us.jiusi.org/oauth/authorize`
- Token 地址：`https://us.jiusi.org/oauth/token`
- 注册地址：`https://us.jiusi.org/oauth/register`
- 资源：`https://us.jiusi.org/mcp`
- 权限：`library:read`

创建后点击连接，在 **us.jiusi.org** 的授权页面使用书房现有用户名和
密码登录，再点击“允许只读访问”。不要填写 SSH 密码、MCP_API_KEY 或
OPEN_API_KEY。授权页面会显示客户端名称、回调地址和数据范围。授权事务
有效期为五分钟，过期后从 ChatGPT 重新连接。多个并行授权标签页可能互相
替换 CSRF cookie，请一次完成一个授权。

本服务支持 ChatGPT 的固定回调以及 `/connector/oauth/{callback_id}` 回调。
服务在所有授权回调中返回 `iss`，并公布 issuer identification 支持。
CIMD、OIDC、邮箱域验证和 client_credentials 不在本版本范围内。

## 能读取什么

提供六个只读工具：书目、阅读进度、书摘/批注搜索、复习队列、笔记搜索、
笔记详情。只包含已同步到该服务器的数据。不会读取其他独立节点或尚未
同步的浏览器本地数据。可用提示词：“列出我服务器上的前 5 本书”。

## 服务配置与运维

必须设置 `MCP_OAUTH_ENABLED=true`、精确的 HTTPS `PUBLIC_ORIGIN` 和供内部
只读工具读取数据的 `OPEN_API_KEY`。后者仅留在服务器。现有 `MCP_API_KEY`
客户端与 stdio 用法仍受支持。额外 HTTPS 回调可通过
`MCP_OAUTH_REDIRECT_URIS` 逐个精确指定；不接受通配符、片段或查询参数。

授权状态文件：`.runtime/mcp-oauth-v1.json`。每个节点独立保存，必须持久化
且只允许一个 Node 进程写入。访问令牌有效期 15 分钟，刷新授权最长 30 天，
刷新时更换令牌，重用已消费的刷新令牌会撤销整条授权。修改书房账户凭据
会使旧授权失效。客户端可向 `/oauth/revoke` POST 表单 `client_id` 和 `token`
撤销该授权。紧急撤销全部授权的步骤见设计文档。

公开 DCR 最多保留 128 个客户端，授权/令牌端点全局限流 120 次/分钟。
注册达到上限时返回 429，不能静默删除已使用的客户端；需由管理员检查
状态文件中的无用客户端。授权状态最多 512 个 grant、256 个待授权事务和
8192 个 token 哈希，到期项在后续写入时清理。

升级、备份、回滚及单进程限制见 [设计文档](mcp-oauth-design.md)。

## 排错

- `/mcp` 无凭据返回 401，并附 `WWW-Authenticate`，是正常的 OAuth 挑战。
- 发现地址 `/.well-known/oauth-protected-resource/mcp` 与
  `/.well-known/oauth-authorization-server` 应无需登录即可读取 JSON。
- `invalid_client`：检查 DCR 是否成功，避免把静态 MCP key 当作客户端 ID。
- `invalid_grant`：授权码过期/已使用、PKCE 不匹配、授权撤销或账户凭据变更。
- `invalid_target`：授权和 Token 请求的 resource 必须精确等于 MCP URL。
- 503：检查授权文件权限、完整性、MySQL 和账户密钥配置；不会自动清空状态。
- 若 ChatGPT 显示 424 / upstream 401，检查是否误选“无需身份验证”。

依据：[OpenAI MCP 认证](https://developers.openai.com/plugins/build/auth)。
服务器通过验证不等于 ChatGPT 最终配置已验收；最终插件创建、账户登录
和真实 ChatGPT 工具调用由使用者完成。
