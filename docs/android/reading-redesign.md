# 阅读界面重新设计

2026-10-08，`android` 分支。此次修改限于 Android 界面与相关设备测试，没有修改同步协议、数据库结构或服务器部署。

## 设计取舍

参考 [Notion](https://www.notion.com/product/wikis)、[微信读书](https://weread.qq.com/) 和 [Apple 的界面材料设计](https://developer.apple.com/design/human-interface-guidelines/materials)，采用原创组合：纸白画布、墨色文字、克制的墨绿重点色、封面网格、细分隔线和紧凑悬浮导航。不使用这些产品的商标、专有字体或界面资源；导航使用高不透明度 Surface，不宣称实现了 Apple Liquid Glass 光学效果。

- 书架：取消重复页标题，封面网格自适应列宽；无封面的书使用原创排版封面。保留作者、格式、真实阅读进度、文件夹和批量操作。
- 笔记及其他列表：改为文档式排列、较轻的图标和分隔线，减少大块重复圆角卡片。
- 导航：四个固定入口仍为书架、笔记、复习、设置，使用紧凑悬浮底栏；语义中保留 Tab 角色与选中状态。
- 阅读：常用入口收敛为目录、排版、笔记、AI、更多。字号、书摘、引用、书目、封面、分享、PDF 模式、双语和沉浸功能仍可在工具面板操作。
- 设置：统一卡片边框、间距和文字层次。现有账户及服务器操作保持可用。
- 对比度：浅色辅助文字 `#6B7068` 对纸白 `#F8F7F4` 的对比度约 4.73:1；深色主题沿用独立颜色配置，但本轮未进行深色设备截图验收。

主要源码：[ReadingDesign.kt](../../platforms/android/app/src/main/java/org/shufang/android/ReadingDesign.kt)、[AppleTheme.kt](../../platforms/android/app/src/main/java/org/shufang/android/AppleTheme.kt)、[MainActivity.kt](../../platforms/android/app/src/main/java/org/shufang/android/MainActivity.kt)。

## 实际验证

| 项目 | 结果 |
|---|---|
| JVM 测试 | 15 通过 |
| Android Lint | 0 errors / 30 warnings |
| APK 构建 | 通过，双 ABI、16 KiB ELF/ZIP 对齐及调试签名检查通过 |
| MuMu 设备交互 | 5 项通过：笔记编辑及旋转恢复、文件夹/批量移动/元数据/删除、引用/脑图/学习集/复习、分享导入/选文/排版/搜索、封面书架及阅读工具 |
| 最终配色后的视觉设备测试 | 1 项再次通过，输出竖屏书架、笔记、阅读器与横屏设置截图 |
| 恢复原账号后的真实 us HTTPS | 2 项通过：公开会话状态、已登录账号会话及同步能力读取；不代表全量双向同步场景全部通过 |
| 原账号及工作区 | 原四个连接字段已恢复并逐项核对，其他现有偏好保留 |

证据：[构建](evidence/redesign/ui-redesign-build.log)、[设备回归](evidence/redesign/ui-redesign-device-final.log)、[视觉用例](evidence/redesign/ui-redesign-visual-final.log)、[APK 检查](evidence/redesign/ui-redesign-apk-check.log)、[构建输入记录](evidence/redesign/build-receipt.json)。最终一次生产源码修改只是提高辅助文字对比度；之后的视觉用例与真实账户读取均使用最终安装包。

设备测试实际发现并修复了两个问题：封面下方操作按钮可能被软键盘遮挡，现移到封面右上角，并支持搜索键收起键盘；横屏阅读工具面板高度不足，现跳过半展开状态并限制内部滚动区高度。

测试隔离事件：本轮开始时发现模拟器已经登录 us，旧 UI 用例却假定离线。其中分享用例误导入一份本轮生成的 `Touch-ecde07ae` 样例；已按唯一 ID 和原创测试正文核对，删除后通过真实账号同步完成清理，见[清理结果](evidence/redesign/ui-isolation-cleanup.log)。随后临时移除连接字段、在原离线测试库复测，结束后恢复原连接。四个会写数据的 UI 用例已增加离线前置检查，避免再次在已连接账号中运行。

截图使用测试中临时生成的原创样例书，测试结束后移除。它们是实际 Compose/阅读 WebView 的运行图，不是设计稿。

- [书架](evidence/redesign/shelf.png)
- [笔记](evidence/redesign/notes.png)
- [阅读器](evidence/redesign/reader.png)
- [横屏设置](evidence/redesign/settings-landscape.png)

`evidence/redesign/reader-tools.png` 仅捕获了弹层下方 Activity，**不作为弹层截图证据**。组合清理命令被自动审批拒绝（仅返回 `blocked by policy`），因此保留该文件；工具面板的操作可达性由设备断言验证。没有用该截图宣称弹层视觉验收。

## 安装包

[app-debug.apk](../../platforms/android/app/build/outputs/apk/debug/app-debug.apk)，已覆盖安装到 MuMu Android 15 / x86_64，现有账号继续可用。

SHA-256：`44a70abcc1842860b8975b4cd083cdfd5e4f20b15bca666ae360e23d2dc8c3e9`

本轮复用原 JNI 库，只重编译 Android UI；未更改图标和共享 Rust 核心。未进行应用商店签名、arm64 真机测试、全格式或真实 AI Provider 复验，不以本次界面验收替代原功能矩阵的剩余验收。
