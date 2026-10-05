> 后续完整源码构建与真实监督器发布结果见[补齐验收](rust-release-completion.md)。本文件保留首次切换的二进制及阶段限制，不代表后续最新运行字节。

# Rust / MySQL 生产验收（2026-10-05）

本次仅迁移后端，保留 MySQL 8.4 和原前端静态文件。生产 `https://us.jiusi.org` 由 Rust 提供 API、同步、MCP、OAuth、浏览器账号、AI/tRPC、原文件及版本恢复接口。旧 Node 写入者已停止、禁用自动重启。基线提交为 `ade79bea381a088e42c215d8e4cca57c3f249aba`，最终提交见 Git 历史。

## 已验证

- Windows Rust 全工作区：139 passed、0 failed、14 ignored；ignored 的真实外部环境测试另行执行，不能视为默认已通过。Windows/Linux Clippy 无警告；Linux 最终全工作区 140 passed、0 failed、14 ignored（注入公开测试专用凭证密钥），最后接口及初始化回归通过。
- Node check、lint、test、build 通过：120 个测试文件通过、8 skipped；611 tests passed、53 skipped。部署监督器 Python 13 tests passed。
- 隔离真实 MySQL 空库、0011 跨版本、0014 升级、重复执行、DDL 中途失败重试及账号/数据保留通过。Rust 完整迁移链测试还验证已确认的历史 0014 CRLF 哈希别名，未改账本。生产追加 0015 成功。
- MySQL 单写入者锁、原子操作/事件/幂等回执、旧节点混合协议、凭证版本撤销、原文件分块、摘要、OAuth/webhooks 交接通过。生产克隆七类实体完整对比及九份原文件 SHA-256 一致，实际旧 owner cookie 保持有效。
- 隔离真实 HTTPS 六项 MCP 工具、CRUD 重启幂等、单条版本恢复和手动删除通过；整库恢复到独立 MySQL 保留数据/原文件、创建安全快照、改变同步世代、停止旧写入者并拒绝第二写入者。已同步 Windows 节点恢复后重新连接通过。
- 生产 HTTPS 到 Windows 实际传输至少 2644 条操作及 9 本书通过。生产重启与最后接口/鉴权/CSRF/MCP/单写入者结果见同目录机器可读记录。生产没有笔记，因此 get_note 正向使用隔离书库验证，生产验证缺失记录错误，未为测试写入真实书库。
- 原生 Codex CLI 0.160.0 官方平台包校验、运行及所需沙盒/配置禁用参数确认。真实外部付费模型调用和真实 Codex 登录尚未执行；AI 六项契约、超时、取消、并发限制通过隔离执行器测试。

## 备份与发布来源

停写最终备份包含真实 MySQL SQL、全部 Node 运行数据/原文件、Node/Rust 配置及代理配置，远端 `/opt/shufang/backups/rust-production-20261005.tar.gz` 与独立 Windows 副本 SHA-256 均为 `d94a1d70a4fec848dff645a4d28b2046ed975aef5c3b534d01a82eda34623760`，逐项内容哈希一致。配置密钥和书库内容不提交 Git。

最终 Linux 服务二进制 SHA-256 为 `404a6ecd94de89f4c5585f8654944083d8da56f847ef012e0e588f8d907aa1c3`，部署运行路径 `/usr/local/bin/shufang-service` 已核验。生产静态文件来自切换前 Node 构建、保持原字节。源码镜像配方为 `deploy/Dockerfile.rust`；生产资源限制下采用已验二进制层发布。完整远程 Docker 源码构建/监督器发布端到端及长期稳定性观察未验证。

MySQL 0015、完整历史归档与故障恢复说明见 [迁移设计](../mysql-rust-0015-plan.md)。DB 和文件发布不能组成事务，带 restore.pending 的工作区必须人工核对提交标记、独立库和文件后完成发布；程序镜像回退不是数据库回退。

## 最终审核边界

按 agentic-review Tier 3 分别复核运行契约、对抗故障及验收证据：浏览器与机器凭证隔离、CSRF/账号撤销、MySQL 物理连接写入锁、原子回执、恢复世代/文件提交标记、不可变历史迁移、重启导入参数和运行二进制路径。最后检查发现遗漏的服务器启动状态接口已按先失败测试再实现补齐；发布检查发现二进制镜像层路径与 ENTRYPOINT 不一致，已修正并核验实际进程执行文件 SHA-256。未发现仍阻止本次交付的已验证问题；此结论不等于穷尽审计。以上为同一代理的不同审查轮次，建议后续由不同工具或背景的独立审阅者再次审查高风险恢复/鉴权路径。

真实监督器鉴权状态读取、生产一致性快照 ZIP 完整性及逐项哈希通过。历史迁移 SQL/快照逐字节未变，journal 旧前缀完全保留。生产 HTTPS 最终重启后会话仍有效，第二写入者启动被数据库锁拒绝。
