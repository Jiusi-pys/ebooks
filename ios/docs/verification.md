# iOS 验证记录

## 2026-10-02：书内脚注浮窗 1.2.1（build 4）

- 根因：服务端章节接口已返回 `footnotes`（paraIndex/start/end/content），原生 Chapter 的 CodingKeys/解码与阅读器遗漏此字段。已对照部署服务器的 `types/index.ts`、`reader/EpubText.tsx` 和 v1 章节接口修复；不改服务器数据或 API。
- 保留原始段落及 UTF-16 偏移，将脚注编号渲染为可访问链接；显示纯文本原生浮窗，支持滚动、复制、关闭。翻页／切章清除当前浮窗。iPad 与 iPhone 均使用 popover，不跳出阅读页。
- 新下载／备份会保留脚注。旧离线包打开时先显示本机正文，联网后仅在章节 ID 和正文完全一致时原子补齐脚注；断网或失败继续保留原书，PDF 原件不变。若服务器正文也已改变，需重新下载书籍，避免让旧摘录偏移错位。
- 60 项 Swift 测试：57 通过，3 项可选 HTTP 未启用；新增 4 项覆盖解码往返、Unicode、跨页范围、重叠／无效脚注、离线包更新后重开与 PDF 保留。
- iPad／iPhone 模拟器均通过正文内链接激活进入注释浮窗；iPad 关闭浮窗后仍为原章节原文。使用无障碍链接激活验证；坐标点击仍受电脑操作工具窗口定位错误影响，不计作独立物理触摸证据。
- Simulator 与真机签名构建通过，严格 codesign 校验通过；iPad Pro M2 与 Jiusi001 均已安装并启动 1.2.1（4）。

证据：[测试日志](evidence/footnote-tests-20261002.log)、[模拟器构建](evidence/footnote-sim-build-20261002.log)、[真机构建](evidence/footnote-device-build-20261002.log)、[iPad 浮窗](evidence/footnote-ipad-20261002.png)、[iPhone 浮窗](evidence/footnote-iphone-20261002.png)。

## 2026-10-02：学习工作台 1.2.0（build 3）

本次实现采用原生 SwiftUI／UIKit、PDFKit 和 PencilKit；不加载网站 UI。源码、临时本地构建副本逐文件 SHA-256 一致。iCloud 仓库直接构建／读取依赖可能阻塞，因此构建使用本机快照。

| 验证 | 结果与具体范围 |
| --- | --- |
| Swift 核心 | 56 项；默认运行 53 通过、3 项 HTTP 跳过。3 项 HTTP 随后分别启用，均通过。含 8 项恢复、PDF 旋转／裁剪坐标、UTF-16 跨段选择、账户隔离、断网重启、冲突、丢回执幂等、大 JSON 分块、PDF 原件与手写附件 |
| Node 定向测试 | 5 个测试文件、23 项通过，覆盖能力声明、字段保留、blob、同步与跨节点手写附件复制／重试；隔离运行时依赖经 lockfile 完整性验证 |
| Xcode | iOS Simulator 和真机签名构建均 BUILD SUCCEEDED；未使用 CODE_SIGNING_ALLOWED=NO，以保留模拟器 Keychain 权限 |
| iPad 模拟器 | 11-inch M5／iOS 26.5：账户登录、侧栏收起后文档与卡片并列、来源高亮回显／回跳、旋转 PDF 逐页跳转、设备端 OCR、批注保存后在卡片盒及服务器回读 |
| 离线 UI | 测试服务器返回 503 时编辑笔记；界面显示待同步。终止并重启 App 后修改仍在；恢复服务后自动提交，服务器投影回读确认 |
| iPhone 模拟器 | iPhone 17／iOS 26.5：账户登录、书架、中文／英文／emoji 文本渲染、菜单自动隐藏；无障碍“下一页”动作从“学而”进入“为政” |
| Jiusi001 | 1.2.0（3）安装成功；devicectl 确认启动成功。安装保留原 App 数据，无卸载／清空 |
| iPad Pro M2 真机 | 2026-10-02 已开启开发者模式，Xcode 登录后注册设备并更新描述文件；干净构建及 codesign 严格校验通过。1.2.0（3）安装成功，devicectl 确认启动成功；Apple Pencil 实物交互仍待验收 |

