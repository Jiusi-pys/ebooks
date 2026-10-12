# macOS 剩余交付与验收

范围：macOS 原生 UI、Mac 平台解析/凭据/后台任务，以及相应真实桥接测试。
共享业务规则使用现有 Rust 命令；不更改数据库 schema、历史迁移或其他客户端。

顺序：书库/原文件与阅读 → 批注/引用/关联 → 学习/脑图/搜索 →
同步与账户隔离 → 备份预览/恢复 → AI、菜单、拖放、运行验收。

平台专项设计：PDFKit 提供 PDF 页面、文本与坐标，Rust importParsed 原子持久化。
Mac 凭据通过进程内注册的 Keychain 宿主回调读取/写入，按规范化 workspace 路径
分隔账户；不将密钥加入 SQLite、同步或备份。回调仅作用于 macOS，不改变 ABI 1
已有入口。未安装宿主时既有测试/命令继续原方式运行，Mac App 安装失败拒绝启用
凭据功能，不静默降级到文件。安装回调、输入长度、错误和跨 workspace 隔离要测试。

作业由 Rust 创建、报告进度和取消；Mac 只串行发起、轮询与转换 UI 状态。
关闭时取消后台作业并等待结束，不能因取消回调而宣称已提交写入撤销。
恢复先取得 Rust 预览，用户确认后提交相同计划；保留自动安全备份和冲突拒绝。
账户切换使用独立目录/身份，不能把未配对本地编辑自动归给某个账户。

验收：实际动态库 + 临时 SQLite、真实 PDFKit 文件与本地 HTTP 服务、重启、
冲突拒绝、作业取消、保留未知字段和 Keychain 秘密不进入备份。
GUI 验收另记。没有 Intel、macOS 13 机器、正式签名或提供商凭据时，明确记录
NOT_TESTED，不用编译或 mock 宣称通过这些验收。

## 2026-10-11 本轮交付记录

### 已实现

| 能力 | Mac 接入 | 验证证据 |
|---|---|---|
| 书库、文件夹、导入 | 分页列表、完整记录编辑、原文件仓库、拖放 | 105 条分页、未知字段、冲突、TXT/FB2/MOBI 实际解析测试；TXT 窗口导入 |
| 阅读、PDF、位置 | NSTextView UTF-16 选区、PDFKit 原文件、多页锚点、进度检查点 | 中文/emoji 锚点、各旋转坐标、PDF 原字节一致、阅读切换回归；窗口阅读 |
| 批注、笔记、关联 | 引用/解除、关联方向、源位置跳转、Markdown 预览 | Rust 用例与版本检查；窗口中文笔记、引用、搜索、退出重开 |
| 手写 | PDF 鼠标画布、便携附件、旧 PencilKit 内容转换 | 便携格式/未知字段/附件字节测试；初始化数值类型回归通过；修复后窗口绘制、保存、退出重开均通过 |
| 学习、复习、脑图 | 原生编辑、学习集、评分与答案 | Rust CRUD/复习测试；窗口启用复习、显示答案、评分及队列更新 |
| 账户、同步、凭据 | 独立工作区、Keychain、真实 HTTP 作业与冲突处理 | 实际 Keychain 隔离/错误边界、真实 Rust HTTP 双向同步、幂等、冲突副本、401、取消、失败切换保留旧库 |
| 备份与恢复 | 预览、计划校验、安全备份、整库与版本写入新目录 | 实际 SQLite/附件备份、过期计划拒绝、幂等、操作队列/身份保留、旧库和当前编辑保留 |
| AI | Keychain 配置、核心任务、对话保存、脑图/卡片/翻译结果保存 | 结果校验和保存测试；实际提供商网络调用 NOT_TESTED |
| Mac 交互 | 菜单、快捷键、文件面板、拖放、取消、关闭与草稿保护 | 原生窗口操作；侧栏点击区域回归修复；关闭与编辑基线测试 |

### 最新测试与包

- `cargo fmt --manifest-path base/Cargo.toml --all --check`：通过。
- `cargo clippy --manifest-path base/Cargo.toml --workspace --all-targets --locked -- -D warnings`：通过。
- `cargo test --manifest-path base/Cargo.toml --workspace --locked`：212 通过，0 失败，20 忽略。忽略项保留原有需要外部环境的门槛，不算通过。
- `python3 platforms/macos/scripts/build.py --universal`：通过，包含真实 ABI/HTTP 的 Swift 26 项测试，0 失败。
- Intel 测试 bundle 编译通过；用 `/usr/bin/arch -x86_64 .../Developer/usr/bin/xctest platforms/macos/.build/x86_64-apple-macosx/debug/ShufangMacPackageTests.xctest` 运行：26 通过，0 失败。设置 `SHUFANG_MAC_CORE` 为 Intel Rust 动态库，并提供真实 HTTP 服务、MOBI 解析器及固定样例路径。默认 ARM SwiftPM 测试宿主不能加载 Intel bundle，故直接使用 Intel xctest 宿主运行。
- ARM64/x86_64 应用、Rust 静态/动态库及解析器均构建；macOS XCFramework 生成成功；`codesign --verify --strict` 通过。
- 产物：`~/Library/Caches/Shufang/macos-local-build/Shufang.app`。同目录的 source-manifest 与 build-receipt 绑定具体源文件及二进制哈希，源码工作区未提交，不能仅凭 HEAD 重现本包。
- 日志：`.tools/macos-build.log`、`.tools/macos-rust-checks.log`、`.tools/macos-rosetta-tests.log`；独立验收状态在产物目录 `acceptance-receipt.json`。

HTTP 测试使用真实 Rust 服务路由与 SQLite 业务数据；账户存储是隔离的内存测试适配器，不能当作生产 MySQL 鉴权验收。所有测试采用临时书库和合成凭据。

### 实际窗口记录与剩余门槛

已实际操作：TXT 导入、中文/emoji 阅读选区及批注、编辑批注、笔记保存、引用、源位置跳转、搜索、复习评分、退出并重开数据保留、PDF 导入和显示。
窗口验收发现空白手写画布的 Swift 本地数值类型校验错误，已修复并补回归测试。首次续验因锁屏受阻，用户解锁后继续。随后补上 PDF 手写窗口标题，修复工具无法定位空标题弹窗的问题。最新通用包已实际绘制笔画并保存，界面显示“保存手写完成”；Cmd+Q 退出后重新启动同一隔离书库，重新打开 PDF 手写，笔画可见且撤销笔画按钮可用。该路径窗口验收 PASS。标题变更后 ARM64 与 Rosetta 的 26 项测试均重跑通过。

以下不宣称验收：真实 Intel 硬件、最低 macOS 13、正式 Developer ID 签名/公证、实际 AI 提供商、生产部署、GUI 全能力矩阵。
新增 Mac CI 工作流使用专用 self-hosted Mac 标签，但尚未发布/注册 runner，不能宣称远端 CI 已运行。
共享核心现有孤立 UTF-16 代理字符的类型化业务路径缺口仍需共享核心负责人处理；原始 JSON 转义保留测试不替代该项。
无 iOS 迁移或 iOS XCFramework 运行证据。通用业务规则仍由 Rust 提供，Mac 未增加第二份规则实现。
