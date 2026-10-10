# Android 功能矩阵

基准：本地 `base` 的 `40f84d9a17b7ca68e3134f2093afba82fb687c11`。
目标工程：`platforms/android/`，分支 `android`。未合入 `windows` 分支。

状态分层：**源码**表示已有可执行入口；**核心**表示契约/共享业务测试通过；
**设备**表示 MuMu 的实际 JNI、WebView 或 Compose 操作通过。
源码、编译和核心测试不能替代设备操作；设备合成服务不能替代真实 HTTPS/AI 验收。
下面的未验证项仍是完整功能对齐的验收门槛。

| ID | base 网页依据 | Android 入口及结果 | 验收用例 / 当前证据 |
|---|---|---|---|
| L01 | `LibraryView.tsx` | 书架；显示封面、作者、格式、进度，打开本地书籍 | FeatureFlow：导入的本地书籍打开、重建 Activity；设备通过 |
| L02 | `LibraryView.tsx`, `folderIcons.ts` | 更多→文件夹；新建、改名、八种图标；书架按文件夹筛选 | LibraryOperations 创建、学习图标及筛选设备通过；全部八种图标组合待验收 |
| L03 | `LibraryView.tsx` | 操作菜单→选择；批量移动、移出文件夹、删除 | LibraryOperations 两书批量移动、移出及删除设备通过；共享核心删除关联回归通过 |
| L04 | 元数据编辑模块、`parseMetadataField.ts` | 书目；标题、作者、出版信息、贡献者角色、语言、ISBN/DOI/ASIN 等 | LibraryOperations 作者修改设备通过；解析器及共享模型测试通过；在线元数据检索待真实网络验收 |
| L05 | 封面选择及书籍原文件操作 | 阅读→封面；系统图片选择、Rust 校验保存；分享原文件 | 原文件 JNI 持久化通过；图片选择和系统分享回执待验收 |
| L06 | `parseBook.ts`, `bookFormats.ts` | 导入按钮 / 系统分享；私有缓存复制、解析进度、Rust 原子保存 | DocumentParser 覆盖七格式；NativeContract 原文件/重启；ImportBoundary URI 限额与取消；ImportTouch 系统分享→真实正文设备通过 |
| L07 | `parsePdf.ts` | 设置→PDF 原版/重排；阅读→切换版式 | MuMu 原版解析、画布渲染、全文搜索及重排正文通过 |
| L08 | `parseEpub.ts`, `parseFb2.ts`, `parseTxt.ts` | APK 内同源解析器；目录、正文、EPUB 脚注 | 正常 EPUB/FB2/TXT、脚注设备通过；损坏容器/空 TXT 设备通过 |
| L09 | `parseMobi.ts` | MOBI / AZW / AZW3 本地解析 | MOBI、AZW、真实 KF8 样例通过；DRM、损坏文件、KFX 拒绝通过 |
| L10 | `search.ts`, 搜索面板 | 全局搜索；书籍、正文、笔记、书摘、标签；当前书籍/学习集范围；分页 | 核心多段分页、UTF-16、章节标题、隐藏引用标记测试；PDF 搜索设备通过；全搜索筛选组合待验收 |
| R01 | `ReaderView.tsx`, `OutlinePanel.tsx` | 阅读→目录；跳转、改名、上下移、缩进/提升，选文加入目录 | 共享目录业务回归通过；目录触摸编辑全组合待验收 |
| R02 | `TypePanel.tsx` | 字号、字体、字重、字距、行距、段距、页边距、主题、栏数、翻页；本书/通用设置 | 源码与持久化契约；即时渲染、跨重启全部设置组合待验收；系统无相应中文字体时使用系统字体回退 |
| R03 | 阅读进度及计时 | 最新章节/比例 checkpoint；只累计前台时间；离开阅读保存零散时间 | ReadingPosition/ForegroundReadingClock 单元测试；核心 checkpoint 回归；真实长时间后台计时待验收 |
| R04 | 阅读历史 | 更多→阅读记录；按时间排序、跳转书籍 | 源码、核心 checkpoint 回归；历史触摸跳转待验收 |
| R05 | PDF 选区、文本选区 | WebView→Compose 选文菜单；UTF-16 文本坐标或归一化 PDF 页矩形 | ReaderBridge emoji 3..5 与 EPUB 脚注通过；PDF 多页几何核心通过；真实 PDF 选区跨端待验收 |
| N01 | `SelectionToolbar.tsx` | 选文操作→保存/编辑批注、标签、挖空词、颜色/下划线、删除 | ImportTouch 实际 DOM 选中 emoji→触摸批注、蓝色下划线→Rust 保存设备通过；全部颜色/样式及系统长按选区待验收 |
| N02 | 引用菜单 | 引用内容、全书、章节→选择笔记；原位置跳转；笔记/书摘菜单取消引用 | canonical citation 核心测试；取消引用原子提交、版本冲突、批注保留/继续编辑及纯锚点删除核心通过；FeatureFlow 实际笔记引用回原文通过；新增取消入口未设备验证 |
| N03 | `NoteView` / 笔记编辑器 | 笔记→标题、Markdown、标题/列表/引用/加粗/代码/双链、排版预览、分享 | LibraryUi 中文/emoji 编辑、草稿 Activity 重建、保存通过；其余富文本组合待验收 |
| N04 | 双链及反向链接 | 编辑器→关联笔记/书籍/反链/引用；忽略大小写、书籍优先、未知目标可创建笔记；未保存时要求先保存 | WikiLink 单元测试、Graph/引用数据契约；新双链触摸跳转仍待单独验收，MuMu 启动阻塞已恢复 |
| N05 | 文段关联面板 | 选文→关联此段→另一文段→保存双向关联；更多→关联编辑/删除 | 源码、共享关联清理、合并引用重建测试；两段实际触摸操作待验收 |
| S01 | `MindView.tsx`, `mind.ts` | 更多→脑图；空白/目录生成；编辑子节点、顺序、缩进、提升、折叠、来源引用、焦点子树 | MindOperations 差异样例；FeatureFlow 实际节点编辑/保存通过；其余编辑组合待验收 |
| S02 | 脑图 AI 章节扩展 | 脑图章节→AI 展开→设置→保存到原脑图；保留原有节点 | 新增失败→通过测试：原脑图追加、陈旧 revision 拒绝；真实 Provider 待验收 |
| S03 | `GraphView.tsx`, `links.ts` | 更多→图谱；类型筛选、双指缩放、平移、复位、节点/列表跳转 | 设备生成关联/节点、放大/复位通过；完整关系差异及触摸平移待验收 |
| S04 | `StudySetView.tsx` | 更多→学习集；成员书籍、描述、卡片、脑图、到期数量；编辑/复习 | FeatureFlow 单书、卡片、脑图、到期详情通过 |
| S05 | 复习队列及调度 | 书摘加入/移出复习；挖空、显示答案、重来/困难/良好/简单、回原文 | 核心调度回归；MuMu 学习集→答案→良好→到期延后通过 |
| A01 | AI Provider 配置 | 设置→deepseek/openai/kimi/minimax/codex、模型、思考强度、API Key | 配置适配及 Keystore 设备通过；真实 Provider 请求未验证 |
| A02 | AI 聊天及 QA | 阅读→AI / 选文→AI 问答；多轮上下文、开始新对话、取消等待、保存笔记/文段 QA | ImportTouch 原生 AI 面板入口设备通过；AiContext UTF-16 分段/限制单元测试；真实聊天、取消连接及 QA 保存操作未验证 |
| A03 | 翻译及双语阅读 | 选文/章节翻译、目标语言、译文保存；双语→当前章节译文 | ReaderBridge 同时呈现原文与译文通过；真实翻译 Provider 未验证 |
| A04 | 制卡、导读、生成脑图 | 设置/选文→相应任务；Rust 校验后保存；全书分块导读及多层摘要 | 共享生成结果、卡片字段校验、脑图追加合成测试通过；真实模型内容未验证 |
| C01 | `/api/auth/login`, `/setup`, `/profile`, `/logout` | 设置→登录/首次初始化/账号修改/退出 | 隔离实际 Rust HTTP 服务：Android 登录/初始化/修改/失效后数据保留通过；真实 HTTPS 界面未验证 |
| C02 | `/api/v2/*` | 高级节点独立 Bearer 模式；与 Cookie 模式隔离，不回退 | AndroidSync 失效 Cookie、错误节点令牌、正确节点令牌、恢复会话通过 |
| C03 | 同步及同步状态 | 前台编辑自动调度、手动同步/取消；待发送、原文件、持久冲突预览与选择 | 隔离实际双客户端条件同步及Compose冲突选择通过；重启、删除依赖、原文件、迟到修改、503丢失回执通过；Chrome业务模块CRUD与iOS可编辑笔画往返通过；独立WAN业务并发、完整网页UI与全部实体组合未验收 |
| C04 | 快照、原文件续传 | 共用 Rust 传输模块；原协议/服务端包装保持兼容；取消原生任务 | workspace 快照/续传/中断/协议回归通过；MuMu 真正上传断网中断未验证 |
| C05 | 新离线工作区的首次接入 | 独立目标暂存→合并范围→确认→备份/ID 映射/新操作→上传 | Host 合并中途失败/幂等/关联/原历史通过；AndroidMerge 实际 JNI 重试、冲突 ID、引用/原文件通过；完整登录 UI 确认流未验证 |
| C06 | 切换账号/服务器、失效恢复 | 独立工作区和 Keystore 身份；保留待发送；返回合并前书库 | 核心失效恢复及隔离身份测试通过；多服务器实际 UI 切换未验证 |
| C07 | 后台同步 | WorkManager 网络约束、15 分钟周期、失败退避；不承诺持续在线 | 源码、编译、Lint；系统周期唤醒/Doze 及断网重试待设备验收 |
| C08 | 服务端自启动管理 | 设置明确标注服务器；读取 supported/installed，显示支持的开关 | 源码、既有服务端回归；真实 owner 权限服务器管理未验证 |
| C09 | Codex 登录/退出 | 设置→服务器 Codex 状态/登录/退出；远端执行 AI | 源码、服务端合成契约；真实服务器 Codex 登录未验证 |
| C10 | 搜索偏好、版本信息 | 设置→Google/Bing；Android 版本、Rust ABI | 核心偏好保存通过；设置界面设备通过 |
| P01 | 平台交互 | 底部导航、更多、菜单代替右键、按钮代替拖拽；大屏阅读双栏、窄屏切换面板 | FeatureFlow 与 LibraryUi 导航通过；全部触摸入口逐项人工验收未完成 |
| P02 | 系统生命周期 | 草稿重建、返回、Home/进程停止后恢复、旋转、覆盖安装 | 设备/ADB 通过；当前 Apple 风格 APK 生命周期报告比较全部 47 条测试笔记；不等同于低内存随机杀进程压力测试 |
| P03 | 平台文件与键盘 | OpenDocument、FileProvider、IME 避让、中文标签、外部链接系统浏览器 | URI 限额/取消设备测试；系统选择器/分享目标回执/无障碍读屏全流程待验收 |

