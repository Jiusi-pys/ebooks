# GitHub 自动部署

`main` 推送 → GitHub Actions 检查、测试、构建 → HTTPS 更新 API → 服务器从
固定 GitHub 仓库拉取 `main` → 核对触发提交 SHA → 构建镜像 → 迁移 → 切换
容器 → 检查数据库就绪和容器稳定运行 → Actions 显示成功或失败。

## API

所有请求使用独立的 `Authorization: Bearer <DEPLOY_TOKEN>`；不能使用登录
密码、AI 密钥或书库开放 API 密钥替代。

- `POST https://us.jiusi.org/api/deploy`，JSON `{"sha":"40位小写提交哈希"}`。
  返回 `202 {"job":{"id":"...","sha":"...","state":"running",...}}`。
- `GET https://us.jiusi.org/api/deploy?id=<id>` 查询任务；省略 id 返回最新任务。
- `401` 未授权，`400` 参数错误，`409` 另一更新正在进行，`413` 请求过大。
- 同一 SHA 正在执行或最近已成功时复用任务；失败任务可以重新提交。
- Actions 轮询成功/失败，最长 40 分钟；网络中断重试不会重复启动同一任务。
- SHA 已落后于远程 `main` 会失败，避免较早的工作流覆盖新版本。手动运行
  workflow_dispatch 也仅允许 main。

## 首次安装（当前 Linux Docker 服务）

1. 将 `update_service.py` 安装至 `/opt/shufang/updater/`。
2. 生成至少 32 字符随机密钥，写入权限 `0600` 的
   `/opt/shufang/deploy.env`：`DEPLOY_TOKEN=...`。
   同一值写入 GitHub 仓库 Secret `SHUFANG_DEPLOY_TOKEN`，禁止入库或输出。
3. 将 `shufang-updater.service` 安装至 `/etc/systemd/system/`，执行
   `systemctl daemon-reload && systemctl enable --now shufang-updater`。
4. 将 `nginx-location.conf` 加入现有站点 server 块，`nginx -t` 通过后 reload。
   更新服务仅监听 `127.0.0.1:3001`，不得直接公开该端口。
5. 保留 `/opt/shufang/.env.sync` 和 `/opt/shufang/runtime`；迁移及新容器沿用它们。
6. 提交本功能及此前已上线但尚未提交的修复，然后推送 main。第一次必须观察
   Actions 成功及实际线上版本，不能将接口安装成功等同于自动发布成功。

## 运行与恢复

- 状态：`systemctl status shufang-updater`；任务及日志：
  `/opt/shufang/deploy-jobs/<id>.json` 和 `<id>.log`（仅 root 可读）。
- 构建期间原服务继续运行；切换容器有短暂停机。
- 更新成功保留 `shufang-previous`；下一次切换时才清理更旧容器。
- 健康检查失败自动移除候选容器并启动旧容器；迁移失败不会停旧容器。
- 数据库迁移不自动撤销。必须使用与旧应用兼容的迁移；破坏性数据库修改需
  单独备份和维护计划，容器回滚不能恢复数据库数据。
- 主机崩溃或更新服务被强制终止时，运行任务在重启后标记失败。检查
  `docker ps -a` 与任务日志；若只剩停止的 `shufang-previous`，将其重命名为
  `shufang-app` 并启动后再重试。不要在任务运行中重启更新服务。
- 独立更新服务自身和 Nginx 配置由管理员维护，普通应用更新不会替换它们。
- 镜像和任务日志保留用于排障；按磁盘容量定期清理历史版本，保留当前与上一版。
- Secret 轮换：同步更新 deploy.env 与 GitHub Secret，确认无任务后重启服务。
- 自动更新只接受固定仓库 main 最新 SHA；该分支的写权限即生产发布权限。

## 多端数据库迁移与历史备份

数据库改动必须遵守根目录 [AGENTS.md](../AGENTS.md) 的强制迁移规则。
当前 MySQL 迁移链为 `0000–0014_workspace_sync`；镜像携带完整 SQL/journal，
更新时先执行 `node dist/migrate.js`，一次补齐本节点尚未应用的中间版本。
不能用 `db:push` 或仅执行最新 SQL 替代该过程。

独立历史归档及 SHA-256 清单保存在
[`app/db/migration-history/`](../app/db/migration-history/README.md)，后续迁移
须追加新的完整归档，保留旧归档。发布前另行备份数据库与原文件；此更新 API
不会自动生成数据库数据备份，也不会回滚已经执行的数据库迁移。

最新实测结果见 [2026-09-27 验收记录](../docs/deployment-acceptance-20260927.md)。

## 验证命令

仓库根目录运行 `python -m unittest discover -s deploy -p 'test_*.py'`。
`app/` 下运行 `npm run check`、`npm run lint`、`npm test`、`npm run build`。
工作流串行发布且不取消正在执行的部署，参见
[GitHub concurrency 文档](https://docs.github.com/en/actions/concepts/workflows-and-actions/concurrency)。
