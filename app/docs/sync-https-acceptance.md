# 正式节点 HTTPS REST 同步验收

2026-09-27，运行代码提交 `60997bd`，协议 v2。

## 部署方式

- Windows 原生 Node：`http://127.0.0.1:3000`，节点 `windows-personal`。
- Linux 正式容器：`https://us.jiusi.org`，节点 `linux-personal`。
- 两端工作区均为 `personal-workspace`，继续使用独立 MySQL 和文件目录。
- Windows 的对端 URL 改为 `https://us.jiusi.org`，保留工作区限定凭据。
- Linux 设置 `SYNC_PEERS_JSON=[]`，被动接收 REST 请求。
- 已停止正式 SSH 转发（本机 3200、远端 13300）；历史实验端口也保持关闭。
  本轮验收只访问本机 3000 和公网 HTTPS，不访问环回转发地址。
- SSH 管理连接仅用于上传构建和重启容器，不参与操作或文件复制。

## 实机结果

使用两端真实认证 API 和数据库，创建唯一 ID 的临时记录；从每端写入，
在对端读回，再从对端修改并在原端读回。结束时以墓碑清理临时业务记录。

| 项目 | 结果 |
| --- | --- |
| Windows → 云端元数据 | 通过，4,955 ms |
| 云端 → Windows 元数据 | 通过，3,771 ms |
| 双向更新 | 通过 |
| 双向删除墓碑 | 通过 |
| Windows → 云端原文件 | 312,000 字节，跨分块，完整下载 SHA-256 一致 |
| 云端 → Windows 原文件 | 312,000 字节，跨分块，完整下载 SHA-256 一致 |
| 最后状态 | 两端序号 92，Windows 复制 failures=0 |

文件摘要和原始结果见 [https-report.json](sync-evidence/https-report.json)。
Linux 的 `peers={}` 是被动接收模式的配置结果，不代表没有收到 Windows 数据。
文件按完整性验收，文件时长不纳入 15 秒元数据目标。

## 自动化结果

- TypeScript、构建通过。
- 91 个测试文件、479 项通过；15 项可选集成测试跳过。
- ESLint 无错误；保留原有 AiSettingsPanel Hooks 依赖警告。
- 新增测试覆盖单端主动双向交换、回执丢失后重试、逐项失败不推进游标、
  远端世代变化后重放、上传中断后跨 worker 实例续传、1 MiB 请求分批。
- 上述故障注入使用受控测试；本轮实机证明的是无 SSH 隧道的 REST 双向流转。

## 运行说明

目前没有依赖 webhook，周期性 HTTPS 推送和拉取承担可靠同步。
未来 webhook 可作为通知加速；通知丢失不能影响持久化日志补齐。
Windows 的 Node、Docker/MySQL 仍需保持运行。开机自启和进程守护不在本轮改动中。
云端恢复仍需按 [备份恢复说明](workspace-sync.md) 更新日志世代。

构建取自 `60997bd` 的源码快照；工作区其他未提交的阅读器界面改动没有随本次发布。
