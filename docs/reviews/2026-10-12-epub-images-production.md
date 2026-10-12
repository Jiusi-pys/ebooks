# EPUB 图片前端发布（2026-10-12）

用户在导入阻断修复发布后反馈正文图片不显示。检查线上主脚本
`index-uItsmvjZ.js`，确认导入修复已经生效，但之前已完成的图片解析、布局缓存
和渲染功能尚未发布。本次接续该修复发布，将既有已审核实现纳入独立发布分支。

发布源码：`80a5173afb2867eef738f58a005420648e938adb`。
前置设计和历史 TDD 证据见 [设计](../plans/2026-10-11-epub-illustrations.md)
及 [原验收](2026-10-11-epub-illustrations-validation.md)。

## 本次复验

- check、lint、build 通过；完整 Vitest 707 通过、55 按环境跳过，部署测试 15 通过。
- 隔离 origin `http://127.0.0.1:5194` 使用实际 React ReaderView、parseEpub、
  putImportedBook、useEpubLayout 和 IndexedDB；导入插件生成的真实 EPUB。
- PNG 图片实际解码为 360×120，显示宽度约 332.88 px；原图注和来源各出现一次。
  从存储重开及页面刷新后图片仍正常。该宿主页禁用外部 API，并使用合成书籍。
- 没有把测试书写入生产账号，未声称已验证用户的具体 EPUB 或生产账号端到端导入。

## 线上结果

`https://us.jiusi.org/` 已原子切换至 `assets/index-DqlbDLiY.js`，SHA-256：
`f0cd5831273b5bb8ece9acc13114c8125afcfb788b5ca6fc9929f1d39bc72896`。
公网全部 8 项静态文件哈希与发布包一致；实际下载的脚本包含布局缓存、导入和图片
渲染功能。旧版静态资源继续保留，后端容器、镜像、启动时间及健康状态不变。
结果见 [机器可读证据](../evidence/epub-images-20261012.json)。

没有更改 MySQL/SQLite/IndexedDB schema 或历史迁移。按既有方案，在 IndexedDB 11
的 metadata 中保存可丢弃的 v1 本地图片布局缓存；后端数据契约保持原样。

## 使用与范围

- 刷新网页后重新导入含包内 PNG/JPEG/GIF/WebP 的 EPUB 可生成图片布局。
- 旧版本已导入的书不会自动重解析，避免重新分配章节 ID 影响已有书摘和批注。
  请保留原书及批注，另行重新导入并确认显示后再整理，不把重导入视为批注迁移。
- 缓存目前仅保存在导入所在浏览器，不跨设备同步；其他浏览器需要自行重新导入。
  SVG、远程图片及超出既有资源预算的图片会明确报错，不能表述为支持所有 EPUB 图像。

## 备份与回退

服务器目录 `/opt/shufang/frontend-epub-images-20261012` 保存候选、manifest、旧入口、
完整旧静态备份、部署脚本和结果；主工作区 `.tools/epub-images-release-20261012`
有独立备份，SHA-256 已比对一致：
`a311fde62ab42b8f733ab028d8cfb1c814a29e4f0fecd401768a18612d366fe8`。
该目录也保存隔离浏览器截图和 DOM 图片数值。

若需回退，确认当前入口仍是本次发布的 SHA-256
`10dcd26c60949ec0ce0576c2127bf23fefd57842078cd0fc6a9e12035f37e62c`，
再将 `previous-index.html` 写入静态目录临时文件，以 `os.replace` 原子替换
`/var/www/shufang-public-20261005/index.html`。预期恢复后的入口 SHA-256 是
`b7898af6cc0e21775fe00d5deafe3237247d2c60ccba7fe3f5791be5aed6910b`。
无需删除新旧资源或改动数据库，旧代码会忽略新布局缓存。
