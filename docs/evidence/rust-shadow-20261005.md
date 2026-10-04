# Rust 服务器替换第一阶段实测（2026-10-05）

基线 base a040ed4584f043ef521c7cb3444eb17c639087e6；本阶段不改数据库 schema，
不改生产公网路由。实施方案见[替换计划](../rust-server-replacement-20261005.md)。

## 已部署

`us.jiusi.org` 的 systemd `shufang-rust-shadow` 服务已经运行，执行
`/opt/shufang/rust-shadow/bin/shufang-service`，绑定 `127.0.0.1:31418`。
工作区为 `/opt/shufang/rust-shadow/workspace`，使用独立 service token、
replica token 和节点 ID `linux-rust-shadow`，不共享 Node 的运行目录或写入权。
环境文件仅 root 可读；进程使用独立无登录系统账号 `shufang-rust`。
unit 配置包含 `--read-only`、只写本地工作区、禁用提权和 256 MiB 内存上限。

Linux x86_64 Release 在本机 WSL 构建，避免生产服务器承担编译负载。
Windows 保存的 Linux 产物、本机 Linux 和远端二进制的 SHA-256 相同：
`99ed144c9a61cf045de963f12021431127b93a76c6f10919ace97ae5027b23c9`。

## 验证

- 新增测试先因缺少只读模式失败；实现后 Windows/Linux 两项只读 HTTP 和
  实际网络复制测试通过。测试覆盖未知写入路径、v1/v2 写入、文件上传、版本
  删除、OAuth 授权 GET；允许健康检查、查询及只读 MCP。真实两库测试证明候选
  接收大字段正文，而本地旧操作和原文件不发给上游。
- Windows `cargo test --workspace --locked`、Clippy `-D warnings` 通过；
  Linux `cargo build -p shufang-service --release --locked` 及两项新测试通过。
  Node check/lint/test/build 和 11 项部署监督器测试再次通过。
- 远端 `/health` 返回 `ok=true, readOnly=true`。实际 v2 push、native 创建笔记、
  v1 删除书籍请求均返回 503；回环端口之外没有监听。初次观测 systemd
  NRestarts=0，MemoryCurrent 约 104 MiB。生产 Node 容器仍 running、重启 0。
- 候选通过真实生产 HTTPS 入站复制取得 2644 条原操作、66 条实体状态。
  9 本书的 ID、标题、作者、格式、内容哈希与 Node 完全一致；本地 19 个
  内容寻址对象逐个 SHA-256 校验有效。
- 候选重启后仍保留 2644 条原操作、66 条实体，NRestarts=0；新版 MCP
  tools/call 实际请求返回 200 且无错误。生产 HTTPS session 返回 200，
  Node 重启次数仍为 0，MySQL 原操作数仍为 2644。

## 明确的替换阻塞

真实 API 差分发现，Rust `/api/v1` 采用旧镜像 REST 投影，Node 当前生产启用
sync legacy bridge，返回完整读取器状态。9 本书的响应在 chapters/chapterCount、
封面、folder、metadata、outline、progress、progressByDevice、readingSessions
等字段不完全一致；2 个高亮在 bookId/bookExtId、bookTitle、citationLevel、
aiQa、cloze、tags 等字段存在差异；学习集有 id 字段差异。
这些是响应契约阻塞，不能将“实体和原操作已接收”推断为“所有 API 已兼容”。
Node 浏览器登录会话、账户管理、library 路由及部分 AI/tRPC 仍待迁移。

本阶段部署只读 Rust 候选作为替换起点。生产 MySQL 继续承担现行账本，
SQLite 只用于独立候选；最终数据库形态另行确定。候选复制仍会在上游创建
同步快照，但不会向上游提交业务操作或上传文件。候选凭据当前由上游原有同步
凭据机制管理；后续需在存储方案中设计服务端读取范围，不能把当前 token 宣称
为由上游强制执行的只读凭据。

停止本阶段可执行 `systemctl disable --now shufang-rust-shadow` 并撤销
`rust-shadow-20261005` 同步凭据；生产 Node 与生产库继续运行。候选不应去掉
`--read-only` 或用于公网接管，直到计划中兼容、鉴权、数据转换和停写门槛通过。