iPad 签名更新后的增量构建曾残留不匹配的 Assets.car／描述文件签名；已以 `clean build` 修复，`codesign --verify --deep --strict` 显示 valid on disk。见 [iPad 构建日志](evidence/study-ipad-build-20261002.log)。

日志：[Swift](evidence/study-swift-20261002.log)、[模拟器构建](evidence/study-simulator-build-20261002.log)、[真机构建](evidence/study-device-build-20261002.log)、[Node 测试](evidence/native-study-server-20261002.log)、[Node 来源校验](evidence/native-study-server-20261002.json)。

本轮明确未验收：Apple Pencil 实物书写、压力／掌触、长文档低内存、256 MB 导入、系统终止上传、生产环境双端同时编辑、真实 AI 模型写入、全部 UI 备份文件选择／分享流程。PDF 框选拖拽与 iPhone 屏幕边缘点击／滑动尝试受电脑操作工具的窗口坐标错误影响，不能记为通过；核心坐标与翻页动作测试不能代替手势实测。OCR 样本识别出的 emoji 有误，校正后保存入口已验证。

完整 npm check／lint／test／build 仍被 iCloud dataless 依赖读取超时和磁盘不足阻塞；仅上述定向 Node 测试可记通过。没有部署生产服务器。新节点需升级 `$attachment` 复制兼容补丁才能在服务器之间传送手写文件。协议为可选字段扩展，本次无 SQL 或 IndexedDB schema 变更；本地格式版本和恢复边界见 [study-sync.md](study-sync.md)、[study-backup.md](study-backup.md)。

以下保留此前各版本的历史验证，不代表本版重新执行。

日期：2026-09-14。宿主：Apple Silicon macOS，Xcode 26.6（17F113），iOS SDK / Simulator SDK 26.5。现已安装 iOS 26.2（23C54）和 iOS 26.5（23F77）；默认运行目标已配置为 iPhone 17 Pro（iOS 26.5）。

## 已通过

| 检查 | 结果 | 范围 |
| --- | --- | --- |
| iOS 17 Simulator 目标 Swift 类型检查 | 通过 | 全部原生 UI 和核心源码 |
| Swift Debug 测试 | 9 项通过 | 8 项核心测试 + 1 项真实 HTTP 联调测试 |
| Swift Release 测试 | 8 项通过，1 项联调跳过 | 验证 Release 禁止 HTTP；联调只用于 Debug |
| Xcode 完整 Simulator build | 通过 | 包括 Swift 编译、AppIcon / Assets.car、Sign to Run Locally 签名和产品验证；日志见 xcode-build-success.log |
| 模拟器 UI | 已验证主要读写流程 | 完整构建包：连接、钥匙串保存/恢复、书架、目录、阅读、保存摘录批注、加入复习、显示答案、评分后清空到期队列、新建笔记、编辑后重新打开回读 |
| HTTP 写入与回读 | 通过 | 创建/修改笔记、创建摘录及批注、加入复习、评分后回读并从到期队列移除 |
| `npm run check` / `npm run lint` / `npm run build` | 全部通过 | 现有 Web 项目回归；未更改其运行时代码 |
| `npm test` | 382 项通过，7 项跳过 | MySQL 集成测试未启用，不计作通过 |
| plist / 项目文件格式、Python 脚本语法 | 通过 | 工程可被 Xcode 打开识别 |

Swift 核心测试覆盖：服务器源地址限制、Release/Debug HTTP 边界、路径 ID 编码、接口 JSON 解码、笔记正文缺失时拒绝解码、UTF-16 摘录锚点、与 Web 一致的四档复习调度、认证头、HTTP 401/404/409/500/503、非 JSON、断网及重定向拒绝。

首次检查因平台下载未完成，曾使用手动诊断包。后续配置已改用 Xcode 正式构建的完整 Simulator 包，并在 iOS 26.2 / 26.5 安装运行。Xcode 图形界面在 iPhone 17 Pro（26.5）目标上显示 Running Shufang，重新启动后已从钥匙串恢复样本连接；无需手工模拟签名或在源码中填写团队凭据。后续普通调试直接使用工程中的自动签名。

HTTP 测试运行真实 URLSession 请求，但目标是 `scripts/smoke-server.py` 的回环内存样本。样本只用于客户端联调，不能证明真实 MySQL、服务器 Codex、Webhook 或生产部署成功。

