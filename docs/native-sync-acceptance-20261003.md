> 当前状态（2026-10-03）：见[工程状态与验收门槛](current-status.md)。本文件中的日期/版本记录保留其历史范围；当前迁移为 MySQL 0014 / SQLite 0003 / IndexedDB 11，生产尚未正式切换。

# 原生同步阶段实施与验收（整项计划尚未完成）

2026-10-03。基于用户批准的 Windows/Web/Linux 服务范围实施，工作树来源
HEAD `f6879718dbc2333b3d39dcfafadb6b8318e0047e` 加未提交改动。此记录不等于
完成“全部业务统一到 base”或发布验收；尚未整体迁移、切换真实书库，也未发布新包。
既有 0.3.3 ZIP 保持原 SHA-256
`08f823249c224e1eb6050408d632fc818bbb07b7c4af0a4b3e8c98c3154da8be`。

## 本阶段落地

- application 的复制端口、接收合并、幂等 ID、HLC、发送回执检查和重试间隔；
  sqlite 适配器在一个事务提交实体、复制日志和接收游标。网络调用在事务之外。
- SQLite 0003 追加世代和固定快照；0001/0002 未改写，已有 outbox 顺序/ID 保留。
  接收操作写同一复制日志，重复接收不产生回声循环，不触发业务 webhook。
- v2 能力、push/changes、mutations/openapi、实体分页、固定快照、历史、创建新 ID 的恢复、
  节点令牌配对/撤销以及文件分块接口。旧回执没有 persisted 时仍须具有
  原操作 ID 和合法持久化 seq；部分/错序/错误回执不能推进游标。
- v2 本地 mutation 的书籍删除级联、书单成员移除、文件来源墓碑、文件夹/
  笔记引用清理在共享 application 中执行，根操作与级联同事务、同 HLC；
  远端接收不会再次级联。SQLite 级联写入故障注入证明实体、日志和时钟全回滚，
  修复后重试成功；重复请求回放原根操作回执，不重复产生级联。
- 已知字段的部分投影校验进入 domain，34 组 WASM/旧 TypeScript 差分通过。
  扩展字段仍允许，合法 $blob 按旧协议跳过部分校验。该结果不覆盖无损 UTF-16、
  完整投影、JSON 规范化或资源 hydration。
- 分块 SHA-256、整文件 SHA-256、重启续传、损坏对象重建；已校验对象与
  未完成上传分块纳入工作区备份/恢复。元数据不等待缺失文件，文件错误单独重试。
- Windows 设置页加入节点选择/编辑、令牌 PasswordBox、暂停/恢复、立即请求
  和状态；C# → C ABI 调用已验证。网络工作由独立服务执行，默认暂停。
- Windows 窗口、独立服务、登录启动入口、更新重启/快捷方式保留工作区与节点 ID。
- Windows DPAPI 不变；Linux 文件凭据用独立部署密钥 AES-256-GCM，或采用环境
  引用。缺失凭据的后台状态可见，公共配置不输出令牌、环境引用或本地凭据路径。
- 更新器识别 SQLite 0002/0003 的完整迁移链，并比对签名清单的数据版本。
  只读版本探测不会迁移或创建数据库；拒绝数据降级。更新启动失败后只有数据库
  版本未变化才可重启旧程序，否则保留备份、标记 recoveryRequired，需显式恢复。

## 验证证据

| 检查 | 当前结果 / 范围 |
| --- | --- |
| Windows Rust workspace release tests、Clippy `-D warnings` | 80 通过、6 ignored；结果日志 `.tools/native-sync-rust.log`；外部/解析器 opt-in 项单列，不计作默认通过 |
| Linux Rust 1.93.1 容器 workspace tests、Clippy | 81 通过、6 ignored；`.tools/native-sync-linux-tests.log`、`.tools/native-sync-linux-clippy.log` |
| Web check / lint / test / build | 通过；120 文件中 114 通过、6 跳过；568 测试通过、46 跳过；跳过项未冒充验收 |
| WinUI / Updater / UpdatePublisher release build | 通过，0 警告、0 错误 |
| C# CoreBridge.Smoke | 通过；包含节点配置、手动请求、凭据隐藏、只读 schema 探测及原有重启/修订冲突检查 |
| Updates.Tests | 通过；测试密钥签名、schema 3/不支持 schema、签名/包内版本不一致、完整链、旧请求默认身份、路径/哈希/降级拒绝 |
| Python deployment supervisor | 11 测试通过 |
| 两个原生 SQLite 节点真实 TCP/HTTP | 双向数据、离线修改后重连、重复页不扩增日志、缺失文件补传/对象损坏重建通过 |
| 旧 Hono + 实际 MySQL 8.4 ↔ Windows 原生 SQLite | 专用临时 workspace、节点范围令牌；双向笔记、原 ID 重放、原文件分块通过 |
| Windows 原生 SQLite ↔ 旧 MySQL v2 ↔ Linux 原生服务 | 三个独立存储的真实 HTTP 试验通过；包含 Linux 自建笔记、原文件、嵌套 `0.0/0` 回传幂等；`.tools/native-sync-three-nodes.log` |
| SQLite 跨版本与完整归档 | 空库、0002→0003、0001→0003、重复、DDL 失败回滚后重试、保留原记录/日志及未来版本拒绝通过；35 个迁移文件和归档哈希核验通过 |
| Linux 凭据恢复 | 加密 round-trip、随机 nonce、错误密钥、错误凭据用途、篡改拒绝，恢复后 0700/0600 权限通过 |

