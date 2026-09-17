# 书房

一个以 MySQL 保存书库、浏览器缓存支持本地阅读的书籍管理器。产品工作流参考 MarginNote 4：同一条摘录可以在原文、脑图和复习队列中复用，同时保留回到来源的定位关系。

## 已实现能力

- 导入并阅读 PDF、EPUB、MOBI/AZW/AZW3、FB2 与 TXT；支持 PDF 原版与重排模式、上下连续/左右翻页、分屏对照和章节翻译。
- 划线、批注、标签、分级引用、文段间双向/单向关联、全局关系图，以及独立于书架文件夹、支持跨文件夹选书的学习集。
- 可编辑脑图 / 大纲、章节 AI 提炼、摘录卡加入脑图并回跳原文。
- 间隔复习、手动挖空，以及“阅读 / 沉浸 / 回忆”三态阅读。
- Codex 伴读、全书导读与 AI 制卡。AI 制卡一次生成标题、解释、挖空、标签、复习状态和脑图节点。

这不是 MarginNote 的逐像素克隆。Apple Pencil 手写、视频时间轴批注、iCloud 同步、Core ML OCR 和原生 Apple 平台插件不在当前 Web 版本范围内。

## 本地运行与登录

需要 Node.js 22.13 或更高版本。先复制配置文件，并设置强随机的 `APP_ID`、`APP_SECRET`、独立的 `APP_DATA_SECRET` 与 MySQL `DATABASE_URL`。用户表建立后，前两个初始凭据可以退役。

```powershell
# Windows PowerShell（npm.cmd 可绕过 npm.ps1 执行策略）
npm.cmd install
Copy-Item .env.example .env
npm.cmd run db:migrate
npm.cmd run dev
```

```bash
# Linux / macOS
npm install
cp .env.example .env
npm run db:migrate
npm run dev
```

`npm run start` 已使用 `cross-env`，在 Windows、Linux 和 macOS 均可启动构建后的生产服务。用户表为空时，用 `.env` 中的初始凭据登录并立即设置自定义用户名和新密码；此后每次登录只从 MySQL 读取并核验账户。用户名由独立的 `APP_DATA_SECRET` 加密，密码仅保存带随机盐的 scrypt 强哈希，会话由 `APP_SESSION_SECRET` 签名。任一独立密钥留空时，本地应用会在 `.runtime/` 生成对应密钥；生产或容器部署必须显式配置它们，或持久化整个 `.runtime` 目录。旧安装应保留原 `APP_SECRET`，配置数据密钥后重新登录一次完成自动重加密，再退役初始密码。会话保存在带 `HttpOnly`、`SameSite=Strict` 属性的签名 Cookie 中，修改请求还会校验同源信息。

开放机器 API 必须单独配置 `OPEN_API_KEY`；留空时受保护的 `/api/v1/*` 资源接口返回 503，不会回退使用登录密码。

若 HTTPS 在反向代理处终止，请把浏览器实际访问的完整源配置为 `PUBLIC_ORIGIN`，例如 `PUBLIC_ORIGIN=https://books.example.com`（只包含协议、主机和可选端口）。应用不会信任客户端可伪造的 `X-Forwarded-*` 请求头；未配置时，同源校验仍以直连请求 URL 为准。HTTPS `PUBLIC_ORIGIN` 也会让会话 Cookie 自动带上 `Secure`。

服务默认只监听 `127.0.0.1`。远程部署建议使用同源 HTTPS 反向代理。浏览器通过登录会话访问 `/api/library/*` 和事件接口；机器客户端访问开放 API 时使用 `X-API-Key`，不要把 `.env` 或密钥提交到仓库。

先在运行服务的同一系统用户下安装 Codex CLI，并使用 ChatGPT 账号登录：

```powershell
codex login
codex login status
```

也可以在 AI 后台点“使用 ChatGPT 登录”；无浏览器环境可运行 `codex login --device-auth`。应用通过 `codex exec` 复用该登录态，不使用 OpenAI API Key，也不会读取或复制 `auth.json`。可在 `.env` 中覆盖运行参数：

```dotenv
CODEX_BIN=codex
CODEX_MODEL=gpt-5.6-terra
CODEX_REASONING_EFFORT=medium
CODEX_TIMEOUT_MS=180000
```

AI 抽屉右上角的“AI 后台设置”可全局切换 Provider、Model 和 Effort。DeepSeek 使用官方 OpenAI 兼容接口；密钥可仅在当前浏览器会话中填写，也可在 `.env` 配置：

```dotenv
DEEPSEEK_API_KEY=sk-...
DEEPSEEK_TIMEOUT_MS=180000
```

DeepSeek 当前提供 `deepseek-v4-flash`、`deepseek-v4-pro` 和 `deepseek-v4-flash-vision-exp`。Effort 设为 `none` 会关闭思考模式，其余可选 `low`、`high`、`max`。

认证由 Codex 自己维护。每次请求都在临时目录内以只读、短暂会话运行，结束后删除临时输出。书库及原始文件保存到 MySQL，IndexedDB 作为浏览器缓存；AI 导读缓存也使用 MySQL。Docker 部署需要在容器内另行安装 Codex CLI 并安全提供登录态，因此默认更适合本机运行。

书籍在浏览器解析后，原始文件、元数据、章节正文、注释、封面、自定义目录及阅读进度都会保存到同源服务端的 MySQL。登录后自动补传旧本地书籍并恢复服务端书库。书架标题下的“同步到 MySQL”按钮可手动提交，只有收到成功回执后才显示保存时间；失败保留本地数据，可重试。旧版未保留的非 PDF 原文件需重新导入。笔记、脑图、学习集等工具沿用现有存储行为，不包含在书库完整恢复范围内。Kindle 导入支持无 DRM 的 MOBI、AZW 与 AZW3（KF8）；受 DRM 保护的文件和 KFX 暂不支持。TXT 会自动识别 UTF-8、UTF-16 与常见中文编码。CBZ 等图片书需要独立的分页阅读模型，不在当前文本重排导入范围内。

PDF、EPUB、MOBI/AZW/AZW3 与 FB2 单文件上限为 128 MB，TXT 上限为 64 MB。超过 600 页的 PDF 仍可完整使用原版阅读，但不会生成可能缺页的重排副本。

空库和已有数据库都使用 `npm run db:migrate`：迁移会建立完整镜像结构、补齐引用层级与文段关联，并把 `mirror_books.chapters` 升级为 `LONGTEXT`。为支持最大 96 MB 的分块正文镜像，MySQL 的 `max_allowed_packet` 应设置为 `256M`。最新迁移 `0013_confused_amphibian` 新增阅读状态、原文件清单及 `library_source_chunks` 分块存储；原文件接口支持 256 MiB，但浏览器导入仍受上方格式限制。升级现有生产库前先备份；`ALTER TABLE` 在大表上可能短暂锁表。

完整的部署、备份和故障排查说明见根目录 [中文 README](../README_zh.md) 与 [English README](../README.md)。跨网络访问必须部署 Node 服务并连接同一持久化数据库，不能只部署静态前端。

## 验证

```powershell
npm.cmd run check
npm.cmd test
npm.cmd run lint
npm.cmd run build
```

配置测试库 `DATABASE_URL` 和 `OPEN_API_KEY` 并执行迁移后，可运行 `npm run test:mysql` 验证真实 MySQL 的书库及原文件读写；测试会清理自身记录。

MarginNote 功能依据：[官方功能页](https://www.marginnote.com/en/features/)、[官方 AI 功能页](https://www.marginnote.com/en/features/ai/)和[用户手册](https://manual.marginnote.com.cn/mn4/en/)。