## 本次配置结果与剩余事项

- iOS 26.5 平台安装完成；之前的目标不可用和 asset catalog 不匹配问题已解除。
- 工程已在 Xcode 打开，scheme 为 Shufang，默认设备为 iPhone 17 Pro（26.5）。
- 完整构建结果为 `BUILD SUCCEEDED`；签名为 `Sign to Run Locally`，用于模拟器。
- 已连接 `http://127.0.0.1:8787` 本机样本服务，测试密钥存入模拟器钥匙串。没有配置生产服务器，也没有将任何真实凭据内置到源码。
- 摘录/笔记表单增加了可直接访问的正文内保存按钮，并在保存方法中防止重复提交。对应 UI 保存与回读已验证。
- 提供 `启动模拟器体验.command`：自动选取已安装的最新 iPhone 模拟器、启动/复用本机样本服务、构建、安装并运行。脚本已通过 Bash 语法检查，其构建、安装和服务请求步骤已分别实测；尚未单独通过 Finder 双击做整段脚本验收。

设备检查能看到已配对的 iPhone 和 iPad，但两者当前状态均为 unavailable，未对它们安装应用。

仍未完成：真实 iPhone 签名安装、Archive、TestFlight / App Store、生产 HTTPS / MySQL / Webhook / Codex 端到端验收。需要用户的手机、Apple 账号登录和已部署的服务器；账号密码、验证码和条款由用户本人处理。

旧的 `xcode-build-blocked.log` 与 `asset-build-blocked.log` 保留为历史记录，不代表当前状态。此前 UI 工具的 `cgWindowNotFound` 已恢复。新手操作入口见 `ios/新手开始.md`。

可复现测试命令（仓库根目录）：

```bash
python3 ios/scripts/smoke-server.py
# 另一个终端
SHUFANG_SMOKE_TESTS=1 swift test --package-path ios
swift test --package-path ios -c release
xcrun swiftc -typecheck \
  -sdk "$(xcrun --sdk iphonesimulator --show-sdk-path)" \
  -target arm64-apple-ios17.0-simulator -D DEBUG \
  ios/Shufang/Core/*.swift ios/Shufang/AppState.swift ios/Shufang/Views/*.swift
```

日志保存在 [`evidence/`](evidence/)。Web 构建存在既有大 chunk 警告；本次未更改依赖或自动修复它们。


## 2026-09-27：Xcode 构建服务报错恢复

- Xcode 26.6（17F113），开发目录正确，首次启动组件检查通过。
- 原目录的 Xcode / xcodebuild 进程阻塞在 `NSFileCoordinator` 的递归工程读取。Finder 显示仓库位于 iCloud，部分资源带 `dataless` 标记；重启 Xcode 与用户级云文件服务后，原目录仍反复阻塞。没有重装 Xcode，也没有关闭 iCloud。
- 同源临时副本完整构建成功。随后建立本地工程入口 `~/Library/Developer/Shufang/Shufang.xcodeproj`，源文件、资源和 Info.plist 均直接引用仓库中的原文件，无业务源码副本。
- 本地入口完整构建 `BUILD SUCCEEDED`，见 `evidence/xcode-recovery-20260927.log`。Xcode 中选择 iPhone 17（iOS 26.5）并执行 Run，状态显示 `Running Shufang on iPhone 17`，模拟器显示服务器连接页。没有在本次配置中填写真实服务器或密钥。
- 增加 `打开书房Xcode.command` 和本地入口生成器；原模拟器体验脚本也改用本地入口。两个 shell 脚本语法检查、工程 plist 校验、生成器重复运行不覆盖已有配置检查通过。未重跑未修改的 Web 端测试。
- 排查期间原工程工作区已备份至 `~/Library/Application Support/Shufang/Recovery/20260927-182730/Shufang.xcodeproj`；原工程项目设置和共享 scheme 内容保留，旧窗口状态保存在备份中。
- 此方案绕开云盘工程元数据阻塞，未证明系统 iCloud 服务已完全恢复。源码仍应保留下载。真机签名、生产服务连接与上架仍未完成。


## 2026-09-27：适配工作区同步服务

