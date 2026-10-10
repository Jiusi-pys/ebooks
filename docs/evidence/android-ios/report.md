# Android / iOS 实际运行与交付记录

## 最新增量：汉王两种尺寸模拟

MuMu 已实际验证 N10 Pro 二代（10.3 英寸、1860×2480）和原版 Clear7（7 英寸、1264×1680）。16 组配置、32 次阅读/双 PDF 专项通过，两机完整套件各 28 实际通过、9 条件跳过；保留密度/窗口/PNG 校验、测试生命周期修正、失败记录及恢复原配置证据。应用业务及交付 APK 不变；完整范围见 [汉王模拟验收](hanvon-mumu-acceptance.md)，实体笔与墨水屏性能仍待真机。

## 当前交付：2026-10-10 离线并发冲突补齐

最新交付为 Android 0.2.0 / versionCode 2，APK SHA-256 `5d6919ecce8bcdca5968523def9f26f2c2813d7188e507f28e3e50d605275557`。持久冲突队列、选择、条件同步、503回执恢复、学习依赖与原文件副本已完成专项及设备验证，us服务器已升级。完整结果、真实HTTPS范围、备份和回退见 [本轮报告](offline-conflicts-20261010.md)；跨端网络为 [第13轮](cross-network/20261010-13/results.json)。下文保留早期交付原始记录，其中“尚未实现离线冲突队列”仅描述该历史时间点，不代表当前状态。

## 历史交付：2026-10-10 备份与PDF补齐

固定 iOS 对照为 `201a87a69f9eb1c9d7c35cbd6ecc94b0a4720856`，1.4.2 build 10。Android 仍在 `android` 分支、HEAD `40f84d9`，保留既有未提交和未跟踪内容。本轮未提交代码，未改写数据库迁移；本报告不宣布完整 1:1 对齐。

可安装调试 APK：`platforms/android/app/build/outputs/apk/debug/app-debug.apk`，134580272 字节，SHA-256 `0c553a70a0487fea8dbe65874c71d77588dc3f458cd3e587e82b24b9e01cccfe`。来源文件清单 SHA-256 `4aae8a62c2f8a8b1e342b0e58c69d1d23f1b9cd2aaa64a4db37173d8dc89c060`，详见 `runtime/20261010/build-receipt.json`。包含 arm64-v8a 与 x86_64，API26 起；仅调试签名，不是正式发布包。设备使用独立包名 `org.shufang.android.acceptance`，对应候选 APK SHA-256 `434cd54774f0ab3cd9efce3f8e17d193e294712f19aeb4758b2d201b81732690`，测试 APK `8f1867b3082466aba0fb6b3efd1356eaf2af70caf26c139612405b3ed613b588`；与交付包的包名及验收网络配置不同，未覆盖用户正式书库。

