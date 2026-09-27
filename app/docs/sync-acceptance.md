# Windows—Linux 双节点同步验收

日期：2026-09-27，Asia/Shanghai。

## 结论

Windows 原生 Node ↔ Linux Docker 的双向同步实机验收通过。两端使用独立
MySQL 数据库，浏览器分别访问两个实际节点，未以本机双进程模拟替代远端。
本报告仅覆盖隔离实验工作区，不表示已经把原线上书库切换到新协议。

额外尝试的“重置实验库日志世代后强制浏览器重新取快照”未执行：自动审批
拒绝了故障注入命令，返回原因为 `blocked by policy`，没有更具体原因。
Windows 服务已恢复。快照水位、未确认字段合并分别有 MySQL/API 和协议测试，
空浏览器的实际快照初始化也已通过；不得将这些结果写成该额外实验通过。

## 版本和环境

| 项目 | Windows | Linux |
| --- | --- | --- |
| 运行代码提交 | `f789f3b3bbb8e61587854a1e5f73a0a7e5ac16a8` | 同左 |
| 同步实现提交 | `9f658b71a0ce886dba642abb94342bbe5e826aea` | 同左 |
| 协议 / 浏览器 DB | v2 / IndexedDB v9 | v2 / IndexedDB v9 |
| Node | 24.19.0 原生进程 | 22.23.3 容器 |
| MySQL | 8.4.11，`shufang-sync-lab-db` | 8.4.11，复用 `shufang-db` 实例 |
| 数据库 | `shufang_sync_lab`，环回 13307 | `shufang_sync_20260927`，专用账号 |
| 节点 ID | `windows-lab` | `linux-lab` |
| 工作区 | `windows-linux-lab` | 同左 |
| HTTP | `127.0.0.1:3101` | 远端 `127.0.0.1:3102` |
| 原文件目录 | `.runtime/sync-lab/windows-blobs` | `/opt/shufang-sync-lab/blobs` |

Linux 主机为 `root@us.jiusi.org`。正向隧道将本机 3102 接到远端 3102；
反向隧道将远端 13101 接到本机 3101。节点复制另外验证工作区凭据。
自动代码更新在两端实验配置中关闭。

镜像在本机 Docker 构建，镜像配置 ID：

`sha256:c2659530366f7b46327e1f963ab841cc61754600fe5f8975316e67afeb07178f`

镜像 revision 标签为上述 `f789f3b` 提交。实验容器另挂载同一提交的
`release/dist` 和迁移目录，便于精确比较实际运行文件。两端实际文件一致：

| 文件 | SHA-256 |
| --- | --- |
| `dist/boot.js` | `f08330006f57c9ab747cd17732e14bc4cfff6e986df326585ddb1f08e8d245e1` |
| `dist/public/assets/index-BijAqDn9.js` | `16b697add3fb911a52586a395d9b402c94c60e33e2e1e59d54ad9bb1b1fa81bb` |

远端按计划执行了 APT 下载缓存清理及历史 journal vacuum。可用空间由约
145 MiB 增加至约 3.8 GiB，部署后约 3.1 GiB。原 `shufang-app`、
`shufang-db`、生产卷、生产镜像和备份保留；验收时生产容器仍连续运行约 3 天。

## 自动化验证

| 检查 | 结果 / 证据 |
| --- | --- |
| TypeScript | `npm run check` 通过 |
| ESLint | 0 error；原有 `AiSettingsPanel.tsx` Hooks 依赖 warning 1 项 |
| 普通测试 | 90 个测试文件、470 项通过；4 个可选集成套件共 15 项默认跳过 |
| 指定真实 MySQL | 同步存储 5 项、文件存储 1 项单独通过 |
| 生产构建 | Windows 构建及本机 Linux Docker 构建通过 |
| IndexedDB 升级 | 填充数据的 v7 → v9，记录保留、同步存储建立、关联索引升级通过 |
| 操作事务 | MySQL 提交序号、去重、ID 篡改拒绝；IndexedDB 业务/outbox 同提交和错误回滚通过 |
| 并发首次写入 | 同一事务内使用同一副本身份、不同时钟；失败测试修复后通过 |
| 草稿保存 | 保存失败保留 dirty，较早完成的保存不能确认更新草稿；真实界面快速离开通过 |
| 兼容迁移 | 旧分块迁移校验、保留原块；旧分块导入重试只写一条业务操作，通过 |
| 删除恢复 | 删除及关联墓碑在事务内提交；新 ID 恢复、旧墓碑保留，通过 |

本地构建仍有原项目的 bundle 体积、`sax/stream` 浏览器外置及混合动态导入提示。
这些没有导致本轮构建失败。没有将跳过的可选集成套件计为通过。

### 两台真实节点的认证 API