- 阅读当前 `app/api/v1.ts`、`app/api/sync/legacy.ts`、`app/api/sync/api.ts` 与同步契约，修复新旧书籍/章节/摘录结构差异；v2 复习队列不再读取旧镜像表。增加章节进度 PATCH、PDFKit 原文阅读，以及默认 `https://us.jiusi.org`。
- Xcode 26.6 完整模拟器签名构建成功，已安装并启动于 iPhone 17 / iOS 26.5。截图确认默认服务器和连接页正常，无钥匙串签名报错。最初关闭签名的测试安装曾报 -34018，随后用正常 Xcode 模拟器签名构建解决；未通过 UI 保存生产密钥。
- Debug：12 项测试全部通过，包括本机 HTTP 笔记/摘录/评分读写；Release：11 项通过，1 项 HTTP 联调按设计跳过。新测试覆盖 v2 真实源码对应响应结构、UTF-16 目录字数、工作区复习与服务器时钟、能力检测 404 降级和 401 不降级、进度 PATCH、二进制响应。
- 原目录 SwiftPM 与 git 状态命令长时间无输出；将 Package.swift、Core 和测试文件复制到 `/tmp/shufang-ios-core-validation` 后完成测试，逐文件 SHA-256 确认与原源码相同。
- 尝试 Web `check`、`lint`、`test`、`build`，均停留在启动阶段；采样 TypeScript 进程显示阻塞于文件 `read`。本次停止这些进程，不记为通过，也没有修改 Web 源码或重装依赖。停止后 Web build 日志记录 esbuild `fatal error: all goroutines are asleep - deadlock!`；不将这一中止后的错误视为 Swift 源码缺陷。
- 线上 `/api/v1/books` 与 `/api/v2/capabilities` 的无凭据 HTTPS 请求均返回 401，证实端点可达；未取得生产 API key，尚未验证生产书库、PDF 或跨端写入。
- 证据：`evidence/ios-sync-update-build.log`、`ios-sync-update-tests.log`、`ios-sync-update-release-tests.log` 和 `ios-sync-update-connection.png`。模拟器只验证启动连接页；PDF 和 v2 双端操作尚待使用已上传文件及真实账号验收。


## 2026-09-27：生产密钥接入验证

- 用户授权通过 `ssh us` 获取实际 OPEN_API_KEY；从运行中的 `shufang-app` 容器读取，仅用于 HTTPS 认证和模拟器 App 安全输入，未写入源码、文档或凭据文件。
- 线上容器镜像为 `shufang:41cc53e6ee7633f2f7154d2f6bf6651587e5ae79`，v2 能力接口返回 200、version=2、workspaceId=personal-workspace、nodeId=linux-personal。
- 模拟器 App 验证连接成功并显示 8 本真实藏书；《Alice's Adventures in Wonderland》目录在 App 中正确显示，接口共返回 16 章。对当前章节的只读请求返回 200、24 段正文。摘录接口返回 200、4 条，笔记接口返回 200、2 条。
- 密钥经 App 正常连接流程保存到模拟器钥匙串。本次仅做认证与读取，不创建生产测试笔记或修改阅读进度。真实 iPhone 的钥匙串与模拟器独立，尚未配置真机。
- 终止并重新启动模拟器 App 后，无需再次输入密钥，自动恢复连接并重新加载 8 本藏书，确认钥匙串持久化成功。


## 2026-09-27：完整 Node/React 工作区接入 iOS

