# MCP 用户能力生产发布验收

范围及用户手动步骤见[MCP 用户能力](../mcp-user-capabilities.md)。本次仅修改 Rust 后端，保留 MySQL，无 schema 迁移或客户端改动。

## 发布来源

- 源码提交：`3cbda7f69e1d02f5d9b5c81e7644712b19054c8f`，已推送 `origin/base`。
- Linux 二进制 SHA-256：`2231de74914153faef5c8516db5d0e60665192262879c76c469a41f3494e04a6`；生产容器内校验一致。
- 镜像：`shufang:3cbda7f69e1d02f5d9b5c81e7644712b19054c8f`，image ID `sha256:b4aea4422ca56f33878797b138df26e4fdf9fea278d74bf1b4a55fa8182a5e1df`；OCI revision 与源码提交一致，运行用户 `10001:10001`。
- 最终发布监督器任务：`256be0bfe2e94dffb498c8f1dd21b147`，`succeeded`。备份完成，迁移执行 0 项，连续就绪检查通过。发布为已有运行镜像替换最终 Rust 二进制的预构建模式，未重新构建或部署前端。
- 首次任务 `193f5f2335114b03a6806ea183f248e5` 在备份阶段因磁盘不足失败，未替换原后端；同时在候选容器校验时修正二进制执行权限后再重试。
- 发布前版本 `version-d79be28c-5356-4822-94cd-682fc3bd2956`；独立备份目录 `/opt/shufang/backups/rust-20261005T055920Z-version-d79be28c-5356-4822-94cd-682fc3bd2956`，版本包 238482632 字节；`version.zip` 和 `runtime.env` 全部通过其 SHA-256 清单核验。
- 8 个生产前端文件逐一与原构建副本校验一致；共用 sing-box/Nginx TLS 入口未调整。原回退容器和 MySQL 数据容器保留。

## 验证结果

Windows/Linux 工作区测试及 Clippy、Rust 格式、diff 检查通过；旧 Node check/lint/test/build 与监督器 15 项测试通过。最终构建的真实 MySQL MCP 测试使用两个新隔离库分别执行完整 16 个迁移，修改、持久幂等、快照、单实体恢复及删除通过，随后删除隔离库。

通过真实 `https://us.jiusi.org` 的 OAuth 注册、PKCE、已登录书库账户及 CSRF 同意、授权码交换验证：

| 场景 | 实际结果 |
| --- | --- |
| 匿名 MCP | HTTP 401 |
| 外站 Origin | HTTP 403 |
| 初始化 | MCP 服务版本 1.1.0 |
| 默认新授权 | `library:read library:write`；授权页包含访问和修改及单条恢复 |
| 完整工具目录 | 85 项，无同步/节点/部署/整库恢复工具 |
| 真实生产业务写入 | 专用临时笔记创建、读取、修改、同一 operation_id 重试通过；笔记已删除 |
| 显式只读授权 | 34 项读取工具；调用写工具 HTTP 403，带 insufficient_scope 挑战 |
| 刷新提升只读权限 | HTTP 400 |
| OAuth 令牌调用实际服务控制路由 | 后端 loopback HTTP 401/403；HTTP 单元测试同样通过。公网 Nginx 没有将 `/admin/*` 代理到该控制路由，因此此项专门直连后端验收 |
| 撤销授权后重用访问令牌 | HTTP 401 |

各验收脚本先修正 HTTP 头名称大小写、控制路由代理边界及撤销所需 client_id，再完成以上最终结果；这些是验证脚本修正，未改变产品代码。验收专用 OAuth 客户端及 grant 已按客户端名和本次运行时间范围清理，保留其他授权。

整库恢复和写入者切换本次没有在生产执行；其已有隔离跨节点及恢复验收见[原生产验收](rust-production-20261005.md)。本次新增 MCP 单条恢复在真实 MySQL 隔离库验证，未对生产书库进行破坏性恢复。实际用户 AI 账户和 ChatGPT/Codex 客户端回跳仍需手动验收。

## 磁盘及归档

发布前空间不足，按引用关系清理候选文件；所有迁出文件先保存在 `C:\Users\17715\.codex\deployment-candidates\` 并校验，未删除用户版本快照或仍被容器引用的工作区。

- 已停用旧 `shufang-rust-shadow` 测试单元，其完整副本保存在 `retired-shadow-20261005.tgz`，SHA-256 `deaea0ae06c7869b90715525908a9e5b746f9affe3e420846ae48f8c4b267535`。
- 三份较旧独立备份目录迁至同名本机目录：`rust-20261005T031034Z-version-0b27cedb-c227-455d-9441-12ea8de3c6a5`、`rust-20261005T033715Z-version-3ebf0cdb-7930-443c-99cb-ddda0d7ce227`、`rust-20261005T040255Z-version-2729844a-b14a-4422-a73f-21d79255c9b1`。每份版本包及环境文件均通过自身清单校验，服务器上的对应可手动选择版本快照仍保留。恢复时将完整目录安全传回服务器，按原恢复文档执行；文件含私密配置，不提交到 Git。
- 已迁出重复源码包、旧测试副本及重复压缩备份；清理可重新生成的 apt/npm 下载缓存。最新发布独立备份留在服务器。最终可用磁盘约 546 MiB，长期保留更多快照前应安排容量；本次没有自动删除版本的策略。

此前生产真实客户端 IP 未经共用 TLS fallback 传递的登录限流限制仍然存在，见[安全验收](../security-fix-acceptance.md)。本次 MCP 功能扩展不将它标记为已解决。