MySQL 试验仅使用本轮创建的专用容器/数据库，未访问已有真实书库；测试令牌和
Linux 测试密钥均为隔离测试值。三节点结果证明传输/存储互通，未证明 React 浏览器
全部交互或 WinUI 鼠标操作。本次设置页为编译与桥接验收，尚未做完整交互验收。
本轮拥有的测试容器已清理，原有 shufang-mysql 未改动。测试缓存卷保留。
阶段日志 SHA-256 与统计见 `docs/evidence/native-sync-phase-20261003.json`。

主要回归源：`base/crates/sqlite/tests/{replication,migrations}.rs`、
`base/crates/native/tests/{sync_config,sync_blobs,backup,credentials}.rs`、
`base/crates/service/tests/{sync_v2,replication_network,old_v2,webhooks}.rs`、
`app/api/sync/native.mysql.test.ts`。旧节点测试明确 opt-in；单独执行 ignored Rust
用例须由 Hono/MySQL fixture 注入环境，不能空跑计作通过。

## 启动与配置

创建隔离节点时，同一书库使用同一 workspace ID，每个节点使用不同 node ID。
数据库身份创建后固定；使用错误身份打开会失败，不能通过改 ID 把副本变成新节点。

```text
Shufang.Windows.exe --workspace C:\Shufang\lab --workspace-id lab --node-id windows-a
shufang-service --workspace /srv/shufang/lab --workspace-id lab --node-id linux-a --public-url https://linux.example.test
```

默认仅绑定 127.0.0.1。容器需要显式 `--listen 0.0.0.0` 并限制宿主映射；
生产远端地址需由 HTTPS 反向代理提供，本轮未部署该代理或真实 HTTPS 更新源。

Linux 部署密钥 `SHUFANG_CREDENTIAL_KEY` 为 64 位十六进制，独立保存于部署密钥
系统；不随数据备份/同步传播。可选 `SHUFANG_SERVICE_TOKEN` 提供服务所有者令牌；
未提供时加密凭据库生成并持久化。原 Windows DPAPI 凭据仍需原用户/系统解密。
环境引用 `tokenEnvironment` 仅存名称，恢复后须再次注入外部环境。

服务所有者使用 Bearer 或 X-API-Key，配置接口为：

| 接口 | 参数 / 结果 |
| --- | --- |
| GET `/admin/sync` | 公共 config（revision、paused、peers、identity）与 status |
| POST `/admin/sync/peers` | expected、id、url、token 或 tokenEnvironment；不得同时提供两种凭据 |
| DELETE `/admin/sync/peers/:id` | expected；仅移除本地配置，不删除远端实体 |
| PATCH `/admin/sync` | expected、paused |
| POST `/admin/sync/run` | 请求提前重试；不等同于同步已经成功 |

节点范围令牌只能访问 v2，不能访问这些管理接口。UI/HTTP 的 expected 为当前
本地配置 revision；冲突应刷新配置再保存。远端 URL 必须为 HTTPS origin；
只允许 localhost/127.0.0.1/::1 在隔离测试中使用 HTTP。

## 仍未完成的发布前置门槛

1. 原生 JSON 无损 UTF-16、完整旧投影/校验/排序/规范哈希差分。JavaScript 的
   call-local 透明槽位只解决当前 WASM 合并调用，不能宣称原生传输已无损。
2. 全部 React hooks/IndexedDB 与既有服务端业务编排迁入共享核心。当前
   `useLibrary.ts`、`db.ts` 等仍有业务规则，尚未达到“一份 base、全部平台同规则”。
3. 原生大字段在首次提交前外置、书籍 source/fileId 联动与导入共享原文件。
   当前 worker 识别已存在的 sources/$blob；超过 v2 批量限额的内联原生操作
   会报告 `sync_operation_requires_blob`，不会改写旧操作 ID 掩盖缺口。
4. 完整 v2 负例/响应与投影差分、快照引导/游标恢复、节点世代恢复、
   存储配额和快照/上传会话回收、断点故障注入与整库预检/备份/单写入路径切换。
5. 实际 WinUI 设置交互、跨 schema 更新/失败启动的发行包端到端测试与干净
   Windows 环境验收；此前真实登录/重启、生产签名、其他 AI/OAuth 部署缺项
   独立保留，不能用本轮编译或本机试验代替。
6. 真实 HTTPS 三节点配置及隔离 workspace 验收。待提供节点 URL、workspace/node ID
   和配对凭据的本机配置引用；不得把生产 token 粘贴到日志或自动切换真实书库。

迁移设计及恢复顺序见 [执行合同](native-sync-execution.md)。SQLite 最新为 0003，
完整独立归档位于 `app/db/migration-history/20261003-through-mysql0014-sqlite0003.*`。
MySQL 仍为 0014，IndexedDB 仍为 10；本轮未更改这两条已发布迁移链。