- 阅读 Web 产品入口、导航、导入/阅读/笔记/学习集/脑图/图谱/搜索/AI 页面、浏览器本地库与 v2 同步、Node 的身份、书库、开放 REST、AI 和同步路由后，iOS 首页接入同源完整工作区；原生功能移入“快捷阅读”。功能到源码的映射与尚未验收范围见 `full-workspace.md`。
- 网站账户可以只用服务器地址进入，完整工作区不需要机器 `OPEN_API_KEY`。原生快捷入口仍需该密钥。网站会话与 IndexedDB 存在 WebKit 持久存储中；断开 App 连接删除本站 Cookie 而保留本地书库数据。外链仅在用户点击时交给系统浏览器，工作区主页面限制在配置的同源；原生弹窗和下载系统分享表已接线。
- 已构建 iPhone / iPad Simulator 通用目标并签名，`BUILD SUCCEEDED`；iPhone 17 / iOS 26.5 安装启动成功。设置页可无 API 密钥重新验证网站连接。
- Swift Debug 核心测试 13 项：12 项通过、1 项可选 HTTP 桩联调跳过。新增测试验证同源、默认端口、跨域及 blob URL 的导航边界。
- 按仓库要求尝试 Web `check`、`lint`、`test`、`build`，各在 45 秒无后续输出被超时终止；仓库此前存在 iCloud 文件协调读阻塞，本次未改 Web 源码，不能把这四项记为通过。
- 用户亲自在模拟器完成网站账户登录；App 重新安装并启动后仍保持登录。WebKit 工作区显示 8 本藏书、2 篇笔记、4 条书摘；《The Road to Serfdom》阅读页可进入。针对手机宽度，容器自动收起初始目录、让横向翻页使用单栏和 16px 页边距，并修正全局搜索弹框因输入聚焦发生的横向偏移。
- 登录后实际打开笔记列表；全局搜索 `Serfdom` 返回 99 条结果。尚未在 iOS WebKit 实测文件导入、PDF/EPUB 全格式、AI、编辑写入、后台同步和离线行为。线上内容属于用户数据，未为测试额外写入或删除。
- 证据：`evidence/full-workspace-build-signed-20260927.log`、`full-workspace-core-tests-20260927.log`、`full-workspace-reader-20260927.png`、`full-workspace-notes-20260927.png`、`full-workspace-search-20260927.png`。

## 2026-09-27：iPhone 横向翻页宽度修正

- 复现：旧的容器样式把 `column-count` 固定为 1，长章节因此向下溢出。阅读器仍检测到约 25px 横向溢出并计作第 2 页，点一次右翻页正文不变，再点一次便进入下一章。
- 现在按阅读容器宽度设置 `column-width`，让正文分成连续的横向整屏栏；16px 页边距仍适用于手机，且不改变用户同步的阅读设置。
- iPhone 17 / iOS 26.5 已登录工作区中，《The Road to Serfdom》Introduction 的页码从 2→3、3→2 均只需点一次，正文随页码改变。最终版本签名构建成功，诊断弹窗已移除。
- 证据：`evidence/reader-responsive-build-20260927.log`、`reader-responsive-page2-20260927.png`、`reader-responsive-page3-20260927.png`。

## 2026-09-28：改为原生 SwiftUI App

- 用户明确要求 iOS App 独立于网页 UI。本次将首页改为原生书架，移除运行路径中的 WKWebView；原生底部导航为书架、搜索、摘录、笔记、设置。服务器仍使用现有 v1 REST / v2 兼容数据。
- 书架显示生产服务器返回的 8 本书及可用封面。《Alice's Adventures in Wonderland》目录读取到 16 章；打开第 4 章时按屏幕尺寸分页。iPhone 17 / iOS 26.5 上，点一次“下一页”后页码由 1/23 变为 2/23，正文随之改变且不显示省略号。旋转设备和修改字号会触发重新分页。
- 书架新增 TXT / Markdown 文件导入入口，调用既有 POST /api/v1/books；已核对服务端输入约束并通过模拟器签名构建，尚未在生产服务器写入测试书籍，避免污染真实书库。PDF 原版、摘录、笔记与复习沿用已实现的原生 API 流程。
- 本地 Xcode 工程入口的 iPhone Simulator Debug 签名构建为 BUILD SUCCEEDED，已安装运行。Swift Core 在临时本地副本执行 12 项：11 通过、1 项可选 HTTP 桩联调跳过；原 iCloud 目录直接运行 swift test 超过一分钟无输出，已中止。未改动 Node 运行时代码，因此本次未重跑 Web 四项检查。
- 仍未验收真机安装、TXT 导入写入回读、所有文档格式、完整搜索、学习集、脑图、图谱、翻译和离线同步。当前功能差异见 full-workspace.md。

## 2026-09-28：原生学习入口

- 学习页已接入原生复习、摘录、脑图树、文段关联列表和译文列表；阅读段落的长按菜单新增翻译并保存。对应服务器接口为 /api/v1/mindmaps、/associations、/translations 和 /translate。
- 模拟器签名构建再次成功。iPhone 17 / iOS 26.5 上已打开原生学习页，脑图和文段关联接口完成加载并正确显示当前服务器的空状态。没有为验证创建生产脑图、关联或译文；翻译写入和非空记录的渲染仍待回读验收。

## 2026-09-28：沉浸阅读与离线书籍

