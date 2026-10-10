# Android 构建与验收记录

日期：2026-10-07。基准提交：`40f84d9a17b7ca68e3134f2093afba82fb687c11`。
当前分支：`android`。实现保存在本地工作区，未推送；来源身份同时记录基准提交和
逐文件源码 SHA-256，不能将基准提交单独当作最终实现源码。
未合入 `windows` 专属代码；两个原有未跟踪诊断 JPG 保留。

当前 Apple 风格版本、us HTTPS 验证与设备结果见 [最新验收](apple-style-acceptance.md)。先前 MuMu 启动阻塞已恢复；历史中断记录保留其时间范围。

## 交付物

- 工程及说明：`platforms/android/README.md`。
- APK：`platforms/android/app/build/outputs/apk/debug/app-debug.apk`，调试签名，非商店发布包。
- 构建身份：APK 同目录 `build-receipt.json`；记录完整输入源码哈希、工具链及未提交修改。
- 功能入口、通过范围及剩余门槛：[feature-matrix.md](feature-matrix.md)。
- 脚本：构建、原生双 ABI 编译、解析器打包、安装、隔离设备测试、生命周期及 APK 校验均在 `platforms/android/scripts/`。

APK SHA-256：`439a0ea6a3ccb12e85f6f0744b8beec09d3fdd5d499265acc8c54fc597ca7c91`。
源码清单 SHA-256：`c101eae5265664523aa710a54769a2e39dd0b8dba8d1392e08308e7d4854d856`。
源码清单按 UTF-8 路径排序，并使用脚本规定的规范 JSON 格式计算；文档修改不进入运行源码清单。

## 构建环境

| 项目 | 实际版本 / 配置 |
|---|---|
| Gradle / AGP | 9.6.0 / 9.4.0，Wrapper 与依赖锁文件 |
| Compose compiler / BOM | 2.4.20 / 2026.09.00 |
| JDK / Rust | Android Studio JBR 25.0.3 / rustc 1.93.1 |
| SDK / build-tools | android-37.0 / 36.0.0 |
| NDK | r28c，28.2.13676358 |
| Android 范围 | minSdk 26、targetSdk 37；实际设备 API 35 |
| ABI | arm64-v8a、x86_64；实际 MuMu 运行 x86_64 |
| MuMu / Android | MuMu 6.8.1.0；VM 1，Android 15；ABI 列表 x86_64、arm64-v8a、x86 |
| System WebView | 110.0.5481.154.1；本地 bundle 包含兼容 polyfill |

两种 ABI 均编译；APK 的六个 `.so` 均检查每个 ELF LOAD 段不小于 16 KiB，
`zipalign -c -P 16 4` 和签名校验通过。该静态检查不等同于在真实 16 KiB 页大小手机运行。

## 回归结果

| 验证 | 结果 | 范围 / 限制 |
|---|---|---|
| Web check / lint / build | 通过 | 共享色板抽离后重新执行；构建保留既有 bundle 大小警告 |
| Web Vitest | 611 通过、53 跳过；120 文件通过、8 跳过 | 跳过项未视为通过 |
| Rust workspace | 168 通过、15 ignored | MySQL、真实 HTTPS/Provider、桌面 PDFium/mobitool 的显式环境验收未执行 |
| Rust Clippy all-targets | 通过，`-D warnings` | 限制 Cargo 并发 2；避免 Windows 链接资源不足 |
| 部署监督器 | 15 通过 | 未部署生产服务器 |
| Android JVM | 15 通过 | UTF-16、阅读位置/前台计时、AI 分块、认证、地址、脑图、编辑重试、双链导航 |
| Android Lint / APK | 通过；Lint 0 errors、29 warnings | 警告未隐藏；完整报告保留在构建目录 |
| MuMu 仪器测试 | 当前 APK 18 通过、2 真实服务器用例跳过 | 独立 us HTTPS 1 通过、1 认证用例跳过；本地功能及生命周期复测通过，详见最新验收 |

设备用例覆盖：

