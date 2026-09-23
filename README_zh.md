# 書房（Shufang）

[English](README.md)

書房是一款以 MySQL 保存书库的深度阅读与书籍管理 Web 应用，工作流参考 MarginNote 4。它把多格式阅读、划线批注、分级引用、文段关联、学习集、脑图、间隔复习和 AI 伴读整合在同一工作区中。

本项目不是 MarginNote 的逐像素复刻。Apple Pencil 手写、视频时间轴批注、iCloud 同步、原生 OCR 与 Apple 平台扩展不在当前 Web 版本范围内。

## 已实现功能

- 导入 PDF、EPUB、无 DRM 的 MOBI/AZW/AZW3（含 KF8）、FB2 与 TXT。
- PDF 支持原版与重排阅读、文字划线/批注，以及文档或页面渲染失败后的可见错误与重试。
- 支持横向、纵向及嵌套分屏，可组成可调尺寸的 2、3、4 窗口；学习集内仅选择该学习集的书，书架阅读默认继续打开当前书。
- 可排版书籍支持中文/English 同步双语对照阅读。
- 可排版书籍可切换上下连续滚动或左右翻页，并支持滚轮、键盘与页面按钮。
- 支持划线、批注、标签、挖空，以及书籍、章节、精确文段三级引用。
- 全局搜索支持本书、学习集与全文库范围，覆盖书名、作者、章节、正文、笔记和划线批注，并可从结果跳转定位。
- 可把不同书籍中的精确文段建立单向或双向“关联”，并在关系图中查看。
- 书架文件夹与逻辑学习集相互独立；文件夹图标、书籍封面、目录和阅读排版均可自定义。
- 可编辑书名、贡献者、出版社、出版日期、语言、标识符、系列、标签、简介、版次和版权等书库元数据，并同步至 MySQL 镜像；不会改写原始电子书文件。
- 浏览器 IndexedDB 与 MySQL 镜像对书籍、笔记、书摘、引用、关联和摘要删除保持一致；事件回执、墓碑、事务化引用清理和前向迁移让迟到事件可以安全重试。
- 支持可编辑脑图、复习卡片、回忆模式和间隔复习队列。
- 默认通过本机 ChatGPT 登录调用 Codex，也可在 AI 后台选择 DeepSeek API。
- 左右阅读侧栏均可在固定显示与自动隐藏间切换；右侧可把书摘、批注和 AI 问答合并为按时间排列、颜色区分的列表；沉浸模式会隐藏两侧栏和工具栏；账户面板可修改 MySQL 用户名和密码。

## 全局搜索

点击页面顶部的搜索入口，或按 `Ctrl + K`（macOS 为 `⌘ + K`），输入关键词后按 Enter 或点击“搜索”。沉浸阅读隐藏顶部入口，但快捷键仍可使用。搜索按输入文字进行包含匹配，忽略英文大小写，并去掉关键词首尾空白；不使用正则表达式或语义匹配。

| 搜索范围 | 纳入内容 |
| --- | --- |
| 本书 | 当前阅读书籍的书名、作者、章节标题、正文，以及对应划线批注和通过引用关联的笔记；未打开书籍时不可选。 |
| 本合集 | 所选**学习集**的成员书籍及其划线批注、关联笔记，不按书架文件夹筛选。可在搜索框下方选择学习集。 |
| 文库全部内容 | 当前工作区已加载的所有书籍、划线批注和笔记，包含没有关联书籍的独立笔记。 |

“结果类型”与“搜索范围”相互独立：选择“书摘”只检索已保存的书摘，选择“批注”只检索批注正文，选择“问答”会同时检索 AI 保存的问题与回答；选择“全部内容”则保留完整搜索。

阅读时默认搜索本书，在具体学习集页面默认搜索该学习集，其他页面默认全文库。搜索结果显示来源和关键词高亮片段；每个命中段落显示一条结果。点击正文或批注结果跳回对应位置，点击笔记结果打开并选中命中的标题或正文文字；PDF 结果会按需要切换阅读模式。

结果显示总数，最多展示前 200 条；超过上限时可缩小范围或细化关键词。搜索过程中可取消，修改关键词或范围会取消旧搜索，避免迟到结果覆盖当前输入。