## 可重复验收

汉王两种尺寸已通过 MuMu 16 组配置和 32 次专项操作，整套合计 56 次实际通过；不包含实体笔/刷新性能。参数、失败重跑和证据见 [汉王模拟验收](../evidence/android-ios/hanvon-mumu-acceptance.md)，复现使用 `scripts/test-hanvon-mumu.ps1`。

- `scripts/test-device.ps1`：Compose、真实 JNI、本地 WebView、独立服务器。
- `scripts/test-lifecycle.py --mumu-rotate 1`：冷启动、Home、停止进程、系统返回、MuMu 旋转、覆盖安装及逐条数据比较。
- `scripts/verify-apk.ps1`：两个 ABI、每个 ELF LOAD 段、APK 16 KiB 对齐及调试签名。
- 共享核心的迁移和业务回归保留原有测试；本次未修改 schema 或任何历史迁移。

真实 Provider、真实 HTTPS、后台调度及未列为设备通过的组合不能标为已验收。
验收证据、版本、APK 哈希和限制见 [acceptance.md](acceptance.md)。

2026-10-08 Apple 风格版本：18 项本地设备测试通过、2 项真实服务器测试默认跳过；独立 us HTTPS 1 通过、认证测试缺少会话跳过。最终 APK 哈希、实际安装哈希、生命周期及限制见 [最新验收](apple-style-acceptance.md)。

2026-10-10 新增学习备份ZIP、双PDF、移除本机下载及保存冲突后，进一步完成持久离线并发队列、条件发送、原子选择与失败恢复。us服务器兼容接口已升级；最新APK及实测边界见 [离线冲突报告](../evidence/android-ios/offline-conflicts-20261010.md)。详细iOS对照与仍未验证项见 [ios-parity.md](ios-parity.md)。
