# MCP 用户能力（2026-10-05）

Rust 服务 MCP 版本为 1.1.0，完整读写授权可发现 85 个工具；HTTP 与 stdio 共用目录及业务实现。只读 OAuth 授权只显示读取工具。保留旧工具的名称和请求兼容性，无数据库迁移、前端或客户端修改。

## 用户功能与边界

| 功能 | 工具 |
| --- | --- |
| 书籍、文件夹、笔记、书摘、关联、翻译、脑图、学习集、阅读偏好 | `list_library_*`、`get_*`、`create_*`、`update_*`、`delete_*` |
| 原文、章节、目录、封面 | `get_book_source`、`get_book_chapters`、`get_book_chapter`、`get_book_outline`、`edit_book_outline`、`set_book_cover` |
| 导入及大文件 | `import_book`、`upload_book_source_chunk`、`complete_book_source`、`parse_book_source` |
| 阅读、复习及引用 | `save_reading_progress`、`review_highlight`、`set_review_enrollment`、`link_citation`，保留原阅读记录及复习查询工具 |
| 检索与元数据 | `search_library`、`lookup_book_metadata`、`get_epub_rendition`，保留原书目查询工具 |
| 版本 | `list_versions`、`create_version`、`delete_version`、`restore_version_entity` |
| AI | `get_ai_config`、`save_ai_config`、`ai_status`、`ai_models`、`ai_test_connection`、`ai_chat`、`ai_translate`、`ai_mindmap`、`ai_study_card`、`get_book_digest`、`save_book_digest` |
| 用户作业 | `get_job`、`cancel_job`、`forget_job`，仅导入、原文解析、AI 和元数据作业 |

版本快照可手动选择删除。按用户决定，MCP **仅开放单条版本恢复**，可恢复到原 ID 或新的 ID。不开放整库恢复、同步、写入者切换、节点、机器令牌、账户登录管理、部署、服务启停、自启动、webhook 管理，也不提供任意 URL、服务器路径或通用命令执行工具。

## 调用约定

- 先读取工具的 `inputSchema`。实体 `data` 只接受书库业务字段；内部文件引用及保留字段拒绝。更新和删除传入当前 `revision` 作为 `expected`，冲突后重新读取，不盲目覆盖。
- 带 `operation_id` 的写入由调用方生成唯一 ID；同一操作重试必须保持参数相同。创建、修改、删除、复习、引用、阅读进度及导入/解析作业有持久幂等记录。快照创建、AI 调用等未声明幂等的操作不要盲目重试。
- 原文件读取返回 base64、总字节数和 `next_offset`，逐块读取直到游标为 null，每块最多 262144 字节。章节接口返回完整原文。
- 小文件 `import_book` 接受安全文件名和 base64（最多 12000000 字符），返回作业 ID。支持 TXT、EPUB、PDF、MOBI、AZW3、FB2。
- 大文件：`create_book` 设置格式；计算全文件 SHA-256；按 262144 字节上传分块；`complete_book_source` 校验并关联；重新读取 revision；`parse_book_source` 解析到同一本书。解析替换章节、清除旧目录并重置阅读进度，保留书名、作者及自定义封面。轮询 `get_job` 至终态。
- 封面使用 PNG/JPEG/WebP/GIF data URL，解码后最多 8 MiB 并经过尺寸校验；`set_book_cover` 的 null 清除自定义封面。
- AI 配置不回传已保存密钥。AI 和外部元数据调用在工具说明中标注外部访问，AI 可能产生费用；AI 实际模型生成取决于用户配置及提供方账户。

## OAuth 与手动验收

新授权默认请求 `library:read library:write`，授权页明确显示“访问和修改”及单条恢复权限。显式只读授权继续只读；刷新令牌不能提升权限。旧连接器的只读令牌须重新授权才能获得写工具。OAuth 写权限不开放服务控制接口。

1. 浏览器先登录书库，在 ChatGPT/Codex 连接器重新发起 OAuth；如仍显示“不会授予修改权限”，检查连接器是否固定请求 `library:read`，改为同时请求 `library:write` 并重新授权。
2. 同意“访问和修改”并返回连接器，刷新工具目录，确认出现 `create_book`、`set_book_cover`、`restore_version_entity` 等工具；完整目录应为 85 个。
3. 用测试书导入、读取原文、修改标题及更换封面；建立测试笔记/书摘并执行复习，确认浏览器书库能看到结果。
4. 创建版本，修改测试笔记，从该版本只恢复这条笔记，确认正文恢复且其他记录保留；手动删除测试版本。
5. 使用当前 AI 配置测试一次翻译/脑图生成，检查结果并注意提供方费用；未配置模型时应返回明确业务错误。
6. 撤销连接器授权，旧令牌应不可继续调用；重新连接可正常使用。不要向他人发送令牌或密码。

## 自动验证

最终 Linux 二进制 SHA-256：`2231de74914153faef5c8516db5d0e60665192262879c76c469a41f3494e04a6`。

- 新能力测试先出现 unknown_tool 失败，再实现；最终 8 项能力测试通过，1 项真实 MySQL 测试默认隔离。
- Windows 和 Linux 的 Rust 工作区测试及全目标 Clippy 通过；Windows 最后一轮补齐 MSVC 环境后重跑通过。
- 兼容 Node 工程 check/lint/test/build 通过（611 通过、53 原配置跳过），部署监督器 15 项测试通过。生产前端构建文件不替换。
- 最终构建在生产主机的两个全新隔离 MySQL 8.4 库分别应用完整 16 个迁移，MCP 修改、持久幂等、快照、单条恢复和手动删除测试通过；测试库已删除，未恢复生产书库。
- 测试覆盖目录控制排除、OAuth 只读/读写/刷新禁止提升、只读副本、revision 冲突、所有用户实体 CRUD、封面解码、原文分页、小文件导入、大文件分块解析和版本生命周期。

生产发布和 HTTPS 实测另见发布记录。ChatGPT/Codex 客户端回跳及实际用户 AI 账户调用仍需上述手动步骤。此前共用 TLS 入口无法传递真实客户端 IP 的生产登录限流限制仍见[安全修复验收](security-fix-acceptance.md)，本次未修改共用入口。
