# macOS 原生应用

SwiftUI / AppKit / PDFKit 界面，业务写入经过 Rust C ABI 1 和 SQLite 用例。
最低系统声明 macOS 13；本轮没有数据库 schema 或历史迁移变更。
本目录负责 Mac，其他平台由各自负责人推进。

## 构建与测试

```sh
python3 platforms/macos/scripts/build.py --universal
```

需要 Xcode、Rust 1.93.1。脚本支持仓库 `.tools/rust` 工具链，自动构建固定
libmobi v0.12 来源、Rust 动态库、Swift 应用、真实 ABI/HTTP/PDFKit 测试、
ARM64/x86_64 通用包及 macOS XCFramework，并校验本地 ad-hoc 签名。
测试缺少必需动态库或解析器时失败，不以跳过替代验证。

输出在 `~/Library/Caches/Shufang/macos-local-build/`：

- `Shufang.app`：本地试用包。
- `ShufangCore.xcframework`：仅 macOS ARM64/x86_64 静态库，不包含 iOS。
- `build-receipt.json` / `source-manifest.json`：来源提交、未提交状态、源文件和包哈希。

生成包放在 iCloud 目录之外，避免 Finder 元数据导致签名失败。
正式 Developer ID 签名、公证和分发仍需发布负责人执行。

## 已接入的能力

书库与文件夹、TXT/EPUB/FB2/MOBI/AZW3/PDF 导入、章节阅读与进度、PDFKit
原文件阅读、批注与引用、关联、便携手写附件、笔记 Markdown 预览、脑图、
学习集与复习、分页搜索、账户与同步冲突、备份预览与恢复、版本恢复、AI
配置/任务/结果保存。原生工具栏、菜单、快捷键、拖放和退出草稿保护已接入。
具体证据与未验收项目见 [DELIVERY.md](DELIVERY.md)。

## 生命周期、数据与凭据

`RustCore` 在串行队列调用 ABI，释放输入/输出缓冲区；动态库进程常驻。
`LibrarySession` 关闭前等待已接纳命令，拒绝新命令并取消 Rust 后台作业。
UI 取消通过 Rust cancelJob 请求执行，不能被解释为撤销已提交的写入。
作业取消等待采用有界轮询，耗时解析不会阻塞 UI 主线程。

每个账户/服务工作区使用独立目录。切换先验证新 session，失败保留旧库；
未配对本地编辑不会自动归属新账户。读取全记录后按版本保存，冲突保留草稿。
阅读检查点仅在对应书籍元数据未改变时更新编辑基线，避免覆盖远端元数据。
恢复先预览、校验计划及安全备份，整库与版本恢复写入新目录后再切换。

Mac 宿主通过不可替换的进程回调接入 Keychain，按规范化工作区隔离，
禁止同步；凭据不进入 SQLite、同步和备份。App 安装回调失败时拒绝启用，
不静默降级到文件凭据。HTTP 仅允许 HTTPS 或本机环回 HTTP，不跟随重定向。

共享核心的孤立 UTF-16 代理字符业务 DTO 完整性仍需核心负责人解决。
原始 ABI JSON 转义保留测试通过，不代表所有类型化业务路径均已无损。