最新运行记录：[api-report.json](sync-evidence/api-report.json)。九组全部通过：

1. 两端交替新增全部实体类型，最终字段及版本一致。健康空闲队列本轮收敛
   **5,257 ms**，早一轮为 4,508 ms，均低于 15 秒目标。
2. 对每种可变实体分别从两端新增、对端修改、原端删除：共 20 个实体，
   20 份历史均保留三次操作。复习以不可变事件单独验证。
3. 独立脑图节点、学习集成员、两端复习事件合并；重复事件幂等。
4. 同字段确定性胜者、不同字段同时保留。
5. 已提交操作丢弃回执后按原 ID 重试，返回 duplicate；不同内容复用 ID 被拒绝。
6. 删除与迟到更新最终保持墓碑。
7. 创建固定水位快照后继续写入，增量游标能读到并发新增。
8. 未授权节点、错误工作区、撤销凭据被拒绝。
9. 原文件缺块续传、错误块摘要拒绝、完整提交和远端下载摘要一致。

文件验收依据完整性和两个副本。脚本的文件等待上限为实验超时，独立于
15 秒元数据目标。本轮大文件：666,036 字节，SHA-256：

`9e8c59d749539ef7855f9308568cd2fe3a2d511806eba3b9dfdaa5ace1d8dc4d`

## 实际故障步骤与浏览器

浏览器使用同一 Chromium 引擎的两个标签页，分别连接 `127.0.0.1:3101` 和
`127.0.0.1:3102`，两个 origin 的 IndexedDB 独立。不是跨浏览器引擎兼容性测试。

### SSH 网络分区

停止正向/反向隧道进程，分别在本机和远端环回 API 写入 `partition-20260927`：
Windows 写 title，Linux 写 content、color。断开期间 Windows 的实体没有
Linux 字段，Linux 的实体没有 Windows 字段。恢复隧道后自动收敛，字段值和
字段版本一致；未手工复制数据库或导出导入业务数据。

证据：[partition-result.json](sync-evidence/partition-result.json)。

### 浏览器离线与关闭

停止 Windows 原生服务，在 Windows 页面修改笔记正文。页面显示本地缓存、
服务不可达。关闭此标签页，再在服务仍停止时重新打开：应用壳能加载，笔记
保留离线修改。恢复服务后，Linux 页面显示相同内容。

随后 Linux 页面修改同一笔记，Windows 已打开的编辑器自动更新；不需要重新
打开笔记。最后针对防抖窗口，以同一次 UI 操作序列输入标题、正文并立即
返回列表（操作约 97 ms），最新草稿被保存。未完成落盘时现在会提示保存状态，
关闭页面受保护；存储失败提供重试，不能提前清除 dirty。

证据：[Windows 实时更新](sync-evidence/windows-browser.png)、
[Linux 离线恢复结果](sync-evidence/linux-browser.png)、
[立即离开编辑器](sync-evidence/windows-draft.png)。

### 空缓存初始化与未确认字段

另开 `localhost:3101` 的空缓存 origin，通过真实实验账号登录，快照初始化后
显示相同书籍和笔记。[空缓存浏览器截图](sync-evidence/fresh-browser.png)。
未确认字段不被旧快照覆盖由 `contracts/sync.test.ts` 和 IndexedDB 合并测试
验证；日志世代重置的额外实机注入被审批拦截，详见
[blocked-epoch-experiment.json](sync-evidence/blocked-epoch-experiment.json)。

### 原文件与阅读

执行交付的 `sync-api-example.mjs --write`，通过实际认证 API 新建合成 TXT 书籍。
两端原文件下载后内容、43 字节大小及 SHA-256 一致：

`fc978a2c4578871e7728d9364e3eac5cbeef941d3a799fcd546eebf016bdec88`

两端页面点击“下载并固定离线”，显示下载和校验成功；打开阅读器显示与 TXT
一致的正文。证据：[校验记录](sync-evidence/reading-file.json)、
[Linux 阅读及离线固定截图](sync-evidence/linux-reading.png)。

## 交付后的状态和范围

- 实验服务、数据库和文件目录保留，原线上书库未迁移。
- 最后节点检查两端序号均为 `316`，对端 failures 为 0；这是检查时刻的值，
  后续正常编辑会继续增长。见 [final-nodes.json](sync-evidence/final-nodes.json)。
- Windows 后台进程和交互式 SSH 隧道并非开机自启守护服务。常驻运行请依照
  [部署和备份恢复说明](workspace-sync.md) 配置服务管理器及 SSH 密钥。
- 未执行 iOS/Xcode、256 MiB 极限传输、多日浸泡、跨浏览器引擎兼容性测试。
- 日志、墓碑、历史对象和快照保留，当前没有自动垃圾回收；需监控可用空间。
