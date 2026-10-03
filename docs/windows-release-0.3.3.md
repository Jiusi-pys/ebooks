> 当前状态（2026-10-03）：见[工程状态与验收门槛](current-status.md)。本文件中的日期/版本记录保留其历史范围；当前迁移为 MySQL 0014 / SQLite 0003 / IndexedDB 11，生产尚未正式切换。

# Windows 0.3.3 验收记录

2026-10-03。本机可执行的发布验收已执行；整个验收仍未通过，外部环境门槛见下文。
范围为 Windows、共享核心、AI 和独立服务。原生跨端联网同步及其余业务迁移继续等待用户指令。

## 不可变交付物

- 包：`.tools/releases/Shufang-0.3.3-win-x64.zip`
- SHA-256：`08F823249C224E1EB6050408D632FC818BBB07B7C4AF0A4B3E8C98C3154DA8BE`
- 来源 HEAD：`f6879718dbc2333b3d39dcfafadb6b8318e0047e`，包含当前工作区改动，不能等同于该提交的原始内容。
- 发布清单逐文件校验通过；源码归档含 578 个条目，包括旧 REST 对照、回归测试和卸载脚本。未包含配置密钥、上传书籍、工作区或构建缓存。
- 本记录在生成包之后写入，位于包外；0.3.3 及此前版本未覆盖。

## 实际通过

| 验收 | 结果与证据 |
| --- | --- |
| Web / MySQL / REST | 119 个测试文件、612 个测试通过，无跳过。含真实隔离 MySQL 和 30 个旧 Hono/MySQL 与原生 HTTP 对照场景。`.tools/final-native-web-mysql.log` |
| Rust | 56 个常规测试通过；5 个默认忽略的原生解析、在线元数据和真实 AI 测试另行显式执行通过。`.tools/final-acceptance-rust.log` 及 `.tools/final-live-*.log` |
| 构建与静态检查 | TypeScript check、lint、Web build、Rust fmt / Clippy、WinUI 和 updater 发布通过；Node 5 个、部署 Python 11 个测试通过 |
| 原生桥接 | Release 模式 C# → C ABI → Rust → SQLite smoke 通过，包含重开、冲突、Unicode、outbox 与维护锁 |
| 精确包安装 | 0.3.3 独立安装、逐文件校验、Windows PowerShell 5 SDK 无关的验收通过。`.tools/release-acceptance-0.3.3-ps5/` |
| UI | 实际运行 0.3.3，在隔离书库显示 EPUB 图片、展开脚注并返回正文；高级目录重命名后关闭、重新启动，标题保留。截图 `.tools/final-ui-033-evidence/outline-reopen.png` |
| 服务与 OAuth | 精确包的独立服务存活、鉴权、单实例、MCP HTTP/stdio、优雅停止通过；单独 Python HTTP 客户端执行发现、PKCE、同意、单次授权码、scope、refresh 轮换与撤销通过 |
| 启动入口 | `--service-start` 启动独立服务后退出，服务仍可访问并停止。`.tools/startup-entry-033/startup-entry.json`。实际登录/重启未验证 |
| 更新成功 | 0.2.2 → 0.3.3，临时测试签名，篡改的可变暂存文件被签名包原件替换；新 GUI 就绪，备份保留。`.tools/update-033-success/workspace/.updates/` |
| 更新失败恢复 | 正确测试签名但无法就绪的新程序触发超时，旧 0.2.2 GUI 重新启动，备份保留，`databaseRollback=false`。`.tools/update-033-failed-start/workspace/.updates/` |
| 更新数据保留 | 两种更新路径的备份清单哈希、备份数据库所有业务表、凭据和更新后实体均核对通过。SQLite 快照按逻辑记录比较，未把 VACUUM 后字节变化误判为丢失。两处 `verification.json` |
| 卸载 | 删除 930 个未修改的发布文件，保留修改文件、嵌套未登记数据和全部独立工作区文件；工作区逐文件哈希不变。`.tools/uninstall-033/uninstall-result.json` |
| 迁移历史 | 三个不可变归档及全部 32 / 33 / 34 个条目哈希通过。两个原生归档与当前源文件字节一致；旧 20260927 归档与工作区的 0014 SQL、0014 snapshot、journal 存在仅 CRLF/LF 差异，证据及文件保留，未改写账本 |

验收启动的 GUI、服务、更新器均已关闭；隔离 MySQL 测试容器已停止并移除。用户书库和其他应用未清理。

## 验收边界

真实 AI 已验证当前已登录 Codex 的原生及 REST 调用和结果持久化，不能推广为所有提供商均通过。
REST 对照覆盖上述 30 个场景及核心回归；错误诊断文本未逐字复刻旧 Zod，时间戳和原生 revision 在有效响应比较时归一化。有限场景通过不能证明所有旧客户端输入都完全等价。
EPUB 已验收规范化正文、PNG/JPEG/WebP、脚注和目录；未将 SVG/GIF 或出版商原始排版标记为已通过。
SQLite 仍为 0002；新的 journal v1 为可选的私有 JSON 快照。旧历史缺少快照时仍走明确的旧行为，不能反向证明旧事件的历史值准确。

## 未通过的外部门槛

1. 干净 Windows 10/11 测试机：本机无 Sandbox，Hyper-V VM 访问被主机授权拒绝，尚无可访问的干净测试机。
2. 在该测试机上的实际登录、自启动及重启。
3. 生产 Authenticode 证书、更新发布者密钥和公钥固定、生产 HTTPS 更新源。临时测试签名仅证明更新机制。
4. 其他真实 AI 提供商配置及外部 OAuth 应用的 TLS/代理部署。独立本地 HTTP 客户端不替代生产部署。

这些前置环境或配置位置尚未提供，已向用户请求，不能记为通过。
完整设计、修复范围及版本兼容步骤见 `windows-final-acceptance-plan.md` 与 `windows-final-acceptance-20261003.md`。
