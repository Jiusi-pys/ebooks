> 当前状态（2026-10-03）：见[工程状态与验收门槛](../../docs/current-status.md)。本文件中的日期/版本记录保留其历史范围；当前迁移为 MySQL 0014 / SQLite 0003 / IndexedDB 11，生产尚未正式切换。

# Windows / Linux 工作区同步 v2

## 架构与边界

每个服务器有独立的 MySQL 数据库和内容寻址文件目录。浏览器以 IndexedDB
保存业务记录、字段版本和 outbox。服务器操作日志同时承担接收去重、历史和
向其他节点发送的持久化队列；业务状态和日志在同一个 MySQL 事务提交。

```mermaid
flowchart LR
  W[Windows 浏览器 / IndexedDB] <-->|同源会话 / v2| A[Windows Node]
  A <--> M[Windows MySQL]
  A <--> F[Windows SHA-256 文件目录]
  A <-->|HTTPS REST / 节点凭据，连接由 Windows 发起| B[Linux 容器]
  B <--> N[Linux MySQL 独立数据库]
  B <--> G[Linux SHA-256 文件目录]
  B <-->|同源会话 / v2| L[Linux 节点浏览器 / IndexedDB]
```

同步实体：书籍、文件夹、笔记、书摘（包括引用、批注和问答）、文段关联、
翻译、脑图、学习集、复习事件、非敏感偏好和原文件清单。书籍字段包括阅读
设置、位置、目录、封面和书目元数据。阅读位置另保留 `progressByDevice`。
复习操作生成独立事件；当前卡片状态采用字段版本合并，事件历史全部保留。

节点都是可写副本，提供最终一致性。正常空闲时约每 5 秒交换一次；失败使用
退避重试，最长 5 分钟。因此 15 秒目标针对健康连接，不针对故障后的退避窗口。
状态面板区分本机待发送修改、原文件待上传、正文待下载和节点错误。

浏览器可在已登录并缓存应用后离线运行，编辑直接进入 IndexedDB 事务。
同源多标签页通过 Web Locks 协调发送；无 Web Locks 的浏览器依靠幂等协议。
“固定离线书籍”下载、校验并保留原文件；站点数据被用户或浏览器清理后需要
重新下载。密码、会话和 AI/API 密钥不进入业务日志。偏好采用明确白名单。

## 冲突规则

- `operationId` 全局稳定，重试必须保持内容不变；相同 ID 不同内容返回 409。
- HLC 格式为十进制字符串 `wall:counter`，使用 BigInt 比较。
  字段版本依次比较 HLC、副本 ID、操作 ID，使用与语言区域无关的字典序。
- 不同字段合并，同字段确定性选胜者。日志保留所有收到的操作，包括败者。
- 删除是永久墓碑；迟到的修改不能复活实体。恢复接口生成新 ID。
- 脑图树展开为 `@node:<id>:<field>`，父节点字段代表树连线；学习集展开为
  `@member:<bookId>`。删除字段使用 `unset`，避免全量数组覆盖独立修改。
- 复习事件要求 `entityId == operationId`，禁止修改和删除；退出复习是新事件。
- `/mutations` 和旧 REST 的业务删除会在事务内生成关联墓碑或解绑操作。
  `/sync/push` 是操作复制接口，按原始操作重放，不再次执行业务命令。

初始快照在日志头锁内固定水位并复制状态。浏览器逐页持久化进度，按字段版本
与本地状态合并，然后从快照水位拉增量；不会清空未确认 outbox。
日志序号在持有 workspace 行锁的事务中分配，提交后才释放锁，避免跳过晚提交记录。

## API

可下载的契约：`docs/openapi-v2.json`；服务端：`GET /api/v2/openapi.json`。
可运行的 Node 示例：`scripts/sync-api-example.mjs`。

| 路径（均在 `/api/v2`） | 用途 |
| --- | --- |
| `GET /capabilities` | 协议版本、工作区、节点、日志世代、实体类型和大小限制 |
| `POST /mutations` | 业务字段修改；调用方提供稳定 operationId |
| `POST /sync/push` | 操作批量提交，最多 100 条、HTTP 正文最多 1 MiB |
| `GET /sync/changes?cursor=...` | 按提交顺序增量读取；游标不可跨节点复用 |
| `POST /sync/snapshots` | 创建固定水位快照 |
| `GET /sync/snapshots/:id?after=...` | 快照分页，空页表示结束 |
| `GET /entities?kind=...&after=...` | 状态、字段版本、墓碑分页 |
| `GET /entities/:kind/:id/history` | 最近 100 条操作，完整日志保存在 MySQL |
| `POST /entities/:kind/:id/restore` | 使用新实体 ID 恢复 |
| `POST /blobs/uploads` | 建立上传会话 |
| `GET /blobs/uploads/:id` | 缺失分块索引 |
| `PUT /blobs/uploads/:id/:index` | 256 KiB 分块；必须带 X-Chunk-SHA256 |
| `POST /blobs/uploads/:id/commit` | 完整大小和 SHA-256 校验后发布 |
| `GET /blobs/:hash` | 下载原文件或 JSON 大字段 |
| `POST /peers`、`DELETE /peers/:id` | 所有者签发、撤销入站节点凭据 |
| `GET /status` | 本地序号、节点最近成功时间和错误 |