- 实际 JNI：Unicode、孤立代理项拒绝、陈旧版本拒绝、SQLite 重开、原文件持久化、Keystore。
- APK 内解析器：TXT、FB2、EPUB、PDF、MOBI、AZW、AZW3；损坏输入、空 TXT、DRM/KFX 拒绝。
- 阅读：原版 PDF 全文搜索与画布、重排正文、emoji UTF-16 定位、EPUB 脚注及双语呈现。
- Compose：笔记中文编辑和旋转草稿、引用回原文、脑图节点编辑、学习集详情、复习评分、图谱视图。
- 导入边界：FileProvider URI 超限拒绝；提交前取消不创建业务记录。
- 触摸链路：系统分享导入→正文→emoji 选文→蓝色下划线/批注→夜间主题→全文搜索→原生 AI 面板。
- 文件夹：创建/学习图标/筛选；两本书批量移动、移出、作者编辑、批量删除。
- 隔离真实 Rust HTTP 服务：账户初始化/登录/修改，独立 Cookie/节点认证，双向元数据及原文件传输、失效后离线修改和恢复。
- 整体合并：实际 Android JNI 的 ID 冲突、引用重建、原文件、幂等重试；Host 另测合并中断和原历史不改写。

测试使用公开合成数据及隔离服务；未使用生产书库。现有 MySQL、SQLite、IndexedDB
结构和迁移链未变更，未触碰历史迁移或账本。此处的同源数据契约测试不能替代实际
Android 与浏览器同屏并发编辑的完整验收。

## 设备环境中断和恢复

反复启动测试 Activity 后，MuMu 的 `system_server` 于 17:37 报
`sensor listeners size has exceeded the maximum limit 128`，导致仪器测试返回
`INSTRUMENTATION_ABORTED: System has crashed`。异常进程为 Android 系统；
随后 shell 工具出现的 SIGSEGV 也不计为应用 JNI 崩溃。
保留中断日志，恢复虚拟机后重新执行；只有输出 `OK (N tests)` 的完整运行算通过。
原 VM 1 保留；创建了 mini 模式 VM 2 作为隔离测试实例（ADB `127.0.0.1:16448`）。
Android 15 冷启动在两个实例均出现卡住，恢复 MuMu 虚拟化后台后继续复测。
恢复后台后，隔离 VM 2 仍返回 `VERR_ROM_START_TIMEOUT`（-30104）。已停止测试实例，
保留原 VM 1 和新增 mini VM 2 的磁盘。没有重启 Windows 或修改宿主机虚拟化设置。
该历史版本当时处于环境阻塞。随后 VM 1 恢复，当前 Apple 风格 APK 已安装并通过完整本地仪器与生命周期复测；取消引用/双链新增操作仍按矩阵单独记录。

已有证据位于 [evidence/](evidence/)：Web/Rust/Android 构建日志、公开合成测试日志、
源码 receipt、系统崩溃日志及旧版本生命周期报告/截图。没有归档私有 SQLite、
凭据或整个设备 logcat。

此前生命周期运行通过冷启动、Home、force-stop 后恢复、系统返回、MuMu 横竖屏、
覆盖安装及全部 19 条测试笔记逐条哈希一致。该记录属于当时 APK
`ac6785a50cb026056877d98af1612b787e427273b65f9790129b9a4fb3d67775`，
不能直接作为本页最终 APK 的生命周期证明。当前安装包对应新生命周期记录 `evidence/apple-results.json`，旧记录仍仅证明当时哈希。

## 仍未完成的验收门槛

真实 HTTPS 账号界面及完整首次合并确认流、实际浏览器双向并发修改、上传中途断网、
多服务器切换、WorkManager 周期/Doze、真实 AI Provider 与服务器 Codex/owner 管理、
系统文件选择器及分享目标回执、无障碍读屏、全部排版/目录/脑图触摸组合，仍需按矩阵验证。
API 26、arm64 真机、真实 16 KiB 手机和低内存随机杀进程未验证。
本次不包含正式发布签名和应用商店上架。

已交付可构建源码与 APK；**尚不能宣布全部网页功能对齐完成**。
未来验收应更新矩阵和对应 APK 哈希，不得用源码存在、按钮可见或一次构建代替功能验收。
