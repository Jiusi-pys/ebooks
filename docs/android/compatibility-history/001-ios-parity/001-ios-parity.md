# 原生兼容格式 001

2026-10-08；源分支 android，iOS 基准 201a87a。不更改 MySQL / SQLite / IndexedDB schema 与历史迁移。

先扩展后使用：新增 PortableInk v1 附件、连接配置 v2、资料包 ZIP 传输封装；现有 notes、sources、reviews 和可选字段承载数据。二进制 `$attachment` 与 JSON `$blob` 必须分开处理。

PortableInk：format=ShufangPortableInk，version=1；页面坐标未旋转 crop box，width=1000，height 按页面比例；笔画保留 id、tool、RGBA、width、采样 x/y/pressure/tilt/time。旧 pdfDrawing 保留，新增 pdfPortableInk，预览仍为 pdfPreview。新 iOS 优先通用附件；仅有旧 PKDrawing 的页面由 iOS 转换，Android 保留预览并显示待转换，不猜测格式。未知版本拒绝编辑，保留原附件。

连接 v2：固定存储锚点、userID/workspaceID、最多八地址、可选手动地址；Cookie 单独在 Keystore。升级前原连接字段备份一次，成功后启用 v2；异常回到原连接，原工作区不移动。会话及密码不进入格式归档。

资料包：沿用 ShufangStudyBackup v1 内部文件；ZIP 仅传输封装，目录包继续可读。恢复先校验、预览、备份并建立按实体类型区分的持久映射，再原子提交；故障保留原数据与计划，重新预览后重试。未知版本不写入。

发布门槛：旧连接直接升级、重复执行、旧/新可选字段混合节点、旧手写转换、资料包双端往返、缺失/篡改附件拒绝、恢复失败与数据保留。历史格式与源文件完整归档至 migration-history/001-ios-parity，校验清单在格式实现完成后生成；未完成验证不得标记发布通过。