所有 64 位日志计数均返回字符串。批量回执中 `error`、`persisted:false` 表示
该项没有提交；已成功的其他项可以按原 ID 重试。单项错误使用相应 HTTP 状态码。
原文件最大 256 MiB。较大正文、封面等字段以
`{"$blob":{"sha256":"…","size":123,"name":"field.json","type":"application/json"}}`
表示；客户端先上传 JSON 字节，再提交引用。浏览器自动外置大于 128 KiB 的字段。
文件不可用不会阻塞服务器元数据日志游标；两端分别完成文件复制与最终校验。

浏览器使用同源 HttpOnly 会话及已有 Origin 校验。机器调用使用所有者
`OPEN_API_KEY`，或限定当前工作区的节点 token，并携带 `X-Workspace-Id`。
配对接口只允许所有者调用。token 仅签发时返回，数据库只保存摘要。

示例（从进程环境读取凭据，不把 token 放进命令参数或 URL）：

```powershell
$env:SHUFANG_URL = 'http://127.0.0.1:3101'
$env:SHUFANG_WORKSPACE = 'your-workspace'
# SHUFANG_TOKEN 由本地凭据管理方式注入。
node scripts/sync-api-example.mjs          # 只读能力与状态
node scripts/sync-api-example.mjs --write  # 新增一本合成 TXT 书籍及原文件
```

## 配置与部署

两端使用同一个 `SYNC_WORKSPACE_ID`，不同且长期稳定的 `SYNC_NODE_ID`。
每个节点必须使用独立数据库，不能让两个节点共享一组 sync 表。

### 正式环境：单端主动建立 HTTPS 连接

Windows 在 `SYNC_PEERS_JSON` 配置云端 URL（本次为 `https://us.jiusi.org`）、
`linux-personal` 节点 ID，以及由云端签发的工作区节点 token。Linux 使用
`SYNC_PEERS_JSON=[]`，通过现有 HTTPS 入口接收请求，无需反向连接 Windows。
Windows 不需要公网 IP、端口转发或 SSH 隧道。

每轮 Windows 都会：

1. 查询 `/api/v2/capabilities`，核对节点、工作区、版本和日志世代。
2. 通过 `POST /api/v2/sync/push` 推送本地增量，逐项检查持久化回执，
   全部确认后才保存发送游标。回执丢失或部分失败时按原操作 ID 重发。
3. 通过 `GET /api/v2/sync/changes` 拉取云端增量并保存接收游标。
4. 按内容引用上传或下载缺失文件，沿用上传会话、缺块查询、SHA-256 校验。
   上传会话持久化，重启后续传；已确认的文件在当前进程内避免重复检查。

发送游标与文件上传状态绑定云端世代；云端恢复时按恢复流程更新世代，
客户端重新交换操作和检查文件。文件错误不回退已经确认的元数据游标。
恢复时未更新世代或手工删除已确认文件，不属于正常恢复流程。

健康空闲时约每 5 秒发起下一轮。双向指的是数据方向，TCP/TLS 连接始终由
Windows 主动发起。SSH 仅用于人工测试和部署管理，不参与正式数据传输。

本版本采用 REST 轮询，没有新增 webhook 依赖。未来有可公开访问的接收端时，
webhook 可以通知立即拉取；仍需周期性拉取兜底，不能把通知当作持久化回执。

```dotenv
NODE_ENV=production
HOST=127.0.0.1
PORT=3101
DATABASE_URL=mysql://dedicated_user:secret@127.0.0.1:3306/dedicated_database
SYNC_ENABLED=true
SYNC_WORKSPACE_ID=personal-workspace
SYNC_NODE_ID=windows-personal
SYNC_BLOB_DIR=.runtime/personal-blobs
SYNC_PEERS_JSON=[]
AUTO_UPDATE_ENABLED=false
```

还需要按 `.env.example` 配置本节点的账户引导、数据和会话密钥。
各节点账户独立；账户和密钥不复制。配置文件权限只给运行账号。
新建节点先启动空 peers，分别在另一端签发入站凭据，再将对应 token 写入
自己的 `SYNC_PEERS_JSON=[{"id":"linux-personal","url":"http://127.0.0.1:3102","token":"…"}]`。
正式 URL 使用 HTTPS。环回 HTTP 仅保留给本机或 SSH 隧道测试。

Windows Git 检出的 Node 服务：安装 Rust 1.93.1 并添加
`wasm32-unknown-unknown` target，在 `app/` 执行 `npm ci`、`npm run build` 后运行
`powershell -File scripts/start-sync-windows.ps1 -EnvFile .env.sync`。
常驻运行应由服务管理器守护这个进程；实验中的后台进程不是开机自启服务。

