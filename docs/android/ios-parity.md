# iOS → Android 对照与验收

基准：`ios` / `201a87a69f9eb1c9d7c35cbd6ecc94b0a4720856`（1.4.2 / 10）。

汉王尺寸模拟增量：N10 Pro 二代按 10.3 英寸、1860×2480，原版 Clear7 按 7 英寸、1264×1680 在 MuMu 实际运行。16 组横竖屏/字号/密度配置、32 次阅读与双 PDF 操作通过；两机完整套件各 28 实际通过、9 条件跳过。已保存实际窗口、PNG、日志和失败重跑记录；见 [尺寸验收](../evidence/android-ios/hanvon-mumu-acceptance.md)。实体笔、刷新、ARM 性能和出厂逻辑密度仍待真机。
实施方案：用户于 2026-10-08 确认功能、交互、保存与失败行为逐项一致；Android 动态布局、双向可编辑手写、可选离线模型。保留既有 Android 格式支持与 Rust 唯一业务写入路径。

| ID | iOS 依据 | Android 目标与验收 |
|---|---|---|
| I01 | LibraryView / Models.OfflineBookStore | 下载、离线打开、取消与只移除下载；重启/覆盖安装保留 |
| I02 | ReaderView / ReaderNavigation | 三种流向、跨章、边缘点击/滑动、菜单自动隐藏；窗口与字号变化保持文本锚点 |
| I03 | ReaderView / BookFootnotes | 百分比正文宽度、本书/通用排版、字体、脚注浮窗与不改 UTF-16 坐标 |
| I04 | HighlightsView / StudyTextSelection | 卡片全字段、跨段选区、来源回跳、高亮回显与问答 |
| I05 | StudyWorkspaceView | 学习集模板、默认收栏、悬浮学习面板与不挤压正文 |
| I06 | StudyTree / StudyWorkspaceView | 树形/大纲、卡片引用、移动、折叠、跨书关联 |
| I07 | PDFStudyView / PDFStudyController / PDFGeometry | 搜索、缩略图、区域摘录、OCR、双文档、三种布局、导出 |
| I08 | PDFStudyController / StudyStore | 单层手写、笔/手指分工、橡皮、撤销重做、PortableInk 往返与后台保存 |
| I09 | HighlightsView / StudyModels | 集内复习、遮挡、挖空、四档算法、事件与来源 |
| I10 | StudySearchView / NotesView | 已缓存正文搜索、双链、Markdown 输出 |
| I11 | StudyBackup / StudyRestore / StudyTransferView | v1 资料包、依赖闭包、预览、三种策略、完整校验与事务失败恢复 |
| I12 | AppState / AccountRoutes / APIClient / ReadingSyncTests | 多地址身份核验、固定事务路由、冲突选择、附件与阅读时间回执 |
| I13 | ReaderView.FoundationModels | 设备端/服务器来源、取消、预览确认保存与可编辑脑图 |
| A01 | Android 独有设备适配 | 320–1024dp、横竖/分屏、字体 1/1.3/2、墨水屏模式与 API26/28/当前版本 |

每项源码、构建、合成数据、真实运行与真机分开记录。iOS 源码能力及其历史模拟器报告不作为本轮 Android 或跨端运行证据。汉王设备尚不可连接；Apple 环境已接入。2026-10-10 的隔离 HTTP 服务器、真实 Android JNI、iOS StudyStore/PencilKit 与 Chrome 业务模块网络往返已通过，详见下方增量记录；生产 WAN 写入未验证。不得据此宣布 1:1 验收完成。

## 2026-10-09 增量验收