搜索在浏览器中执行。没有可用重排正文的 PDF 会从本地缓存的原文件逐页提取文字，并显示进度；缺失文件、读取失败或没有文字层的页面会明确提示，其他内容仍可返回结果。图片内文字不参与搜索，本功能不包含 OCR，也不新增数据库迁移或搜索服务配置。

## 阅读工作区与导航

左侧功能导航默认仅显示图标，鼠标悬停图标即可查看功能名称，数量仍以角标保留。“在读”条目使用固定的封面列和可截断标题列；无图片封面的竖排题签也会裁切在封面范围内，长书名不会溢出。

左右侧栏均可固定或自动隐藏。在桌面端展开左侧自动隐藏栏时，顶部搜索栏和阅读目录会同步右移；展开右侧自动隐藏阅读面板时，正文会让出宽度而不会被覆盖。右侧面板可点击“合并”在分开标签与单一时间流之间切换：时间流会把书摘、批注及每一条问答交错排列，并分别用橙色、蓝色和紫色标识。

快捷键不再显示在阅读操作区。通过左侧栏的“应用设置”可查看快捷键说明：`Ctrl/⌘ + K` 打开全局搜索，`Esc` 关闭临时界面或退出沉浸阅读，分页阅读可使用 `←/→` 或 `PageUp/PageDown` 翻页。

## EPUB 目录、注释与阅读排版

EPUB 导入会保留导航目录及段落锚点，并识别存放在独立正文文件中的注释。已识别的注释标记以正文 65% 的字号显示在右上角；点击即可弹出注释，按 Esc 或点击关闭即可返回正文，无需跳转页面。注释同时保存在本地书籍与 MySQL 分块镜像中，后端会校验段落索引、文字范围及上传大小。

点击阅读器工具栏的 **Aa 排版**，即可调整字体、字号、行间距、段间距、字间距、页边距与背景。设置即时生效并保存在当前浏览器；面板空间不足时可滚动，不会被分屏容器裁切。

- 段间距可调范围为 0–3 em。
- 单页连续阅读使用整个可用阅读区域，不再固定限制为 680px；双语及参考分屏也使用各自窗格的可用宽度。
- 页边距可调范围为每侧 16–480px，实际每侧最多占窗格宽度的 25%，为窄窗格保留正文空间。宽屏下可增大页边距来缩短每行文字，旧版设置会保留。
- 上述排版设置适用于重排文本；PDF 原版模式需要切换为重排模式才能调整文字排版。

解析器、注释交互、上传校验及 EPUB 到镜像的回归测试包含一份小型合成 EPUB 样例。如需额外验证本机 EPUB，可将环境变量 `EPUB_MIRROR_TEST_FILE` 设为文件绝对路径，然后在 `app/` 下执行 `npm test -- src/lib/epubMirror.test.ts`（Windows 使用 `npm.cmd`）。此测试不会写入 MySQL，也不会上传源文件。

## 架构与数据存储

应用代码位于 [`app/`](app/)：

```text
app/
├── src/          React 19 前端、阅读器、Hooks、解析器与 IndexedDB
├── api/          Hono 服务、tRPC、鉴权、AI 与开放 REST API
├── contracts/    前后端共享请求及错误契约
├── db/           Drizzle Schema 与 MySQL 迁移
├── public/       静态资源及 PDF.js Worker
└── verifier/     历史验收标准与执行记录
```

MySQL 保存书籍元数据、章节正文（含注释）、封面、自定义目录、阅读进度、阅读模式及原始文件；浏览器 IndexedDB 用作本地缓存。登录后会自动补传旧浏览器中尚未入库的书籍，并从服务端恢复书库及 PDF 原版文件。新导入的所有支持格式均保存原文件，按 256 KiB 分块上传，单文件上限 256 MiB，确认字节数和 SHA-256 一致后才发布。

导入只有在服务端保存完成后才显示完成。上传失败保留本地副本，并提供重试同步入口；阅读进度、封面和目录等修改会在应用打开期间每 5 秒尝试提交，失败后保留待同步记录。重新打开应用或网络恢复时也会同步书库。服务端删除记录可防止旧缓存把已删除书籍重新上传。

书架标题下方提供 **“同步到 MySQL”** 按钮，文件夹内也可使用。点击后同步书库并提交待保存的阅读状态；导入或同步期间按钮禁用，服务端确认成功后显示 **“书籍已保存到 MySQL”** 和时间，失败则保留本地数据并允许重试。按钮同步范围为书籍，不代表整个工作区的所有工具数据。

