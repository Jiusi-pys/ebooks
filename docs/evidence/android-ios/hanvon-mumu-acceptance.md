# 汉王两种尺寸的 MuMu 实际验收

N10 Pro 二代与原版 Clear7 的尺寸模拟验收已完成。共 16 组布局配置、32 次专项操作通过；两机完整套件各发现 37 项、实际执行 28 项通过、9 项条件跳过，合计 88 次实际测试通过。结果只证明此 MuMu 环境的软件操作与布局，不等同于汉王实体设备验收，也不宣布完整 iOS 1:1 对齐。

## 参数与来源

| 型号 | 屏幕 / 竖屏像素 / 物理密度 | 机身尺寸（第一手评测参数） | 本轮 300dpi 实际窗口 |
|---|---|---|---|
| N10 Pro 二代 | 10.3 英寸 / 1860×2480 / 300 PPI | 226.6×201.6×5.5 mm | 竖屏 992×1323dp；横屏 1323×992dp |
| Clear7 原版 | 7.0 英寸 / 1264×1680 / 300 PPI | 155.7×135.8×3.9 mm；最厚握持部位未核验 | 竖屏 674×896dp；横屏 896×674dp |

[N10 Pro 二代第一手评测](https://zhuanlan.zhihu.com/p/1890129867695170989)、[发布参数交叉核对](https://www.ithome.com/0/842/106.htm)；[Clear7 原版第一手评测](https://post.smzdm.com/p/arr2gqng/)、[屏幕参数交叉核对](https://post.smzdm.com/p/apmlk427/)。N10 Pro 二代不是先前计划中的 10.9 英寸；Clear7 未混用 7.1 英寸锦鲤、C、Turbo 或 Ultra。官方原版完整规格表和出厂逻辑密度未取得，机身数据按评测资料标记。

300 PPI 是物理屏幕指标。本轮以 300dpi 作为模拟逻辑密度，并补测 240/320dpi；不能将其称为汉王出厂 Android 缩放值。Clear7 实测宽度分别为 843/674/632dp，N10 Pro 二代为 1240/992/930dp。机身毫米尺寸不会作为 Android 布局输入；屏幕实际显示面积推算与资料边界见 [模拟方案](../../android/hanvon-simulator-profiles.md)。

## 真实运行范围

MuMu 6.8.2.0，实例 1，Android 15/API35、x86_64，WebView 110.0.5481.154.1。原生 MuMu 配置调整后重启；从 Android、Compose 和 PNG 像素头三方检查实际尺寸，未用固定手机窗口替代目标配置。

- 每机 300dpi：横竖屏各字号 1.0、1.3、2.0；240/320dpi：竖屏字号 1.0。总计每机 8 组。
- 每组真实书架搜索、打开正文、目录/排版/引用/分享工具入口、返回、笔记与设置导航；两份本地四页 PDF 的选择、独立位置、手势同步滚动和退出对照恢复主文档页码。
- 每机完整套件包含真实 JNI、全部解析样例、触摸导入与选文、学习/复习、脑图移动、笔记编辑与界面重建、备份预览/恢复、离线并发冲突、原文件移除/重新下载、附件和认证边界。同步写入只使用随机资料和隔离 Rust HTTP 服务。
- 9 项跳过依赖显式 WAN、跨端过程或模型配置；本轮不将此前其他轮次的 WAN、Apple 或模型证据重复算作新的通过。

| 证据 | 位置 |
|---|---|
| 校验后的汇总、实际每组窗口及 PDF 页内位置 | [hanvon-summary.json](runtime/hanvon-summary.json) |
| Clear7 16 次专项 + 37 项完整套件日志 | [Clear7 目录](runtime/hanvon-mumu-final/) |
| N10 Pro 二代 16 次专项、笔记/设置截图 | [N10 专项目录](runtime/hanvon-mumu-n10-final/) |
| N10 最终完整套件 28 实际通过、9 跳过 | [最终日志](runtime/hanvon-mumu-n10-suite-final/n10pro2-suite.log) |
| 交付/验收包的 51 个 assets 与原生库逐项相同 | [资源一致性](runtime/hanvon-mumu-final/apk-equivalence.json) |

### 遇到的问题及处理

第一次使用默认显示的 `wm density` 时，应用虚拟显示仍为 300dpi，脚本因实际尺寸不匹配停止，未算通过。改用 MuMu 实例的原生逻辑密度并重启后，240/320dpi 的实际窗口和 PNG 均校验通过。控制器追加了退出等待、启动重试和失效 ADB 连接恢复。

首轮 N10 整套运行被连接中断；当时有人工重连干预，不能据此归因于应用。之后完整套件在 `LibraryUiTest` 停住。线程证据表明应用主线程在 MessageQueue 空闲，测试线程在首次界面断言前等待 Compose/Espresso 的下一帧，尚未执行笔记编辑或界面重建；系统未记录 ANR。单纯固定方向和从 160 帧降至 60 帧没有消除该停住。将该用例改为与其他触摸测试一致的 `createEmptyComposeRule + ActivityScenario` 显式生命周期管理后，保留笔记保存、草稿和 `scenario.recreate()` 的所有断言，最终完整套件通过。证据支持测试生命周期与 MuMu 多显示交互问题；不将其描述为已证明的 APP 业务死锁。

失败和人工停止记录保留在 `hanvon-mumu-initial-attempt/`、`hanvon-mumu-final/` 的未完成 N10 部分、`hanvon-mumu-n10-final/` 的中断整套日志，以及 `hanvon-mumu-n10-suite-retry/thread-stacks.log`。人工停止后出现的 `Process crashed` 是终止测试产生的结果，不是自然崩溃证据。汇总只选取明确通过的运行，不覆盖原失败记录。

专项矩阵及 Clear7 整套使用原 160 帧配置；最终 N10 整套为 60 帧。未来控制器默认测试时使用 60 帧并恢复原帧率。该帧率是模拟器设置，不模拟电子纸物理刷新。

## 源码和复现

仍在 `android` 分支，HEAD `40f84d9`，保留未提交内容。本轮仅扩展/修正设备测试、控制器和证据校验；未修改应用业务、Rust、迁移或生产服务。测试 APK 重新编译通过，交付 APK 保持 Android 0.2.0 / versionCode 2，SHA-256 `5d6919ecce8bcdca5968523def9f26f2c2813d7188e507f28e3e50d605275557`。不同轮次的测试包及来源文件哈希见各轮 build-receipt；不要用 Git HEAD 单独代替未提交源码的来源清单。

先构建/安装独立验收包及测试包、构建 Rust fixture，再执行 `platforms/android/scripts/test-hanvon-mumu.ps1`。可通过 `-Profiles clear7` / `-Profiles n10pro2` 独立运行，`-OnlyFullSuite` 或 `-SkipFullSuite` 分开恢复整套/矩阵。`verify-hanvon-evidence.py` 校验本轮保留数据的 16 组配置、32 次操作、PNG 像素、字号、密度与双 PDF 锚点；不通过校验不能宣布上述计数。

结束后将 MuMu 恢复为原 1456×2560、364dpi、字体 1.0、最大 160 帧，重新打开正式应用。原设置与最终恢复结果分别保存于最终整套目录。清理仅针对独立验收包的生成书库，未清空 `org.shufang.android` 用户书库。

## 保留的真机门槛

MuMu 不复现汉王 Android 版本、ARM 性能、真实触笔压力/倾角、物理按键、灰阶、残影、快速刷新及续航。N10 Pro 二代减屏层设备的笔点击和按键映射仍需真机；本轮手势只验证软件事件和布局。当前无需汉王真机即可复查上述模拟结果，但实体笔、刷新和性能仍待设备接入。
