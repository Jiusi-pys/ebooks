# 書房 Android

原生 Kotlin / Jetpack Compose 客户端，基于 `base` 提交
`40f84d9a17b7ca68e3134f2093afba82fb687c11`，在 `android` 分支开发。
本工程使用共享 Rust application / SQLite；没有 Room 或 IndexedDB 业务副本。
格式解析器从 `app/src/lib/parseBook.ts` 打包，阅读器仅使用 APK 内的 WebView 资源。

## 构建

要求 Windows PowerShell、Python 3、Node / npm、Rust 1.93.1、Android SDK API 37、
build-tools 36.0.0、platform-tools、Android Studio JBR。版本锁定：Gradle 9.6、
AGP 9.4.0、Compose compiler 2.4.20、NDK 28.2.13676358（r28c）。
Gradle Wrapper 校验发行包 SHA-256；Gradle / npm / Cargo 依赖均使用锁文件。

从仓库根目录执行：

```powershell
npm --prefix app ci
powershell -NoProfile -ExecutionPolicy Bypass -File platforms/android/scripts/bootstrap-toolchain.ps1
powershell -NoProfile -ExecutionPolicy Bypass -File platforms/android/scripts/build.ps1
```

`build.ps1` 编译 `x86_64` / `arm64-v8a` Rust 和字节数组 JNI、生成本地阅读资源、
执行 Android 单元测试和 Lint，然后输出 APK 与 SHA-256：
`platforms/android/app/build/outputs/apk/debug/app-debug.apk`。
同目录的 `build-receipt.json` 记录来源提交、逐文件源码哈希、工具版本和 APK 哈希；
工作区有未提交修改时会明确记录，不能只用 HEAD 代替源码身份。
仅构建调试签名 APK；签名密钥、NDK 下载、原生构建输出和 parser bundle 不入库。

Windows 的 Java 参数文件对中文构建输出路径存在类加载问题，生成物默认放在
`%LOCALAPPDATA%/Shufang/android-build/`。可通过 `SHUFANG_ANDROID_BUILD_DIR`
指定另一 ASCII 路径；脚本会将最终 APK 复制到工程内的标准输出路径。
Android Studio 可以直接打开本目录并使用 Wrapper。

## 安装与测试

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File platforms/android/scripts/deploy-mumu.ps1 -VmIndex 1
powershell -NoProfile -ExecutionPolicy Bypass -File platforms/android/scripts/test-device.ps1 -Serial 127.0.0.1:16416
python platforms/android/scripts/test-lifecycle.py --mumu-rotate 1
```

安装使用 `adb install -r` 保留已有数据。设备测试创建独立 Rust 服务端、独立测试工作区、
公共合成认证信息和临时 ADB reverse；不连接生产书库，不放宽 APK 的 HTTPS 要求。
测试后停止自己启动的服务并移除 reverse；日志保存在 `.tools/android-fixture-*/`。

回归命令：

```powershell
npm --prefix app run check
npm --prefix app run lint
npm --prefix app test -- --maxWorkers=4
npm --prefix app run build
cargo test --manifest-path base/Cargo.toml --workspace --locked -j 2
cargo clippy --manifest-path base/Cargo.toml --workspace --all-targets --locked -j 2 -- -D warnings
python -m unittest discover -s deploy -p 'test_*.py'
```

限制 Cargo 并发可避免此 Windows 机器在同时编译多个大型测试时出现链接器
`os error 1450`（资源不足）。不能将该环境错误当作测试通过。

## 数据和凭据

调用链：Compose → ViewModel → Kotlin Repository → JNI C ABI 1 → Rust application。
业务写入经过 Rust 的版本检查、事务和关联清理。分页结果是预览；进入编辑时读取完整记录。
长正文、解析结果与编辑请求通过私有暂存文件传递，原文件保存在 Rust 管理的文件仓库。
WebView 只接收阅读、解析、进度和选择消息；桥不提供任意原生命令。

会话 Cookie 与高级节点 Bearer token 使用独立模式。Keystore AES-GCM 保护账号凭据
及 Rust credential vault 的密钥；密码和 API Key 不写入 UI 草稿、同步数据或导出书库。
凭据和工作区按服务器 / 账号隔离。后台同步由有网络约束的 WorkManager 调度。

首次连接先同步独立目标工作区，再展示整体合并范围。确认后备份原工作区，使用持久 ID
映射重建引用并以目标工作区的新操作提交。失败重试复用同一批次和 receipt；不改写原历史。
目标工作区切换和完成批次的清理一起保存。原书库保持可恢复；设置页可返回合并前书库。
返回原书库不会删除服务器已经收到的合并内容。

本次没有数据库结构或迁移变更，完整保留原有迁移链和历史归档。

## 验收

功能入口和逐项结果见 [功能矩阵](../../docs/android/feature-matrix.md)，
构建、设备版本和验证范围见 [验收记录](../../docs/android/acceptance.md)。
源码实现、编译通过、核心契约测试、MuMu 测试及真实 Provider 验证分开记录。
未完成矩阵中的全部门槛前，不宣称网页功能对齐完成。


本轮 iOS 对照、Apple 构建、真实手写转换、SDK 26/28 与多窗口运行结果见
[Android/iOS 运行报告](../../docs/evidence/android-ios/report.md)。该报告明确列出尚未完成的 1:1 门槛。
生命周期脚本必须显式提供以 `-PshufangAcceptance=true` 构建的 APK：
`python scripts/test-lifecycle.py --apk <验收APK路径> --serial <设备序列号>`。
脚本先验证隔离包名，避免覆盖用户正式包。