- 阅读页菜单约 4 秒自动隐藏，轻点空白处重新显示。iPhone 17 / iOS 26.5 模拟器验证：顶部导航和底部分页控件隐藏后只保留书籍文字，轻点恢复；菜单显隐时正文位置和页码保持稳定。系统状态栏由 iOS 管理。
- 《Alice's Adventures in Wonderland》在生产服务器上逐章下载完成，App 显示“已下载，可离线阅读 · 16 章”；重启并重新安装后仍能从本机副本先显示书籍和完整目录，随后线上书架同步到 8 本。没有修改服务器书籍记录。
- 本机离线包以服务器地址和 API key 的哈希分区；完整章节成功后才原子发布，失败或取消不覆盖旧副本。可移除本机下载而不删服务器记录。PDF 书籍若服务器提供原文件会一并保存；没有章节且无 PDF 源文件的书籍会报错，而不会显示虚假的下载成功。
- Xcode iPhone Simulator 签名构建成功。Swift Core 13 项测试：12 项通过、1 项可选 HTTP 样本联调跳过；新增测试覆盖完整包回读、凭据隔离、不完整更新不覆盖已有下载，以及移除。
- 尚未在真实断网环境中运行整条 App UI 流程，也未在真机验证大 PDF、低存储空间或后台中断。离线范围只包括已下载书籍正文与可用的 PDF 原版；摘录、笔记、翻译、AI 和云进度同步仍需网络。

## 2026-09-29：同步 main 与原生阅读记录

- `main` 快进至 `f687971`，恢复本地 README 修改；本次不涉及数据库 schema 或迁移。新用户功能是跨设备阅读时长，iOS 通过 v2 同步操作写入、读取书籍实体中的阅读段。
- iPhone 17 / iOS 26.5 模拟器签名构建、安装、启动成功。打开《权经》后菜单按时隐藏，离开阅读器后阅读记录显示本次 20 秒；同时读取到网页端已有的《盐铁论》记录。重启 App 后本机与远端记录仍显示。
- 本地 Swift Core 14 项测试中 13 项通过、1 项可选 HTTP 样本测试跳过；新增测试覆盖同 ID 检查点与跨设备重叠时段不重复计时。iOS 设备目标关闭签名后的编译成功。
- `Jiusi001` 已连接且开发者模式已开启。Xcode 个人团队登录后，清理本次及历史生成的临时测试缓存释放空间，自动签名构建成功，代码签名校验通过，App 已安装到手机。首次启动因开发者描述文件尚未受信任而被拒；用户在手机完成信任后，`devicectl` 启动成功，进程列表确认 Shufang 正在运行。手机上的连接、实际阅读与断网体验尚未人工核验；模拟器验证不等同于真机功能验收。

## 2026-09-30：原生阅读器手势翻页

- 修复短章节一页读完后左滑不进入下一章的问题；阅读器统一处理左右滑动、左右侧点按及底部按钮，向前跨章从上一章末页继续，中间点按仍控制菜单。
- iPhone 17 / iOS 26.5 模拟器安装后实际验证：《权经》卷一左滑进入卷二，右侧点按进入卷三，左侧点按和右滑逐章返回；《Alice's Adventures in Wonderland》第四章左滑由 1/24 到 2/24 页，右侧点按到 3/24 页，左侧点按退回 2/24 页，从章节首页向前点按进入上一章 3/3 页。
- 模拟器 Debug 构建成功；未修改服务器和数据库。

## 2026-09-30：多服务器账户登录改造