Linux Docker：在仓库根目录执行
`docker build -t shufang-sync:local -f app/Dockerfile .`，
然后 `docker save` / `docker load` 搬运镜像。配置 `.env.sync` 后使用
`docker compose -f compose.sync-linux.yml up -d`。该模板使用 Linux host 网络，
MySQL 由 `DATABASE_URL` 指定，可以是已有实例里的独立库及专用账号。

以下隧道仅用于历史实验，不用于正式同步：

```sh
ssh -N -o ExitOnForwardFailure=yes -o ServerAliveInterval=30 \
  -L 127.0.0.1:3102:127.0.0.1:3102 \
  -R 127.0.0.1:13101:127.0.0.1:3101 root@us.jiusi.org
```

SSH 断开后两端仍可本地写入。常驻部署应使用受控 SSH 密钥与隧道服务守护；
实验使用的交互式隧道只在进程存活期间工作。不要把密码写入仓库。
实验期间关闭自动代码更新，记录源码提交、构建校验值、MySQL 版本和协议版本。

## 兼容迁移

1. 先备份数据库和文件目录，再应用 `0014_workspace_sync.sql` 增量结构。
2. 开启 v2 时将旧镜像导入规范状态，保留旧表。原文件分块经完整校验后建立新引用。
3. IndexedDB 同步结构在版本 9 引入，当前版本 10 包含结构修复；保留已有记录，首次配对将已有业务数据和原文件排队。
   文段关联的 pair 索引改为非唯一，允许两个设备同时创建独立关联。
4. 旧 `/api/v1` CRUD、事件与分块导入，以及 `/api/library` 状态和原文件操作
   经兼容层进入新存储。升级浏览器停用旧镜像发送循环。
5. 旧备份表不再作为 v2 的实时真相来源；回退到旧程序前必须先导出新增数据，
   不能只关闭 `SYNC_ENABLED` 就期待看到升级期间的全部修改。

本版本保留操作、墓碑、快照和历史文件，不自动垃圾回收；需监控磁盘空间。
原文件分块、旧导入暂存和快照也会占用空间。大库迁移应预留额外空间并分阶段上线。

多端可能跳过多个发布版本：MySQL 必须保留完整 SQL/journal，IndexedDB 必须
保留历史 upgrade 分支，一次更新按序补齐中间迁移。新增数据库设计必须同时
交付迁移、历史归档、跨版本验证和失败恢复说明，详见根目录 AGENTS.md。
历史脚本备份见 [migration-history](../db/migration-history/README.md)。
us 节点的日常程序发布已使用 [GitHub Actions / 更新 API](../../deploy/README.md)，
上面的 SSH 隧道步骤仅用于隔离实验，不是当前线上同步或自动发布的依赖。

## 备份与恢复

- 对本节点数据库执行 `mysqldump --single-transaction`；随后备份整个
  `SYNC_BLOB_DIR`。对象先完成写入再发布引用，保留对象且未启用 GC 的情况下，
  先取数据库快照、后复制文件可以包含快照引用的所有对象。
- 单独保护 `.env.sync`、节点凭据及数据库账号；它们不属于业务同步数据。
- 恢复前停止该节点并确保旧实例不会同时运行。恢复 SQL 和文件目录，保留
  同一节点 ID；更新 `sync_heads.epoch=UUID()`，使旧游标失效。
- 配对凭据恢复可能回退撤销状态，恢复后重新签发所有节点凭据并撤销旧凭据。
- 节点遇到游标世代错误会重新读取；浏览器保留待发送操作并重新合并快照。
  如另一个节点存活，它可补回备份之后已经复制过去的操作。
- 新副本应从空数据库加入，不能复制数据库后继续使用相同节点身份。
- 丢失尚未复制且不在备份中的唯一节点数据无法由同步协议重建。

## 测试与实验

```sh
npm run check
npm run lint
npm test
npm run build
# 指向专用、已迁移的测试数据库：
# SYNC_TEST_DATABASE_URL=mysql://... npx vitest run api/sync/store.mysql.test.ts
node scripts/sync-lab-verify.mjs
```

`sync-lab.mjs` 建立隔离实验配置；`sync-lab-pair.mjs` 配对；
`sync-lab-partition.py` 在断开隧道后分别运行；`sync-lab-verify.mjs` 验证实际服务。
这些实验脚本固定使用本机 3101、隧道 3102、专用 lab 数据库，不能用于生产账号。
验收记录见 `sync-acceptance.md`。iOS / SwiftUI 构建与模拟器测试留到 Mac 阶段。

## 原生适配器当前门槛（2026-10-03）

Rust v2 与旧 Hono/MySQL 节点已通过隔离操作/文件互通，另有 Windows
原生 SQLite、MySQL v2、Linux 原生服务三节点 HTTP 试验。SQLite 0003
仅追加世代/固定快照，完整迁移归档独立保留。Windows 设置页支持节点配置、
暂停/恢复、手动请求与状态。详细证据、Linux 凭据和所有者配置接口见
`docs/native-sync-acceptance-20261003.md`（仓库根）。这不等同于完整原生 v2
一致性或全业务迁移验收：无损 UTF-16、全部旧投影/校验、超大原生字段、
快照恢复、整库切换和真实 HTTPS 仍有后续门槛。
