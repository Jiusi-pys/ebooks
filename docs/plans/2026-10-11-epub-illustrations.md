# EPUB 插图、图注与弹出注释适配

状态：已完成方案独立复核、TDD 实施、最终独立审核与本地浏览器验收；未提交、推送或部署。目标为当前 Web 阅读器共享 React 阅读视图，不涉及原生平台的独立渲染器。结果见 [验收记录](../reviews/2026-10-11-epub-illustrations-validation.md)。

## 目标与兼容边界

导入 EPUB 后显示包内正文插图及原有图注、来源；正文与图片旁注释使用小字号上标按钮，普通点击显示完整纯文本注释，不导航、不改变阅读位置。普通阅读、递归参考窗格及双语原文共用实现。正文、图注、来源、注释及图片的原始内容不得补造或重复。

现有 Chapter.paragraphs、paraIndex 和 UTF-16 footnotes 偏移是书摘、批注、关联及镜像同步的定位依据。保留这些字段的原值和形状，不把图片或裸图注插进旧字符串数组，不给共享 Book/Chapter 或严格 API 章节请求增加字段。图片和新增视觉信息保存在本地派生缓存。转换插件的十格式入口保持独立，其他格式可先转换、标准编排为 EPUB 后导入。

## 导入与布局数据

增加前端专用 `EpubLayout`（lib/epubLayout.ts）：`version: 1`、去重 assets、以同一次解析的 chapterId 为键的 chapters。ParsedBook 增加可选 epubLayout，Book/Chapter 不扩展。

每章保留完整有序 items 流：

- paragraph：引用原 paraIndex，不复制正文；可标记 caption、credit 或 image-note；inlineImages 保存原段落 UTF-16 offset、稳定 order、assetId 和原 alt。
- image：独立图片及原 alt。
- text：用于旧解析器未收录的裸图注/来源及裸图片旁标记（image-note），保存纯文本和局部 UTF-16 注释范围，不注入 HTML。例如 figure 内 img 后直接跟 sup/a 的编号也必须保留，不能要求用户先把编号包进 p。
- figure：分组上述非 figure 项，已有图注段落仍引用原 paraIndex，只呈现一次。

保留段落/锚点解析逻辑，收集视觉信息必须与章节拆分同一遍完成；不通过二次解析产生另一组随机 chapterId。图片独立成章时允许 paragraphs 为空，保留章节与章顶目录定位。行内图片通过 offset 渲染，A/图片/B 的次序不变；分段高亮不得重复渲染边界处的图片。

只读取实际包内 PNG/JPEG/GIF/WebP，不执行 SVG 或 HTML，不请求远程 URL。沿用现有 ZIP/解压总预算，并限制图片每张 12 MiB、总量 32 MiB、2000 张、边长 16384、每张 40M 像素；从实际字节校验类型和尺寸，再本地解码验证，按规范化包内路径去重。正文图片远程/data/file/blob、包外路径、未列入 manifest、缺失、SVG/不支持格式、解码或预算失败均给出明确导入错误。封面语义下的独立 SVG wrapper 可排除，但不能借此过滤同页正文图片。无法确认的图注关联保持原顺序，不猜测普通相邻正文的用途。

注释全文受既有单文档及全书字符预算保护；移除静默的 20000 字符截断，超限显式报错，不能将截断文本称为完整内容。

## 本地保存、升级与同步

使用 IndexedDB 11 既有 metadata store，新增命名空间 `epub-layout:<bookId>`，row 包含 `version: 1`、bookId、sourceSha256、完整 structureSha256 和布局；布局同样以 `version: 1` 标明解析契约。结构指纹覆盖 chapter id/title/paragraphs/footnotes，不依赖未包含注释的 contentHash，不包含阅读进度和可编辑书目标题。必须完整覆盖原章节及每个段落且不重复，损坏缓存回落原正文。