- iOS 设置页现在可以添加、选择、移除服务器，并通过用户名和密码登录所选服务器；不再要求 `OPEN_API_KEY`。模拟器验证了添加测试地址、切换回 `https://us.jiusi.org/` 和移除测试地址。
- 登录密码只作为 `POST /api/auth/login` 的请求体发送；会话 Cookie 按服务器保存在钥匙串。旧版 `active-server` API key 项在启动时删除。离线书籍、阅读记录及章节进度按服务器地址与账户 ID 隔离。
- 服务端 `/api/v1` 阅读资源与启用同步时的旧版桥接路由增加签名账户会话鉴权；GET/HEAD 读取会话，写入还验证同源 Origin。Webhook 管理继续只接受机器密钥；显式提供的机器密钥始终走机器鉴权，错误密钥不会回退到 Cookie。`/api/v2` 原有浏览器会话路径可供 iOS 使用。隔离环境内 4 项服务端鉴权测试通过。
- iOS 模拟器 Debug 构建成功并安装启动；本地 Swift Core 16 项测试全部通过，包含样本服务器上的真实 HTTP 登录和读写、错误密码、无 API key 请求头、会话过期拒绝和多账户离线包隔离。模拟器中实际完成添加服务器、账号登录、进入书架、切换服务器后恢复会话、登出和移除服务器。
- Jiusi001 真机 Debug 编译及安装成功；启动检查被手机锁屏拒绝，因此真机登录和阅读仍未验收。
- 本机 Web `npm run check` 因 iCloud 文件读取报 `TS6053`，项目目录内的定向 Vitest 与 lint 也曾在读取阶段卡住。其后 GitHub Actions 对 `40bac54` 完成 Web 类型检查、lint、全量测试、构建和 `us.jiusi.org` 部署健康检查；线上无会话阅读请求返回账户登录提示，Webhook 管理仍返回机器密钥提示。真实账号在 App 中登录后的读写仍待用户验收。

## 2026-09-30：账户会话与离线阅读复查

- 修复会话到期或服务器返回 401 后离线书籍被登录页挡住的问题；保留已登录账户的本机下载，设置页提示重新登录。旧请求返回的 401 不再影响后来建立的新会话。
- 添加服务器时把同一 HTTPS 主机的有无末尾斜杠和默认端口识别为同一地址，保留原有钥匙串与离线包路径。
- 本地 Swift Core 17 项测试中 16 项通过，1 项需可选 HTTP 样本服务而跳过；iPhone 17 / iOS 26.5 模拟器完整编译、安装、启动成功。模拟器使用短期会话样本服务器，下载《论语 · 移动端联调样本》后等待会话过期并重启 App，验证书架仍显示书籍、正文可打开、设置页提示重新登录。测试下载及服务器条目已移除。
- 本轮未改服务器或数据库。Jiusi001 当前不可连接，真机尚未安装本轮修复；真实账户会话到期后的离线体验仍需真机复测。


## 2026-10-02：正文百分比宽度与脚注上标（1.2.2 / 5）

- 移除阅读器 680 点固定宽度上限。正文宽度按当前阅读区域计算，默认 92%，设置范围 50–100%；分页测量与显示使用同一百分比边距。旧排版配置仍可解码，保留原有字体等设置。
- 书内注释编号使用正文字号的 62%，基线提升正文字号的 38%，去掉下划线，保留原始 UTF-16 内容与可点击链接。
- 模拟器和设备签名构建通过；仓库与构建副本 ReaderView.swift 哈希一致，设备包 codesign 严格校验通过。iPad 模拟器实际查看正文和上标，通过辅助功能点击编号，弹出完整注释并关闭。
- iPad Pro M2 与 Jiusi001 已安装 1.2.2（5）。iPad 启动成功；Jiusi001 启动因手机锁屏被拒绝，可解锁后手动打开。未将安装启动视为真机触控验收。
- 本轮坐标操作工具报告 windowNotFoundAtPosition，因此未完成百分比滑块重开保存、旋转及分屏 UI 回归；配置保存与布局路径已作源码核对。


## 2026-10-02：单账户多地址与自动选路（1.3.0 / 6）

- 账户持有多个连接地址，以登录 userID 与 v2 workspaceId 双重核验；每个地址独立 Cookie，密码不落盘。自动模式按认证 capabilities 请求延迟择优，加入 20% / 30 ms 抖动阈值；支持手动指定、网络变化检测、前台周期探测、失联暂停及恢复。
- HTTP 目标与本地存储锚点解耦，切换链路不重建学习存储、阅读位置及待同步队列。同步事务固定链路；跨节点清除游标和上传缓存，重新获取快照并保留较新字段与删除标记。写入失败不盲目重放。旧数据保护及恢复方式见 migrations/002-account-routes.md。
- Core 67 项测试：64 通过，3 项可选 HTTP 测试默认跳过；其中 2 项学习同步 HTTP 测试另行启用并通过。新增 7 项测试覆盖选路、身份隔离、会话目标、断线写入、事务固定链路、旧快照与待同步数据保留、跨节点游标以及滞后副本保护。
- 模拟器和设备构建通过，设备包严格签名校验通过；8 个变更源码/配置文件与构建副本逐字节一致。iPhone 模拟器安装并打开书架；本轮未完成新连接页面的完整 UI 操作验收。iPad 与 Jiusi001 均已安装 1.3.0（6），锁屏导致自动启动受阻，不作为真机连接验收。
- 尚未收到家庭 HTTPS 地址，未验证家庭 Wi-Fi／蜂窝网络间的真实自动切换，也未修改生产服务或生产账户配置。