旧版 EPUB/MOBI/AZW3/FB2/TXT 导入没有保留原文件，已有正文、封面和阅读状态仍可迁移，但缺失的原文件需要重新导入。迁移完成前请保留原浏览器缓存。笔记、脑图、学习集等工具沿用各自现有存储行为，本次书库恢复不等于整个工作区的全部数据恢复。

跨浏览器、跨网络使用时，把前端和 Node 服务部署在同一 HTTPS 域名下，配置 `PUBLIC_ORIGIN` 和安全会话 Cookie，并连接同一个持久化 MySQL 数据库。升级启动前运行 `npm run db:migrate`。仅部署静态前端不能保存服务端书库。备份 MySQL 时须包含 `mirror_books` 和 `library_source_chunks`，原文件直接存入数据库，不依赖网站服务器本地磁盘。多个部署只有连接同一数据库才会共享书库。

## 环境要求

| 依赖      | 要求                                                    |
| --------- | ------------------------------------------------------- |
| Node.js   | `20.19+` 或 `22.12+`；推荐 Node 22 LTS 或 Node 24       |
| npm       | 随 Node.js 安装；仓库已提交锁文件                       |
| MySQL     | 推荐并已验证 MySQL 8.4                                  |
| 浏览器    | 支持 IndexedDB 的新版 Chromium、Edge、Firefox 或 Safari |
| Codex CLI | 可选；使用默认 AI Provider 时必须安装                   |
| Git       | 克隆和更新仓库时需要                                    |

## 快速启动

克隆仓库并进入应用目录：

```bash
git clone git@github.com:Jiusi-pys/ebooks.git
cd ebooks/app
```

Windows PowerShell 请优先使用 `.cmd` 启动器。即使系统禁止执行 `npm.ps1`，以下命令也无需修改全局执行策略：

```powershell
npm.cmd ci
Copy-Item .env.example .env
```

Linux 或 macOS：

```bash
npm ci
cp .env.example .env
```

完成下方 MySQL 与 `.env` 配置后执行：

```powershell
# Windows PowerShell
npm.cmd run db:migrate
npm.cmd run dev
```

```bash
# Linux / macOS
npm run db:migrate
npm run dev
```

访问 <http://127.0.0.1:3000/>。用户表为空时，先用 `app/.env` 中的 `APP_ID` 与 `APP_SECRET` 登录一次，再设置自定义用户名和新密码。此后每次登录只查询 MySQL，初始凭据不再有效。用户名加密存储，密码只保存带随机盐的 scrypt 强哈希。

## Windows / Linux / macOS 使用教材

