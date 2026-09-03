# 书房

一个面向深度阅读的本地优先书籍管理器。产品工作流参考 MarginNote 4：同一条摘录可以在原文、脑图和复习队列中复用，同时保留回到来源的定位关系。

## 已实现能力

- 导入并阅读 PDF、EPUB、MOBI/AZW/AZW3、FB2 与 TXT；支持 PDF 原版与重排模式、分屏对照和章节翻译。
- 划线、批注、标签、分级引用、文段间双向/单向关联、全局关系图，以及独立于书架文件夹、支持跨文件夹选书的学习集。
- 可编辑脑图 / 大纲、章节 AI 提炼、摘录卡加入脑图并回跳原文。
- 间隔复习、手动挖空，以及“阅读 / 沉浸 / 回忆”三态阅读。
- Codex 伴读、全书导读与 AI 制卡。AI 制卡一次生成标题、解释、挖空、标签、复习状态和脑图节点。

这不是 MarginNote 的逐像素克隆。Apple Pencil 手写、视频时间轴批注、iCloud 同步、Core ML OCR 和原生 Apple 平台插件不在当前 Web 版本范围内。

## 本地运行与登录

需要 Node.js 22.13 或更高版本。先复制配置文件，并设置强随机的 `APP_ID`、`APP_SECRET` 和 MySQL `DATABASE_URL`；缺少任何一项时生产服务会拒绝启动。

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

`npm run start` 已使用 `cross-env`，在 Windows、Linux 和 macOS 均可启动构建后的生产服务。浏览器打开后必须用 `.env` 中的应用凭据登录；会话保存在带 `HttpOnly`、`SameSite=Strict` 属性的签名 Cookie 中，修改请求还会校验同源信息。

若 HTTPS 在反向代理处终止，请把浏览器实际访问的完整源配置为 `PUBLIC_ORIGIN`，例如 `PUBLIC_ORIGIN=https://books.example.com`（只包含协议、主机和可选端口）。应用不会信任客户端可伪造的 `X-Forwarded-*` 请求头；未配置时，同源校验仍以直连请求 URL 为准。HTTPS `PUBLIC_ORIGIN` 也会让会话 Cookie 自动带上 `Secure`。

服务默认只监听 `127.0.0.1`。若显式改为远程地址，开放 API（包括事件写入）必须使用 `X-API-Key`，不要把 `.env` 或密钥提交到仓库。

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

认证由 Codex 自己维护。每次请求都在临时目录内以只读、短暂会话运行，结束后删除临时输出。浏览器数据存放在 IndexedDB；AI 导读缓存和开放 API 镜像使用 MySQL。Docker 部署需要在容器内另行安装 Codex CLI 并安全提供登录态，因此默认更适合本机运行。

书籍均在浏览器本地解析，原始文件不会发送到服务端；启用 MySQL 时，提取出的书目与章节文本会写入同源服务端镜像。Kindle 导入支持无 DRM 的 MOBI、AZW 与 AZW3（KF8）；受 DRM 保护的文件和 KFX 暂不支持。TXT 会自动识别 UTF-8、UTF-16 与常见中文编码。CBZ 等图片书需要独立的分页阅读模型，不在当前文本重排导入范围内。

PDF、EPUB、MOBI/AZW/AZW3 与 FB2 单文件上限为 128 MB，TXT 上限为 64 MB。超过 600 页的 PDF 仍可完整使用原版阅读，但不会生成可能缺页的重排副本。

空库和已有数据库都使用 `npm run db:migrate`：迁移会建立完整镜像结构、补齐引用层级与文段关联，并把 `mirror_books.chapters` 升级为 `LONGTEXT`。为支持最大 96 MB 的分块正文镜像，MySQL 的 `max_allowed_packet` 应设置为 `256M`。升级现有生产库前先备份；`ALTER TABLE` 在大表上可能短暂锁表。

## 验证

```powershell
npm.cmd run check
npm.cmd test
npm.cmd run lint
npm.cmd run build
```

MarginNote 功能依据：[官方功能页](https://www.marginnote.com/en/features/)、[官方 AI 功能页](https://www.marginnote.com/en/features/ai/)和[用户手册](https://manual.marginnote.com.cn/mn4/en/)。