## 2026-10-02：原生视觉更新（1.3.1 / 7）

- 应用图标采用原创矢量书页与书签，生成 1024 点不透明普通、深色、着色资源；系统负责外部圆角与显示效果。生成源为 scripts/generate-icon.swift。
- 界面采用系统蓝、语义化主次文字及分组背景；书架和详情标题采用系统字体，统一导航符号，为 iPad 侧栏补齐 SF Symbols，降低书籍封面阴影。用户阅读主题未改变。
- 模拟器及真机签名构建通过，设备包严格签名校验通过，源码和资源与构建副本一致。iPhone 17 模拟器实际检查浅色、深色书架及主屏幕书房新图标；外观检查后恢复浅色。未重复运行与本次视觉修改无关的核心业务测试。
- 1.3.1（7）已安装到 iPad Pro M2 和 Jiusi001；Jiusi001 已确认启动。真机视觉细节仍需实际查看。


## 2026-10-02：阅读默认收栏与翻页模式（1.4.0 / 8）

- ReaderStudyWorkspace 默认隐藏学习卡片，进入文字与 PDF 阅读时 NavigationSplitView 切换 detailOnly。保留左右侧栏展开按钮，学习工作台的卡片栏也默认收起。
- 文字阅读新增左右分页、上下分页、章内上下滚动；分页效果为平移、淡入淡出、无动画，遵循系统减少动态效果。保留文字选择、摘录与脚注弹窗，并添加阅读设置和菜单的辅助功能动作。PDF 提供上下滚动、左右滚动、双页阅读，切换时保留当前目标位置。
- ReaderStyle 只增加可选 readingFlow / pageEffect；旧配置缺省为左右分页与平移，旧版可忽略新字段，原排版值保持不变。本书专用及通用设置继续使用原存储键。新 PDF 布局使用独立 pdf.readingLayout 键；回退可删除此新键，不改变 PDF 或学习数据。本次无数据库及服务端变更。
- Core 69 项测试，66 通过，3 项可选 HTTP 测试跳过；新增方向判断测试验证轴向、前后方向、短距离和斜向移动，以及滚动模式不触发分页。模拟器构建通过。
- iPad 模拟器长章节样本实际确认两侧栏收起、满宽正文、上下分页前进、重新打开排版表单保持设置；第 2 页切换到上下滚动后截图确认仍从第 6 段开始。分页通过辅助功能动作触发；坐标手势工具仍报告 windowNotFoundAtPosition，因此未将其表述为真实手指上下滑动验收。PDF 新布局、全部动画效果及真机触控仍需进一步实际操作验收。
- 设备签名构建及严格签名校验通过，1.4.0（8）已安装至 iPad Pro M2 与 Jiusi001。


## 2026-10-02：右侧学习悬浮窗（1.4.1 / 9）

- 阅读器和宽屏学习工作台的右侧卡片／脑图改为原生 popover，默认关闭；独立 NavigationStack 将搜索和操作限制在悬浮窗内，不再参与正文横向布局。保留关闭按钮、系统窗外关闭和卡片返回原文；双文档对照仍保持独立布局。
- iPad 模拟器实际确认悬浮窗显示、窗内搜索栏及新建入口、打开卡片详情、返回原文后自动关闭、再次打开并用关闭按钮退出。正文保持满宽，没有右栏引起的横向挤压。窄窗口、横竖屏切换及脑图编辑本轮未重新操作验收。
- 模拟器与设备构建通过，严格签名校验通过；两份 Swift 源文件和 Info.plist 与构建副本逐字节一致。构建记录见 evidence/floating-panel-sim.log 和 evidence/floating-panel-device.log。本轮为纯界面变更，无服务端、数据库或持久化格式修改，未重复运行核心业务测试。
- 1.4.1（9）已安装至 iPad Pro M2 和 Jiusi001；两台设备锁屏，自动启动均被系统拒绝，真机触控验收未完成。