三种系统最终使用同一套项目命令。先安装受支持的 Node，再确认
`node --version` 为 `20.19+` 或 `22.12+`；这是 Vite 当前强制的范围。数据库以
MySQL 8.4 为已验证版本。不同发行版的安装细节请以官方 [Node/npm 安装说明](https://docs.npmjs.com/downloading-and-installing-node-js-and-npm)
和 [MySQL 安装手册](https://dev.mysql.com/doc/refman/8.0/en/installing.html) 为准。

### Windows 10/11（PowerShell）

1. 用官方安装包安装 Git for Windows、Node LTS 和 MySQL 8.4；在 MySQL Installer
   中将 Server 配置为 Windows 服务。
2. 新开 PowerShell，确认 `git --version`、`node --version`、`mysql --version`。
   若系统禁止运行 `npm.ps1`，坚持使用 `npm.cmd` / `npx.cmd`，无需修改执行策略。
3. 按下节 SQL 创建数据库和账户，再克隆、配置、迁移并启动：

```powershell
git clone git@github.com:Jiusi-pys/ebooks.git
Set-Location ebooks\app
npm.cmd ci
Copy-Item .env.example .env
# 编辑 .env 后执行：
npm.cmd run db:migrate
npm.cmd run dev
```

### Ubuntu / Debian Linux

1. 用常用版本管理器或 Node 官方发行包安装受支持的 Node。若系统自带仓库没有
   MySQL 8.4，请按 Oracle MySQL APT Repository 安装，而不是把 MariaDB 当作已验证替代品。
2. 用 systemd 启动数据库并确认版本：

```bash
sudo systemctl enable --now mysql
node --version
mysql --version
```

3. 按下节 SQL 创建数据库和账户，然后执行：

```bash
git clone git@github.com:Jiusi-pys/ebooks.git
cd ebooks/app
npm ci
cp .env.example .env
# 编辑 .env 后执行：
npm run db:migrate
npm run dev
```

### macOS（Homebrew）

使用 Homebrew 安装 Node 22 和已验证的 MySQL 系列，启动服务后执行相同项目命令。
可参考 [`mysql@8.4` formula](https://formulae.brew.sh/formula/mysql@8.4)；若公式版本发生调整，以其当前说明为准。

```bash
brew install node@22 mysql@8.4
brew services start mysql@8.4
node --version
mysql --version
git clone git@github.com:Jiusi-pys/ebooks.git
cd ebooks/app
npm ci
cp .env.example .env
# 编辑 .env 后执行：
npm run db:migrate
npm run dev
```

任一平台执行 `npm run dev` 后，访问 <http://127.0.0.1:3000/>。开发服务器同时挂载
Hono API，因此浏览器界面和 `/api/*` 请求都使用同一个地址。

## MySQL 配置

先使用系统服务管理器启动 MySQL，再以管理员身份连接并创建数据库和专用账户。MySQL 账户的 Host 必须与 `DATABASE_URL` 中的主机一致。

```sql
CREATE DATABASE shufang
  CHARACTER SET utf8mb4
  COLLATE utf8mb4_0900_ai_ci;
CREATE USER 'shufang'@'127.0.0.1'
  IDENTIFIED BY '请替换为足够长的随机密码';
GRANT ALL PRIVILEGES ON shufang.* TO 'shufang'@'127.0.0.1';
```

为了安全提升较大的正文镜像，需要把 MySQL 的 `max_allowed_packet` 配置为 `256M`。在服务端配置文件的 `[mysqld]` 下加入以下内容，重启 MySQL 后检查生效值：

```ini
[mysqld]
max_allowed_packet=256M
```

```sql
SHOW VARIABLES LIKE 'max_allowed_packet';
```

常见配置位置包括 Windows 的 `C:\ProgramData\MySQL\` 下的 `my.ini`、Linux 的 `/etc/mysql/`，以及 macOS Homebrew 的 MySQL 配置目录。服务名和准确路径取决于安装方式。

已有安装升级前请先备份数据库，并始终使用 `npm run db:migrate`（不要使用
`db:push`）。仓库迁移已前向演进至 `0013_confused_amphibian`，新增
`mirror_books.reader_data`、`mirror_books.source_manifest` 和
`library_source_chunks`，用于保存阅读状态及原文件。迁移工具会跳过已登记执行的迁移。

## 环境变量配置

编辑 `app/.env`，不要提交该文件。数据库密码包含特殊字符时，必须先进行 URL 编码再写入 `DATABASE_URL`。

```dotenv
APP_ID=reader
APP_SECRET=请替换为至少32字节的随机值
APP_DATA_SECRET=请使用独立的至少32字节随机值
APP_SESSION_SECRET=请使用另一个至少32字节的随机值
HOST=127.0.0.1
PORT=3000
PUBLIC_ORIGIN=
SESSION_TTL_SECONDS=43200
SESSION_COOKIE_SECURE=false
OPEN_API_KEY=请使用独立的机器接口密钥

DATABASE_URL=mysql://shufang:编码后的密码@127.0.0.1:3306/shufang

CODEX_BIN=codex
CODEX_MODEL=gpt-5.6-terra
CODEX_REASONING_EFFORT=medium
CODEX_TIMEOUT_MS=180000
CODEX_LOGIN_TIMEOUT_MS=300000

DEEPSEEK_API_KEY=
DEEPSEEK_TIMEOUT_MS=180000
```

可使用以下命令生成合适的 `APP_SECRET`：

```powershell
# Windows PowerShell
[Convert]::ToHexString(
  [Security.Cryptography.RandomNumberGenerator]::GetBytes(32)
).ToLower()
```

```bash
# Linux / macOS
openssl rand -hex 32
```

| 变量                    | 用途                                               |
| ----------------------- | -------------------------------------------------- |
| `APP_ID`                | 一次性首次登录账号；仅用户表为空时需要             |
| `APP_SECRET`            | 一次性初始密码；不再用于新用户名密文               |
| `APP_DATA_SECRET`       | 独立用户名加密密钥（至少 32 字节）                 |
| `APP_SESSION_SECRET`    | 独立会话签名密钥（至少 32 字节）；本地使用时可留空 |
| `DATABASE_URL`          | MySQL 连接 URI；生产启动和 Drizzle 命令必填        |
| `HOST` / `PORT`         | 生产服务监听地址与端口，默认 `127.0.0.1:3000`      |
| `PUBLIC_ORIGIN`         | TLS 反向代理后的完整外部 Origin，不允许包含路径    |
| `SESSION_TTL_SECONDS`   | 会话时长，实际范围限制为 300–604800 秒             |
| `SESSION_COOKIE_SECURE` | 强制会话 Cookie 使用 `Secure` 属性                 |
| `OPEN_API_KEY`          | `/api/v1/*` 机器客户端密钥；空值时禁用机器接口     |
| `CODEX_*`               | Codex 可执行文件、默认模型/强度和超时时间          |
| `DEEPSEEK_*`            | 可选的 DeepSeek 密钥和超时时间                     |

单机使用时保持 `HOST=127.0.0.1`。如果 HTTPS 在反向代理处终止，应把 `PUBLIC_ORIGIN` 设置为浏览器实际访问的 Origin，例如 `https://books.example.com`，并启用安全 Cookie。应用不会使用客户端可伪造的 `X-Forwarded-*` 请求头进行同源判断。

`APP_DATA_SECRET` 或 `APP_SESSION_SECRET` 留空时，服务会分别生成强随机密钥并持久化到 `app/.runtime/data-secret` 与 `app/.runtime/session-secret`。必须持久化或备份这两个被 Git 忽略的文件：丢失会话密钥会使现有会话失效；账户迁移后丢失数据密钥会导致加密用户名无法恢复。生产环境和容器部署应显式配置两个密钥，或把整个 `.runtime` 目录挂载到持久卷。手动配置时少于 32 字节会拒绝启动。

已有安装升级时，先保留原 `APP_SECRET`，配置并持久化 `APP_DATA_SECRET`，重启后退出并重新登录一次。数据库登录成功后会自动使用新数据密钥重加密用户名；完成后才能轮换或删除初始密码。`OPEN_API_KEY` 必须与登录凭据分开；留空时受保护的机器接口返回 `503` 并保持禁用。

## 使用 ChatGPT 登录 Codex（不使用 OpenAI API Key）

请为运行書房服务的同一个系统用户安装 Codex CLI。npm 安装方式可跨 Windows、Linux 和 macOS 使用：

```powershell
# Windows PowerShell
npm.cmd install -g @openai/codex
codex login
codex login status
```

```bash
# Linux / macOS
npm install -g @openai/codex
codex login
codex login status
```

在浏览器流程中选择 **Sign in with ChatGPT**。无图形界面的主机可使用 `codex login --device-auth`。本项目通过 `codex exec` 复用登录态，只接受 ChatGPT 鉴权；如果检测到 API-key 鉴权会拒绝调用，从而避免 OpenAI API 计费。项目不会复制 `auth.json`，凭据始终由 Codex CLI 自行查找和维护。参见官方 [Codex CLI 指南](https://learn.chatgpt.com/docs/codex/cli)与[鉴权说明](https://learn.chatgpt.com/docs/auth)。

每次阅读请求都会在临时目录中启动短暂、只读的 Codex 会话。Shell、Web、浏览器、插件、记忆等无关工具均被禁用，同时应用/API 密钥不会传入子进程。默认配置为 `gpt-5.6-terra` 与 `medium`，AI 后台可以选择本版本列出的其他模型和思考强度。

## 可选 DeepSeek Provider

DeepSeek 与“不使用 API Key”的 Codex 路径相互独立，会产生 DeepSeek API 计费。可以在服务端设置 `DEEPSEEK_API_KEY`，也可以在 AI 后台临时填写；界面填写的密钥仅保存在浏览器 `sessionStorage`。当前版本提供：

- 模型：`deepseek-v4-flash`、`deepseek-v4-pro`、`deepseek-v4-flash-vision-exp`
- 思考强度：`none`、`low`、`high`、`max`

当前适配器只发送文本消息，即使所选模型名称中包含 `vision` 也不会发送图片。

建议先在 AI 后台点击“测试连接”，再执行翻译、对话、脑图生成或 AI 制卡。

## 生产模式启动

每次部署前先执行数据库迁移，再构建并启动合并后的静态前端与 Hono 服务：

```powershell
# Windows PowerShell
npm.cmd run db:migrate
npm.cmd run build
npm.cmd run start
```

```bash
# Linux / macOS
npm run db:migrate
npm run build
npm run start
```

`npm run start` 通过 `cross-env` 跨平台设置 `NODE_ENV=production`。生产模式缺少 `DATABASE_URL` 时会直接拒绝启动；用户表为空时还必须配置 `APP_ID` 与 `APP_SECRET` 才能完成首次登录。

### 可选容器构建

镜像不会包含 `.env` 或 Codex 凭据：

```bash
docker build -t shufang ./app
docker run --rm --name shufang \
  -p 127.0.0.1:3000:3000 \
  --env-file app/.env \
  -e HOST=0.0.0.0 \
  shufang
```

`DATABASE_URL` 必须指向容器能够访问的 MySQL 地址；Docker Desktop 通常可使用 `host.docker.internal`。镜像不会安装 Codex，也不会复制其凭据存储。若要使用 ChatGPT 登录的 Codex，推荐直接使用本机 Node.js 启动；如需容器化，必须在运行时单独提供 CLI 和凭据存储，不能把凭据烘焙进镜像。

## 开放 API

访问 `GET /api/v1/` 可以查看机器可读的接口目录。资源接口要求请求头 `X-API-Key: <OPEN_API_KEY>` 或 `Authorization: Bearer <OPEN_API_KEY>`。当前 API 覆盖书籍与章节、书摘、复习卡、文段关联、笔记、文件夹、译文、脑图、事件和 WebHook。浏览器写入事件时也可使用已签名的应用会话与同源校验。

`OPEN_API_KEY` 为空时机器访问被禁用，不会回退使用 `APP_SECRET`。

## 文件支持限制

- PDF、EPUB、MOBI/AZW/AZW3 与 FB2：单文件最多 128 MiB。
- TXT：单文件最多 64 MiB，并自动识别 UTF-8、UTF-16 与常见中文编码。
- 超过 600 页的 PDF 仍可使用原版阅读，但不会生成可能缺页的重排副本。
- 不支持受 DRM 保护的 Kindle 文件与 KFX。
- 服务端正文镜像的编码后上传上限为 96 MiB，并使用可恢复的分块上传。
- 原文件接口按 256 KiB 分块，最大支持 256 MiB；浏览器导入仍受上方各格式限制。

## 质量检查

提交前执行：

```bash
npm run check
npm test
npm run lint
npm run build
npx drizzle-kit check
```

Vitest 同时覆盖后端 API 行为和浏览器侧存储、解析工具。配置好已迁移测试库的 `DATABASE_URL` 和 `OPEN_API_KEY` 后，可运行 `npm run test:mysql` 验证真实数据库读写和原文件上传、下载；测试会创建并清理自己的记录。贡献规范见 [`AGENTS.md`](AGENTS.md)。

## 常见问题

- **换浏览器后看不到书籍：** 确认访问同一服务并连接同一数据库，在原浏览器点击“同步到 MySQL”，看到保存成功后再重新打开另一浏览器。迁移完成前不要清理原浏览器缓存；旧缓存未保留的原文件需要重新导入。

- **PowerShell 提示禁止运行 `npm.ps1`：** 改用 `npm.cmd` 和 `npx.cmd`，无需修改系统执行策略。
- **登录页提示未配置鉴权：** 填写 `APP_ID` 与 `APP_SECRET` 后重启服务。
- **迁移或镜像连接失败：** 检查 MySQL 是否运行、账户 Host 是否匹配 `DATABASE_URL`，并确认密码已经 URL 编码。
- **Codex 已安装但被拒绝：** 执行 `codex login status`。如果显示 API Key，请先 `codex logout`，再使用 ChatGPT 登录。
- **经过反向代理的修改请求返回 403：** 配置准确的 HTTPS `PUBLIC_ORIGIN` 并重启書房。
- **3000 端口被占用：** 停止已有进程，或为生产服务设置其他 `PORT`；开发模式可使用 `npm run dev -- --port 3001`。