putImportedBook(book, file?, layout?) 将书、原文件、source 及布局在一个事务中提交；校验和指纹在事务外准备。失败必须全部回滚。getter 核验当前书/原文件摘要及布局版本；过期数据不展示。useEpubLayout 按书读取，异步切书不会串图，监听事务提交后的局部通知及现有同步更新事件。

metadata 不属于同步 entityKinds，不发送布局、data URL 或新 Chapter 字段；相同正文的远端回写保留本地图像。书籍删除/tombstone、原文件更换需清理布局，覆盖直接数据库投影和快照路径，不仅 deleteBook。正文或注释改变使指纹失效，旧布局不能错误附到新段落。

这是新增可丢弃缓存格式，不新增/更改 IndexedDB store、索引、数据库版本或后端 schema，也不改写历史迁移。升级顺序：沿用既有受支持版本到 IndexedDB 11 的迁移链，再按新版导入路径按需创建 v1 行。旧书无缓存时继续显示原段落；本轮不自动重解析旧书，因为会重新分配章节 ID，需重新导入 EPUB 获取图像。旧客户端忽略新命名空间。未知版本或损坏行不显示，原书和原文件保留。

备份及恢复：实施和浏览器验收仅用合成书籍与隔离 origin/测试数据库，不改生产书库。用户原 EPUB 与库中原文件是重建依据；回退应用不会回退数据库，旧应用可继续读旧数据，必要时仅清理新布局缓存后重新导入，不删除原文件、书籍或批注。测试验证无缓存旧数据、新增布局事务失败、重新打开、远端同内容回写、正文改变失效和删除回收。

## 显示与交互

共享 EpubChapterContent 按 items 顺序渲染，renderParagraph 回调复用现有 Paragraph 的 data-pi、高亮、关联和注释。图注采用 figure/figcaption 下的原段落或纯文本，0.85em、无首行缩进；图片旁注释标记与图像并列，上标保持小字号。EpubText 支持行内图片，按全文 UTF-16 offset 与高亮分段协同。

修复原注释按钮继承 line-height:0 导致点击区域为 0 的问题，保留 font:inherit 并显式 lineHeight:1。沿用 Radix Popover、纯文本注释、关闭按钮与 Escape/焦点恢复；点击/滚轮不透传阅读器。分页导航继续关闭注释。

图片限定最大宽高，预留已知尺寸以减少加载位移；横向分页、双栏和滚动布局均须核查。布局异步加载及图像加载后重新计算页数。双语仅原文显示原图，不向译文猜测插入位置。

## TDD 与验收

1. 先补失败测试：包内图片与资源拒绝/预算、图注与图片标记（包括 img 后裸 sup/a）、行内 offset、图片-only 章节、长注释完整/超额失败、段落/注释/目录不漂移及不重复。
2. 保存测试先红后绿：原子提交/回滚，版本和指纹，同内容同步保留、source 变化失效、local/remote 删除与快照清理，不把布局发送到 outbox 或镜像。
3. UI 测试先红后绿：实际共享组件保持原段落定位，图注和来源只出现一次，行内图片与高亮边界，普通点击/关闭/焦点/分页不跳转。
4. 用 EPUB 编排插件实际生成的合成 EPUB，经过真实解析与本地存储，再验证主视图、参考窗格、双语原文，以及窄屏/横向分页。浏览器记录字号、图片/图注次序、注释内容、URL/章节/滚动不变和重开持久性。
5. 按根 AGENTS 运行 check、lint、完整 Vitest、build；不把静态或组件测试宣称为生产部署或原生端验收。独立审核关闭具体缺陷后更新插件阅读器约定和本仓验收记录。

## 分工与文件边界

- 导入实现：epubLayout.ts、epubContent.ts、parseEpub.ts、parseBook.ts 及对应测试。
- 存储实现：epubLayoutStore.ts、db.ts、必要同步删除路径、useEpubLayout hook 及测试。
- 主任务：useLibrary 导入接线，EpubText/EpubChapterContent、ReaderView/BilingualReader、样式与 UI 测试，浏览器验收、文档。
- 独立代理审核方案与最终差异。未经方案复核通过不开始实现。