| 项目 | 已实现及实际运行结果 | 证据 |
|---|---|---|
| 学习备份恢复 | ShufangStudyBackup v1 存储 ZIP；全部资料或指定学习集依赖闭包、原文件与不透明附件；预览、取消、三策略重建引用、提交前数据变化拒绝、整体备份与 Rust 原子提交、幂等重试 | native study_restore 五项测试；三种 Android JNI/Compose 设备套件；cross-network/20261010-11 中 ZIP 往返 |
| 跨端备份 | Android 导出 PDF、PortableInk、学习卡片、复习历史；iOS 实际解析并重新打包；Android 再次恢复，原文件哈希与资料检查通过 | cross-network/20261010-11/restore-android.log、edit-apple.log |
| PDF 双文档 | 两个真实本地 PDF WebView、独立/同步滚动、不同书籍身份、各自锚点保存、结束对照恢复主文档页码；窄屏上下、两侧足够宽时并排 | PdfComparisonTouchTest；pdf-windows/api28-final 21 组、mumu-final 8 组真实截图与尺寸 |
| 移除本机下载 | 未取得远端哈希/大小回执时拒绝；移除已上传原文件缓存、保留书目/学习资料/规范正文，后台同步不自动恢复已移除缓存；显式下载恢复原文件 | Rust local_download；AndroidSyncTest 两个独立工作区及真实 HTTP 服务 |
| 保存冲突界面 | 当前版本与草稿对照、保留当前/保存我的修改/双方副本、再次变化重新确认；关闭后从设置恢复持久草稿 | SaveConflictTouchTest 实际 Compose 操作和新 ViewModel 保存；不是离线同步冲突队列 |
| 跨端业务与手写网络 | Android JNI→实际隔离 HTTP 服务→iOS StudyStore/PencilKit 编辑→Chrome 原生 IndexedDB 与实际 Web 同步模块 CRUD→Android 第三笔→新 iOS 工作区再次加载可编辑笔画；两条复习事件 | cross-network/20261010-11/results.json；publish/receive Android、edit/verify Apple、web-business.json |
| Android 构建 | 23 项单元测试通过、Lint 通过；所有双 ABI ELF LOAD 段及 APK ZIP 16KB 对齐、调试签名校验通过 | runtime/20261010/android-build.txt、android-unit/、build-receipt.json |
| 三种 Android 运行 | MuMu API35、SDK API26、SDK API28 各发现36项、实际执行27项通过、9项条件跳过；网络专项另行显式执行通过 | runtime/20261010/mumu-full.txt、api26-full.txt、api28-full.txt |
| 交付 APK 本体验证 | org.shufang.android 在专用 API26 安装、冷启动、书架界面与进程检查通过；从设备拉回 APK 的 SHA-256 与交付文件相同；已运行验收包与交付包全部51项阅读资源/原生库一致 | runtime/20261010/delivery-smoke.json、delivery-api26.png、apk-equivalence.json |
| Web / Rust / 部署 | Web check/lint/test/build 通过，624通过、53条件跳过；Rust workspace 与 Clippy -D warnings 通过；部署监督器15通过 | runtime/20261010/ 对应日志 |
| Apple | Swift 77项发现，74执行通过、3条件跳过；Xcode 模拟器 App 构建通过；真实网络 XCTest 对最新 Core 另行通过 | runtime/20261010/apple-regression.txt；cross-network/20261010-11/*-apple.log |
| us.jiusi.org 只读认证 | 当前候选 Android 实际 HTTPS 登录、session 与 capabilities 通过；退出并删除设备临时凭据，没有写入生产业务资料 | runtime/20261010/us-android-tls.txt |

设备记录：MuMu Android15/API35，x86_64、WebView110；SDK Android8/API26 与 Android9/API28，x86_64、WebView69。API28 专用测试屏幕原生1024×1280、160dpi，逐组核对实际窗口320/360/412/600/720/840/1024dp × 字号1/1.3/2。MuMu另行验证320/600/840/1024dp × 字号1/2。截图来自实际窗口 PixelCopy；不证明汉王墨水刷新或真实笔性能。

## 修复与失败尝试

真实运行发现 Android8 的系统临时目录不可写，整库安全备份改用书库内暂存。API26/28 的触摸工具不支持新版本显示参数，测试按系统版本选用有效指令。旧 WebView 无法正确应用 PDF.js 的嵌套文字层样式，实际红测显示 static/非透明导致重复文字；打包样式降级到Chrome69并保留平铺兼容规则，最终 ReaderBridgeTest 检查 absolute/透明通过。

双 PDF 首轮返回主文档时，页码状态尚在加载，脚本直接 getInt 抛异常；改为等待有效且正确页码，最终所有窗口重跑。API28 旧虚拟设备原生320px宽，系统把720px覆盖截成640px，实际尺寸检查失败；调整专用 AVD 原生规格后重跑，不把截断尺寸当作大屏通过。失败日志保留在 runtime/20261010/attempts/ 与早期 pdf-windows 目录。

跨端网络前几轮分别暴露了 iOS PDF 卡片缺少章节字段解码、恢复可选 sourceRanges=null、复习创建操作身份与事件身份不一致、浏览器测试同源 CSRF、测试笔记缺少必需日期等问题。修复只新增兼容读取与新事件创建规则，未改写历史操作身份或伪造回执。失败尝试、成功09/10及最终11轮分开保留；隔离业务库留在忽略的 .tools 目录，不进入源码交付。

## 当前仍未完成的门槛

- 保存冲突弹窗已完成；同步发送前发现离线并发修改、持久保存双方版本并要求选择的完整冲突队列尚未实现。当前同步核心仍沿用既有字段版本合并，不能将弹窗当作并发同步验收通过。
- 移除下载释放原文件缓存，规范业务章节仍保留；没有宣称删除全部正文占用或与 iOS 全部缓存策略完全等同。
- 跨端网络使用真实进程、设备模拟器与浏览器，服务器为独立回环 HTTP 环境；不是生产 WAN 业务写入测试。Chrome 运行了实际业务模块，完整网页控件交互未验证。
- 网络用例的笔画为自动化生成，调用真实 Android ViewModel/JNI 保存和 iOS PencilKit 转换编辑；Android InkLayer 的笔事件、撤销重做由另一个设备用例验证。网络用例不替代物理手写、所有笔画冲突操作或全部业务实体往返。
- 学习 ZIP 已验证生成样例与异常输入、重试、三策略核心；全部实体组合、低存储、所有故障注入及完整系统文件选择器触摸流程仍待补齐。
- 旧不匹配复习操作保留历史；转入独立工作区恢复的完整产品入口仍需补齐。没有通过重写旧 operationId 消除错误。
- 物理汉王7英寸/10.9英寸的手写、刷新、性能、arm64运行，及完整旋转/分屏下的所有新弹窗与选择状态尚未验收。iOS PencilKit证据来自专用iPad模拟器；不能推导物理笔效果。

可重复构建、部署、窗口和跨端网络脚本位于 platforms/android/scripts/；准备步骤见 docs/android/network-acceptance.md。各源文件、历史兼容归档和交付 APK 哈希已核验；证据文件清单见 sha256.json。用户凭据、模型文件和用户原资料不进入证据与学习包。

## 历史记录（以下 APK 与数量仅适用于对应旧版本）

# Android / iOS 本轮运行记录

iOS 对照提交：201a87a69f9eb1c9d7c35cbd6ecc94b0a4720856，1.4.2（build 10）。Android 在 android 分支，HEAD 40f84d9，源码含未提交修改；来源文件逐项哈希见 APK 旁 build-receipt.json。本报告不代表 1:1 功能对齐完成。

2026-10-09 历史调试 APK SHA-256：`d2be186ebbe2fbb512bc395e56d89d76df77deb511bf2513c4c350ec65a45265`。来源清单哈希：`1ca3e8648e16dddaf82ba3064190c0879ff9338c1188dd151a2f3da1b78f242c`。源码仍在 android 分支，未提交；完整构建来源见 `runtime/20261009/build-receipt.json`。独立验收包为 org.shufang.android.acceptance，没有覆盖用户正式应用。

## 2026-10-09 本轮增量

本轮完成原生树形画布、触摸跨分支移动与完整展开编辑弹层；点击选择、保存、重启、再次选中均经过设备操作验证。移动保留子树身份、书摘和章节引用；循环、无效目标、中心主题移动、重复身份及超深层级均拒绝。

首次合并补齐不透明附件与通用笔画，手写身份按目标 bookId 重建。本轮 pdfDrawing 使用二进制样例验证不透明传输，不作为真实 PencilKit 解码或网络往返证据。复习历史按新卡片引用导入，保留评分、调度、创建时间、设备来源及小数毫秒，不重新评分；历史身份不能覆写。旧计划遗漏历史或已提交旧手写身份时拒绝继续，保留原库和原计划，不静默改写。

| 项目 | 当前结果 | 本轮证据 |
|---|---|---|
| Android 单元测试、Lint、APK | 单元测试与 Lint 通过；双 ABI 的全部 ELF、ZIP 16 KB 对齐及调试签名通过 | runtime/20261009/android-build.txt、android-unit/ |
| MuMu / API35 | 29 项发现、23 项执行通过、6 项条件跳过；新增 JNI PDF/手写/历史合并及触摸画布实际执行 | runtime/20261009/mumu-full.txt |
| 官方 API26 / API28 | 两套完整运行均 29 项发现、23 项执行通过、6 项条件跳过；实际 x86_64、320×640px / 160dpi | runtime/20261009/api26-full.txt、api28-full.txt、对应 metrics 与 PNG |
| 画布窗口与字号 | 320/600/840/1024dp × 字号 1/2，8 组实际尺寸核验、触摸移动、保存、重启通过 | mind-matrix/results.json 与截图 |
| 合并异常与历史 | 附件缺失/同长度篡改不发布笔记；恢复后重试不重复；原库变化记录不变；旧/未知计划拒绝；历史覆写与无效评分拒绝 | runtime/20261009/merge-tests.txt、失败测试日志 |
| 共享回归 | Web check/lint/test/build 通过，622 通过、53 条件跳过；Rust workspace 与 Clippy -D warnings 通过；部署监督器 15 通过 | runtime/20261009/ 下对应日志 |

API26 的 Compose 弹窗截图助手不支持低于 API28，改用专用 SDK 模拟器实际屏幕截图；MuMu 与 API28 直接截取画布。首次窗口脚本在重启后读取到 MuMu 默认尺寸，实际元数据核验判定失败，修正为每次启动重新应用并检查窗口后，8 组重跑通过。

连续显示测试曾触发 MuMu 系统进程的方向传感器监听数量超限 128，导致测试中断；另有显示切换期间硬件渲染器断言日志。记录位于 runtime/20261009/attempts/，没有将这些中断计算为通过。恢复模拟器后完成了最终套件。Windows 首轮并行链接内存不足，降为单任务后完成 workspace 回归。

本轮没有新增数据库 schema 或改写 MySQL/SQLite/IndexedDB 历史迁移。版本设计、历史源文件及原始字节校验位于 docs/android/migrations/native-compatibility-002.md 与 compatibility-history/002-study-transfer；Git 禁止对历史归档自动转换换行。

## 上一轮基线证据（适用于旧 APK）

旧 APK SHA-256：`b06a8158b6bc0b078965c56c425bb8f1d1dc051414924af984fe5865929fc598`；旧来源清单：`e60a848f886f00557065dc2e1729e1dfdca6d29cfca16d5340faf962589bded0`。以下 Apple、真实服务器认证、模型和完整旧窗口矩阵来自上一轮，不能推导本轮新增路径已通过网络或真机验收。

## 已取得的证据

| 项目 | 实际结果 | 证据 |
|---|---|---|
| Android 单元测试、Lint、双 ABI APK | 20 项单元测试通过；Lint 与构建通过；arm64-v8a/x86_64 ELF 与 ZIP 均通过 16 KB 对齐检查；调试签名 | runtime/android-build.txt |
| Android 8.0 / API 26、Android 9.0 / API 28 | 官方 x86_64 模拟器，各完整套件 27 项发现、21 项执行通过、6 项条件跳过；320×640px / 160dpi，Chrome/WebView 69.0.3497.100 | runtime/api26-full.txt、api28-full.txt |
| MuMu 完整设备测试 | 27 项发现，21 项实际执行通过；6 项可选凭据/模型/返回笔画测试在普通运行中跳过，分别另行运行 | runtime/mumu-full.txt |
| PDF 后续页摘录 | 实际两页 PDF，第二页文字选区返回 page=2；PDF OCR、原文件哈希不变、导出单点笔画像素验证通过 | runtime/pdf-selection-device.txt |
| 布局与字号 | 320/360/412/600/720/840/1024dp × 1.0/1.3/2.0，共 21 组；每组书架、阅读、笔记、设置及横屏截图，窗口元数据包含实际像素与密度 | windows/results.json 与各目录 |
| 生命周期 | 冷启动、Home、强制结束后重启、横竖旋转、系统返回、覆盖安装；14 篇隔离测试笔记哈希全部保留 | runtime/lifecycle-results.json |
| Android → PencilKit → Android | Android 原生笔事件生成笔画，iPad 模拟器真实 PKDrawing 转换并新增笔画，再回到 Android 新增/撤销/重做及 JNI 持久化；保留原笔画身份及坐标 | runtime/pencilkit-green.txt、android-ink-return.txt；合成笔画 JSON |
| Apple 编译与测试 | Xcode 26.6 iOS 模拟器 App 构建通过；75 项 Swift 测试全部执行通过，包括两个隔离 HTTP 同步测试；专用 iPad PencilKit XCTest 另行通过 | runtime/apple-build.txt、apple-http-tests.txt、pencilkit-green.txt |
| 真实服务器登录 | us.jiusi.org，Android 实际 TLS 登录、会话与同步能力读取通过；测试结束退出并删除设备临时凭据。没有改动线上书籍、卡片或笔记 | runtime/server-android.txt、server-session.json |
| 真实离线模型 | Qwen2.5 0.5B Q4 GGUF，安装校验后仅阻断验收 APP 网络，实际流式输出、取消、重新生成并完成“月球”答案 | local-model/offline-results.txt、partial-output.txt |
| Web 回归 | check、lint、test、build 通过；622 项通过，53 项跳过 | runtime/web-tests.txt、web-build.txt |
| Rust 与部署 | workspace 测试、Clippy -D warnings、部署监督器 15 项测试通过；共享复习样例另有 Rust/Swift 差异测试 | runtime/rust-workspace.txt、rust-clippy.txt、deployment-tests.txt |

MuMu：Android 15 / API 35，实际运行 x86_64；WebView 110.0.5481.154.1。模拟器窗口按当前 Activity 的独立显示调整，截图使用实际窗口 PixelCopy；图片不用于证明墨水屏刷新或汉王笔性能。生命周期工具 uiautomator 在写出新层级后曾以 139 退出；要求实际新层级和 PNG 同时有效，记录工具警告，未将退出代码解释为应用崩溃。

## 2026-10-09 当时未通过的门槛（当前状态见上文）

- ShufangStudyBackup v1 跨端 ZIP/目录资料包、依赖闭包、三种恢复策略、恢复预览与完整失败恢复尚未完成。已有整库 SQLite ZIP 不替代此功能。
- PDF 双文档对照、独立/同步滚动、完整跨书关联与卡片拖入路径、只移除本机下载仍需完成。画布及触摸跨分支移动已取得本轮证据。
- 首次合并的手写身份、附件和复习历史本轮已验证；旧计划的干净暂存库重建产品入口及更完整的整体合并验收仍需补齐。
- 线上 Android↔iOS↔Web 业务增改删、并发冲突选择、附件续传和手写网络往返未验证。登录及 capabilities 200 不等同于这些测试通过。
- 汉王 7 英寸、10.9 英寸真机笔输入、刷新与性能未验证；arm64-v8a 已编译和对齐，尚无实际 arm64 设备运行证据。
- 窗口矩阵验证的是既定五个页面，不能推导全部弹窗、分屏、全部设备及全部操作路径已通过。

Android 9.0 的 2GB 模拟器另行尝试 0.5B 模型，网络在线对照与断网前置检查通过，但内存检查拒绝安装。此项记录为受内存限制，不能记为该设备推理通过；见 runtime/api28-model-memory.txt。基础阅读完整套件已通过。

认证凭据、设备模型和原用户资料均不进入本证据目录。模型为可选安装；基础阅读首次启动不需要模型下载。
