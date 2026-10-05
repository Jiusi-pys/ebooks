# 需要用户参与的真实后端验收

自动验收已覆盖真实 MySQL、HTTPS、跨节点同步、整库/单条恢复、版本删除和单写入者切换。下面只补外部账号和用户真实使用路径；不需要重新对生产书库做破坏性恢复。

## 1. Codex 的 ChatGPT 授权（选择一个方法）

服务器已安装 Codex CLI，当前状态为 available=true、authenticated=false。网页“本机登录态”在本服务中指服务器容器，不是你的 Windows Codex 登录。

Windows PowerShell 执行：

```powershell
ssh -t root@us.jiusi.org 'docker exec -it shufang-app /opt/codex/vendor/x86_64-unknown-linux-musl/bin/codex login --device-auth'
```

按终端显示的链接在自己的浏览器登录 ChatGPT，输入一次性验证码。设备登录需要账号安全设置或工作区管理员允许。不要把验证码或 auth.json 发给他人。

若设备授权不可用，改用本地回调转发：

```powershell
ssh -o ExitOnForwardFailure=yes -L 1455:127.0.0.1:1455 -t root@us.jiusi.org 'docker exec -it shufang-app /opt/codex/vendor/x86_64-unknown-linux-musl/bin/codex login'
```

打开该终端打印的完整授权链接，完成浏览器登录，保持 SSH 连接直到终端报告成功。若 Windows 的 1455 已被其他应用占用，先结束自己占用该端口的登录流程，再重试；不要直接关闭其他服务。

登录缓存落在挂载的 `/opt/shufang/runtime-rust/codex`，随服务重启保留。验证命令：

```powershell
ssh root@us.jiusi.org 'docker exec shufang-app /opt/codex/vendor/x86_64-unknown-linux-musl/bin/codex login status'
```

通过标准：显示使用 ChatGPT 登录。网页打开任意书籍 → AI 后台设置 → Provider 选 Codex → 刷新登录状态，显示已登录。选择该账号可用的模型，点击“测试连接”，应显示“连接成功，模型已返回响应”。不要改用 API Key 登录 Codex；此后端 Codex 路径要求 ChatGPT 登录。

命令与设备授权/SSH 回调方法依据[官方认证文档](https://learn.chatgpt.com/docs/auth)及已部署 0.160.0 CLI 的帮助输出。外部账号权限、模型权限和额度由你的账号决定。

## 2. 实际付费 API 模型（如你需要使用）

打开 `https://us.jiusi.org`，登录书库，在任意书籍的 AI 后台设置选择你已经有有效密钥的 Provider，填入自己的 API Key 和可用模型，先点“测试连接”。不要在聊天中发送密钥。密钥设置是否保留由既有客户端设置行为决定，后端不把请求中的密钥写进 AI 作业或日志。

通过标准：成功返回模型响应；如密钥无效或账号无额度，应显示失败而不是成功。当前服务器未配置 OpenAI API Key，空密钥返回 412 属于预期，不能算真实模型测试通过。

## 3. AI 全功能真实流程（用一份你愿意发送给模型的测试文本）

1. 用两段短文本创建或导入专用测试书，避免使用敏感书库内容。
2. 在伴读中问“仅根据这两段内容，各用一句话概括”，确认答案确实使用当前书籍上下文。
3. 选中一句话执行翻译，确认结果非空、目标语言正确。
4. 执行章节脑图生成，确认节点及关系可读取，刷新页面后仍保留。
5. 选中短文本生成学习卡，确认题目、答案、来源和对应书籍正确，刷新后仍保留。
6. 再次打开 AI 设置点测试连接。若 Provider 提供模型列表，验证刷新可列出账号实际可用模型；Codex 允许手动模型，不承诺 API 模型列表。

通过标准：以上真实响应成功、无持续转圈；生成的记录经过同步后其他节点可见；失败不能留下半成品记录。只清理本次测试书和记录即可。

## 4. 在你实际使用的 MCP 客户端完成授权

在该客户端新增远程 MCP，地址 `https://us.jiusi.org/mcp`。使用客户端支持的 OAuth 授权方式，跳转到书库时登录并批准只读访问；支持手工 Bearer 的客户端也可使用你自己的机器 API Key。

依次查询书目、一本书的阅读进度、书摘、复习队列；在书库创建一条带唯一关键词的测试笔记并同步，再搜索笔记和按 ID 读取该笔记。

通过标准：六个工具可调用，结果与书库一致；授权取消后不可获得访问，注销或撤销授权后旧 token 不继续读取。客户端名称、版本、授权返回情况由实际客户端验证；若某客户端不支持所用 MCP 协议/OAuth，记录客户端版本及非敏感错误信息。

## 回报结果

仅提供测试项目、Provider/模型或 MCP 客户端版本、成功/失败、非敏感报错文字。不要提供密码、密钥、验证码、Cookie 或完整私人书籍内容。你完成授权后，代理可继续执行真实后端 API 回归并更新证据。
