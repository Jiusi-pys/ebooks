> 当前状态（2026-10-03）：见[工程状态与验收门槛](current-status.md)。本文件中的日期/版本记录保留其历史范围；当前迁移为 MySQL 0014 / SQLite 0003 / IndexedDB 11，生产尚未正式切换。

# us GitHub 更新与迁移历史验收 — 2026-09-27

## 已验证

- GitHub 仓库：`Jiusi-pys/ebooks`，生产分支 `main`。
- 首次实际部署提交：`cc952aed89ec927af88397dc54d5035a77a8c736`。
- [首次 push 工作流](https://github.com/Jiusi-pys/ebooks/actions/runs/36317828684)
  成功完成检查、测试、构建、HTTPS 更新请求和服务器部署。
- [本次手动 main 工作流](https://github.com/Jiusi-pys/ebooks/actions/runs/36318183149)
  再次成功；服务器已是相同 SHA，接口复用成功任务，没有重复重启。
- 服务器更新任务 `0370a55028ad41f6aacd7ce609a9e875` 为 `succeeded`。
  镜像 revision 标签与上述提交一致，容器运行且重启次数为 0；旧容器保留。
- 公网 `/api/deploy` 带独立凭据查询返回 200；
  `/api/auth/session` 返回 200，配置和账户数据库就绪。
- 工作流执行 TypeScript 检查、lint、490 项通过测试（15 项跳过）、构建，
  以及更新服务的 10 项测试。已有 React Hooks 警告不影响通过。

以上为提交本次规则/文档更新之前的实测快照；后续 push 会再次更新线上
revision。查最新工作流、更新任务和容器标签，不能把本文的历史 SHA 当作
永久运行版本。代码与业务数据同步是两个独立机制。

## 迁移与备份核对

- 当前完整 SQL 链：`0000–0014_workspace_sync`，15 条；线上迁移账本也有
  15 条记录，journal 的每个时间标识都已记录。未对生产重放旧迁移。
- 新增独立归档 `app/db/migration-history/20260927-through-0014.tar.gz`，
  32 个文件（15 SQL、15 snapshot、journal、`.gitkeep`），逐项 SHA-256 校验通过。
  来源是 `cc952ae` 的 Git blob；全部文件哈希见同目录 manifest。
  该归档和清单也保存在 us 的 `/opt/shufang/backups/` 下同名文件中。
- 归档 SHA-256：
  `12e07c246679d3525d509c829a075b784c020396b488ca3269ac02225266dbbd`。
- us 原始已应用脚本另存
  `/opt/shufang/backups/migrations-applied-60997bd-20260927.tar.gz`，SHA-256：
  `a762b81f9503a003975cf0fd3dace6a22bcdd1bfb0d298e54a9d20885edafb32`。

### 已确认的历史换行差异

前 14 条数据库迁移哈希与当前镜像脚本相同。`0014` 原来从 Windows CRLF
文件执行，账本及原始发布文件的哈希为
`0d33a43b95cc793c398193ac609bb0db2c88118a27db925c2be820884f6438d1`；
GitHub LF 文件的哈希为
`6aa0d710b0e63a5eaac84f106ecff5a764cf8b1e553b9644d38f3e26a7c100b7`。
将 GitHub 文件仅转换为 CRLF 即得到前一哈希，因此差异来自换行。
原始脚本已备份，账本保持原值。新增 `.gitattributes` 固定后续迁移 checkout 为 LF。

## 本次范围与限制

本次仅增加强制规则、历史源文件备份、换行策略与文档，不修改数据库 schema，
不新增或改写 SQL，不修改业务数据。升级前记录的 `sync_entities` 包含 14 条
books 实体记录（含同步状态，不能等同于当前未删除书籍数量）。

没有在生产执行从空库/旧版本重建的破坏性实验。本次验证不能代替未来数据库
变更的跨版本升级验收；后续变更必须在隔离库测试空库、上一版、多版本跨度、
重复执行、失败恢复和数据保留。容器回滚不恢复数据库；迁移源码归档也不是
数据库数据备份。服务器历史镜像占用需定期监控。