| 对照项 | 本轮实现与实际操作 | 编译 | 运行 | 真机 |
|---|---|---|---|---|
| I06（部分） | 原生树形画布与大纲切换；点击节点、触摸选择父节点移动整棵子树；保留书摘与章节引用；保存、重启、再次选中 | Android 单元测试与 Lint 通过 | MuMu 320/600/840/1024dp × 字号 1/2 共 8 组通过；API26/28 普通窗口通过 | 汉王待接入 |
| I08（合并数据部分） | 首次合并复制通用笔画与不透明二进制附件样例；按目标 bookId 重建 pdfink 身份；缺失/篡改失败、重试幂等与原库不变 | 双 ABI、16 KB 对齐通过 | Rust 失败/重试测试与三种 Android 环境 JNI 实际 PDF 合并通过；不验证 PencilKit 解码 | 无实际 arm64 设备 |
| I09（历史部分） | 合并复习历史并重建卡片引用，保留评分、调度、创建时间、设备来源；兼容小数毫秒，拒绝历史覆写；旧计划遗漏历史时拒绝继续 | Rust workspace、Clippy 通过 | Rust 与三种 Android 环境 JNI 保存/重启通过 | 网络跨端历史往返待验收 |

证据见 `docs/evidence/android-ios/report.md` 和 `mind-matrix/`。以上范围不替代 I06 的全部跨书关联/拖入交互、I08 网络手写往返或 I11 学习备份恢复；旧计划的干净暂存库重建仍需补齐产品入口。完整 1:1 对齐未完成。

## 2026-10-10 增量实现与验收范围

| 对照项 | Android 入口、输入与保存结果 | 实际验收 | 真机 |
|---|---|---|---|
| I01 移除下载 | 书籍菜单→移除本机下载；仅移除有已校验远端回执的原文件缓存，保留书目、规范正文、学习资料与身份；再次打开提供下载 | Rust 拒绝未上传文件；Android 独立工作区实际移除、同步不复活缓存、显式重新下载及原文件哈希检查 | 汉王/arm64 未接入 |
| I07 双 PDF | 阅读→更多→双文档对照→选择另一 PDF；按可用宽度并排或上下，独立/同步滚动；保存各自书籍页码与页内位置；退出返回主文档 | 两份四页 PDF 实际触摸滚动、同步、位置恢复；不同窗口和字号记录在 pdf-windows/；旧 WebView 透明文字层兼容实际检查 | 汉王刷新和笔性能未验证 |
| I11 学习备份 | 设置→学习备份与恢复；全部/学习集 ZIP；依赖、原文件与附件校验→预览→保留本机/双方/备份→Rust 原子提交 | JNI 备份恢复、篡改/路径/陈旧计划拒绝；恢复预览取消与确认实际 Compose 操作；Android 导出→iOS 读取并重新打包→Android 恢复原文件/手写/复习 | 系统文件选择器完整触摸链路待验收 |
| I12 保存与离线同步冲突 | 保存时当前/草稿对照；同步前本机/远端持久队列→预览→选择本机/服务器/双方→新操作同步；稍后处理和重启保留 | 实际双JNI工作区并发、Compose触摸选择、第二次变化重新确认、删除书籍依赖和原文件重建；503丢失回执去重、独立字段合并；API26/28/35通过 | 独立WAN账号业务并发与全部实体组合仍待验收 |
| I08/I09 跨端网络 | Android 原生手写→独立真实 HTTP 服务→iOS PencilKit 新笔画→Android 继续编辑→iOS 再次加载 | 三笔仍可编辑；不透明 PencilKit/PNG/PortableInk 附件通过网络；两条评分历史；实际 Chrome IndexedDB/Web 同步模块新增/修改/删除 | iPad 模拟器运行，物理 Apple/汉王笔未验证 |

网络业务测试使用独立服务器与生成资料，不写入 us.jiusi.org 生产书库。浏览器业务模块确实执行，不等同于完整网页界面手动操作。2026-10-10已补齐持久离线冲突队列及真实双客户端条件同步，us线上已升级并完成Android HTTPS认证及只读预检；见 [离线冲突报告](../evidence/android-ios/offline-conflicts-20261010.md)。独立WAN账号业务并发、附件设备断网中断、恢复低存储及全部实体组合仍需补齐。可重复脚本见 [network-acceptance.md](network-acceptance.md)。
