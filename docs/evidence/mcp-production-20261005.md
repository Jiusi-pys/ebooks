# MCP 升级与生产恢复切换验收（2026-10-05）

范围：`base` 的过渡期 Node/MySQL 服务与 Rust 跨节点端。生产入口为
`https://us.jiusi.org`。没有修改前端或客户端界面，也没有修改已发布数据库迁移。

## 版本与部署

- MCP TypeScript SDK 升至 v2.3.0。生产 HTTPS 入口通过新版客户端固定
  `2026-07-28` 完成服务发现、6 个工具列表和 `list_books` 调用；旧版
  `2025-11-25` 初始化返回 200。无凭据 `/mcp` 返回 401；跨源拒绝在测试中
  覆盖。Rust HTTP/stdio 的新版协议路径通过本地契约测试。
- 候选源码包 SHA-256：
  `1d62087dfdd1a9d4fb7b2d895b77a2025308a6be73d5ab03975d6d44958601d0`。
  远端 `source-final.tar.gz` 与本地值一致。镜像
  `shufang:mcp-final-20261005` ID 为
  `0c13b11161382cab3b91ce9887e82c6d218b45d4293dfa2274f874322806b03f`，
  与隔离验收的候选镜像相同。构建包含完整服务端构建、迁移链和历史归档。
- 生产旧 `shufang-app` 停止后更名为 `shufang-pre-mcp-20261005`，重启策略为
  `no`。新 `shufang-app` 连接新 MySQL 容器
  `shufang-prod-restored-db`，二者重启策略均为 `unless-stopped`。旧 MySQL
  容器和卷保留供核对与恢复，但旧应用保持退出。临时公网候选路由已撤销。

## 同点备份与恢复

停旧应用后，分别导出 MySQL 和归档运行目录、原文件、`.env.sync`；备份位于
`/opt/shufang/backups/mcp-production-20261005/`，独立副本位于本机
`C:\Users\17715\.codex\deployment-candidates\mcp-production-20261005\`。
压缩包通过 `gzip -t`，本机和远端 SHA-256 一致：

| 文件 | SHA-256 |
| --- | --- |
| `mysql-frozen.sql.gz` | `8d015215aac4970b30b6213a45f1838d0b0307787d3087f17858afadd5518155` |
| `runtime-frozen.tar.gz` | `d46639b5995eab57fe15b7c5a0fdc479d7a0bb764ff6abb9f968c322d83bfc1c` |

新 MySQL 卷从此备份恢复，应用账户授权单独按旧实例重建；迁移器返回
`Database migrations are up to date.`。旧/新库在切换点均为 29 张表、
2644 条同步原操作、66 条同步实体、2 条镜像书籍、12 个同步快照。
旧运行目录与新运行目录的 27 个内容寻址原文件逐个 SHA-256 相同。
第一次迁移尝试因逻辑备份不包含 MySQL 用户授权被拒绝，新应用随即停止；
只在新库补齐授权并重跑迁移成功后才启动服务。此失败没有对旧库或旧运行目录写入。

## 实际运行验证

- 隔离 MySQL 恢复演练中，停旧候选写入者、恢复到第二库与第二运行目录后，
  通过公网 HTTPS 创建并读回测试书籍；新库原操作数由 2644 增至 2645，
  旧库保持 2644，测试实体只在新库存在。
- Windows Rust 节点从隔离候选及正式生产 HTTPS 入口分别恢复至少 2644 条
  原操作，书籍数量断言通过；生产测试凭据随后在新库撤销。
- 生产服务经可信证书的 HTTPS 返回 `/api/auth/session` 200、未授权
  `/mcp` 401；真实 MCP v2 客户端完成发现、工具列表和调用；旧版初始化
  通过。新应用自身查询恢复 MySQL 读到 2644 条原操作，旧应用退出，
  唯一运行的应用容器为新 `shufang-app`。生产恢复后，旧/新库原操作数仍均
  为 2644，临时跨节点测试没有制造业务操作。
- 本地 `npm run check`、`npm run lint`、`npm test`（611 通过、50 跳过）、
  `npm run build`、`cargo test --workspace`、`cargo fmt --all -- --check`、
  `cargo clippy --workspace --all-targets -- -D warnings` 与 11 项部署监护测试
  通过；隔离真实 MySQL 集成 9 项通过。

## 运维边界

Node/MySQL 仍为过渡期 Web 业务服务；Rust 尚未承接全部生产业务。
生产 HTTPS 跨节点测试是受控的一次恢复，不等于长期运行证明。
旧库及旧应用应继续保留到观察窗口结束；任何回退都必须以这份停写同点备份
或经验证的旧库和旧运行目录为一组，不能只回退容器镜像。
现有 WebHook 仍是进程内投递，没有跨崩溃的持久队列保证。
