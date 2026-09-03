# 书房

一个面向深度阅读的本地优先书籍管理器。产品工作流参考 MarginNote 4：同一条摘录可以在原文、脑图和复习队列中复用，同时保留回到来源的定位关系。

## 已实现能力

- 导入并阅读 PDF / EPUB，支持 PDF 原版与重排模式、分屏对照和章节翻译。
- 划线、批注、标签、双向引用、全局关系图，以及独立于书架文件夹、支持跨文件夹选书的学习集。
- 可编辑脑图 / 大纲、章节 AI 提炼、摘录卡加入脑图并回跳原文。
- 间隔复习、手动挖空，以及“阅读 / 沉浸 / 回忆”三态阅读。
- Codex 伴读、全书导读与 AI 制卡。AI 制卡一次生成标题、解释、挖空、标签、复习状态和脑图节点。

这不是 MarginNote 的逐像素克隆。Apple Pencil 手写、视频时间轴批注、iCloud 同步、Core ML OCR 和原生 Apple 平台插件不在当前 Web 版本范围内。

## 本地运行

```powershell
npm install
Copy-Item .env.example .env
npm run dev
```

先在运行服务的同一 Windows 用户下安装 Codex CLI，并使用 ChatGPT 账号登录：

```powershell
codex login
codex login status
```

应用通过 `codex exec` 复用该登录态，不使用 OpenAI API Key。可在 `.env` 中覆盖运行参数：

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

认证由 Codex 自己维护；应用不会读取或复制 `auth.json`。每次请求都在临时目录内以只读、短暂会话运行，结束后删除临时输出。浏览器数据存放在 IndexedDB；AI 导读缓存和开放 API 镜像使用 MySQL。Docker 部署需要在容器内另行安装 Codex CLI 并安全提供登录态，因此默认更适合本机运行。

## 验证

```powershell
npm run check
npm test
npm run lint
npm run build
```

MarginNote 功能依据：[官方功能页](https://www.marginnote.com/en/features/)、[官方 AI 功能页](https://www.marginnote.com/en/features/ai/)和[用户手册](https://manual.marginnote.com.cn/mn4/en/)。
