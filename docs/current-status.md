# 最新后端状态（2026-10-05）

生产已切换为 Rust 后端，保留 MySQL 8.4；MySQL 最新迁移为 0015，SQLite 0003、IndexedDB 11 保持原版本。原前端构建文件保留。真实数据库、HTTPS、跨节点同步、整库恢复后的单写入者切换与独立备份证据见[最终验收](evidence/rust-production-20261005.md)。以下章节保留之前阶段的历史范围。

# 当前工程状态（2026-10-03）

> 2026-10-05 后端 `base` 修复工作树的增量结果见
> [后端修复记录](backend-remediation-20261005.md)，生产 MCP 与恢复切换证据见
> [验收记录](evidence/mcp-production-20261005.md)。本页下面的旧验收表保留其
> 原始时间范围；新增验收以链接记录为准。

> 后端替换第一阶段：服务器已部署独立只读 Rust 候选，生产 Node 仍独占写入；
> 真实接口差异和验收见[候选实测](evidence/rust-shadow-20261005.md)，
> 后续切换门槛见[替换计划](rust-server-replacement-20261005.md)。

本文是当前工作树的状态入口；日期命名的计划、版本说明和验收文件保留各阶段历史。
提交源代码不等于发布或生产切换。最新完整证据见
[继续实施记录](shared-core-040-execution.md)及
[校验清单](evidence/shared-core-040-continuation-20261003.json)。

## 分支与架构

- `base`：共享 Rust domain/application、SQLite/原文件仓库、WASM/C ABI、独立服务，
  以及现有 Node/MySQL、React/IndexedDB 适配、部署和完整迁移历史。
- `windows`：继承 `base`，增加 `platforms/windows/` 的 WinUI、C# 桥接、文档渲染、
  安装/卸载、更新发布和验收工具。共享核心仍位于 `base/`，不复制到视图层。
- `platforms/examples/` 是 ABI 接入示例，Android/iOS 尚无实际构建或运行验收。
- 仅 `main` 触发生产自动部署。推送以上分支不切换生产书库，不发布新包。

Rust 核心不依赖 React、WinUI 或平台 ViewModel；WASM 排除原生 SQLite 适配。
现有 Web 业务尚未全部迁入 application。原生业务接口仍有孤立 UTF-16 代理项
兼容缺口；不能把无损 replica/JSON 模型验收表述为所有读取器已经兼容。

## 数据与同步

当前 MySQL 迁移为 0014、SQLite 为 0003、IndexedDB 为 11。
MySQL 历史链保持 0000–0014；SQLite 支持 0/1/2 一次顺序升级至 3、重复打开、
失败回滚重试和数据保留；浏览器验证 8/9/10→11、重复打开及升级失败重试。
完整归档和校验见 [迁移历史](../app/db/migration-history/README.md)。
旧数据库版本升级分支和已发布迁移不可改写；程序回退不会撤销数据库迁移。
备份迁移源不等于备份书库。生产恢复必须包含数据库、原文件、运行配置及独立密钥，
在新目录/隔离数据库验证后才能切换，旧写入者必须停止。

大于 128 KiB 的字段按 256 KiB 分块，单对象最多 256 MiB。Web 业务/状态/outbox
事务和 Node 本地操作接入首次提交前外置；发送回执失败保留原 ID/内容。
书籍与 source 使用同一 ID，首次导入原子提交。上传进度和最终回执校验不符时
不能清队列；Node 内容寻址仓库校验实际 SHA-256，可重新上传修复损坏对象。
仍需处理旧未配对工作区、超大旧内联原操作及个别 REST 提前分配 ID 的路径。

Web、MySQL、SQLite 网络快照使用持久暂存、重启续传、最终事务及接收游标并发
校验；包括失效游标恢复和五分钟反熵。快照不制造原操作，历史另行获取并保留。
快照和未完成上传的回收、配额及完整资源策略仍待补齐。

## 已验证与未完成门槛

| 验证范围 | 当前结果 |
| --- | --- |
| Web check / lint / build | 通过；已有大 chunk 提示 |
| Web Vitest | 118 文件通过、7 跳过；605 项通过、50 跳过 |
| Windows Rust / Clippy | 101 项通过、6 ignored；通过 |
| Linux Rust / Release / Clippy | 102 项通过、6 ignored；通过 |
| 隔离 MySQL 快照 / 旧 REST | 3 / 6 项通过 |
| Windows C# 桥接 / WinUI x64 | smoke 通过；Release 0 警告、0 错误 |
| Windows 更新器 | 测试密钥签名、失败恢复检查通过；不是生产签名证明 |
| Python 部署监督器 | 11 项通过 |
| 实际生产 HTTPS → Windows/Linux native | 2644 原操作、9 本当前书籍原文件、重开通过 |

真实书库在线预检查备份已完成并核对哈希；隔离恢复包含 66 状态、2644 原操作，
20 个当前引用对象完整。在线备份未停写，不能作为正式切换共同时间点备份。
用户已确认“无本地增量”。现有生产镜像仍运行，尚未切库或发布 0.4.0。

代码缺口：全 Web 业务迁移、原生业务 UTF-16 读取、回收配额、旧工作区过渡，
账户/AI/配置完整交接。环境与验收缺口：实际 Web 登录交互、干净 Windows 登录/
重启、生产 Authenticode、发布者密钥和真实 HTTPS 更新包/清单、外部 OAuth 部署，
最终停写备份/单写入者切换和 24 小时观察。
其他 AI 提供商的代码路径/合成服务测试不能替代各提供商真实凭据验收。

## 本地构建

使用 Rust 1.93.1（含 wasm32-unknown-unknown）、Node 22 和 npm ci。
`npm run check`、`npm run lint`、`npm test`、`npm run build` 从 app 执行；预脚本
从同一源码构建 WASM。Rust 使用 --locked，Clippy 使用 -D warnings。
Linux/headless 凭据需要独立 SHUFANG_CREDENTIAL_KEY 或受支持的环境引用；
测试公开密钥仅用于隔离测试，不能用于生产。
Windows 开发要求见 windows 分支的 platforms/windows/README.md；运行包依赖
WebView2，干净系统验收尚未完成。
