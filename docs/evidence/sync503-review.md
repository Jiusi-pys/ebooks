# us 同步 503：诊断、修复与线上验收

2026-10-08，目标 `https://us.jiusi.org`。结论：**已确认并修复 MySQL 写连接失效后无法恢复的缺陷，永久补丁已部署；复核未发现遗留的可操作缺陷。** 此结论限于本次 503，不代表 Android 全功能验收完成。

## P1：恢复已断开的 MySQL 写连接（已修复，高置信度）

位置：[MysqlRepository::writer_connection](../../base/crates/mysql/src/lib.rs:266)。此前仅返回长期持有的 `Mutex<Conn>`，后续 `writable()` 在失效连接上执行 `IS_USED_LOCK`，得到 `storage_error: mysql operation failed`。读取使用另外的连接池，因此读成功不能证明同步快照可用。

真实服务器复现：带现有机器认证的 `GET /api/v2/capabilities` 返回 200，`POST /api/v2/sync/snapshots` 返回 **503**，错误正是上述存储错误；读取 changes 返回 200。数据库中对应工作区的写锁 owner 为 NULL。快照表存在、列与代码匹配，70 条实体中的最大正文约 153 KB，低于 64 MiB packet 限制。

触发条件是专用写连接断开后仍继续复用它。生产 `wait_timeout=28800` 秒，服务已运行两天，空闲超时与现象吻合；未取得原始断开事件日志，因此不把“具体哪次超时关闭该连接”当作已证实事实。连接失效且不恢复是已复现的确定缺陷。临时重启原服务后，快照立即恢复 201，分页 200。隔离 MySQL 将空闲超时缩短至 2 秒后重现写锁消失，永久修复可不重启地恢复请求。

修复措施：

- 在事务开始前检查连接。断开时，在数据库恢复互斥锁保护下建立候选连接。
- 候选连接必须重新取得原工作区写锁，并核对原 `node_id` 和 `epoch`，才替换旧连接；不抢占竞争写者。
- 数据库恢复锁使用单独连接，离开恢复作用域即释放。失败的候选连接也释放所持锁。
- 不自动重试事务或 commit，避免提交结果不确定时重放操作。MySQL schema、协议、认证模式未修改。

## 审查范围与风险

明确意图（stated）：查明 Android 连接 us 同步时 503 的原因并修复，包括实际验证。使用用户明确调用的 `agentic-review` 技能，完成理解、对抗、验证三个视角。

工作分支 `android`，HEAD `40f84d9a17b7ca68e3134f2093afba82fb687c11`。线上原版本为 `3cbda7f69e1d02f5d9b5c81e7644712b19054c8f`，其整个已提交 `base/` 树与 HEAD 相同。生产构建从此原版本导出，只替换 MySQL `lib.rs`；没有打包工作区尚未提交的 Android 核心改动。新增回归测试位于 [writer_reconnect.rs](../../base/crates/mysql/tests/writer_reconnect.rs)。

风险 Tier 3：写者租约影响共享数据和可用性，维护周期长；有真实 MySQL/HTTP 证据及独立只读审阅降低不确定性；无迁移，镜像/容器可回退。独立审阅追踪锁、恢复 gate、身份与事务边界，未发现可操作缺陷；其测试证据为读取主流程日志，未声称独立再次执行生产测试。按建议补测 node 身份变化、恢复 gate 占用和释放。

此次修复由用户明确授权执行。保留业务数据、认证配置和旧运行容器；没有新建生产账号、改变账号权限、修改数据库历史或把模拟器测试数据合入生产。

## 实际证据账本

| 检查 | 实际结果 | 证据 |
|---|---|---|
| TDD 失败测试 | 原实现 3 failed，均落在失效写连接路径 | [red](sync503/sync503-red.log) |
| MySQL 恢复与边界 | 5 passed，连续重跑亦 5 passed | [green](sync503/sync503-green.log)、[repeat](sync503/sync503-repeat.log) |
| 原 MySQL 数据/凭据/快照/恢复 | 4 passed，显式执行 ignored 测试 | [regression](sync503/sync503-mysql-regression.log) |
| 实际 Linux HTTP 服务，连续两次断连接 | 快照 201、分页 200、push 200，重复操作去重 | [HTTP](sync503/sync503-http.log) |
| 实际 MySQL 自然空闲超时 | 确认锁消失；读取 200、恢复快照 201，不重启服务 | [idle](sync503/sync503-idle.log) |
| Rust workspace | 168 passed；默认忽略的数据库等测试不计通过 | [workspace](sync503/sync503-workspace.log) |
| Clippy workspace/all-targets，warnings as errors | passed | [Clippy](sync503/sync503-clippy.log) |
| Web check / lint / build | passed | [check](sync503/sync503-web-check.log)、[lint](sync503/sync503-web-lint.log)、[build](sync503/sync503-web-build.log) |
| Web Vitest | 611 passed / 53 skipped | [Vitest](sync503/sync503-web-test.log) |
| 部署监督器 | 15 passed | [supervisor](sync503/sync503-supervisor.log) |
| MuMu → 真实 us HTTPS | 公开账户状态通过；无保存账号会话的认证用例跳过（-4） | [device](sync503/sync503-mumu-real-server.log) |
| 生产永久修复 | 快照 201、分页 200、70 实体；实体数与 seq 部署前后均为 70 / 4300；restartCount=0 | [production](sync503/sync503-production.json) |

隔离实例使用独立 Docker MySQL 8.4.11，监听 `127.0.0.1:33119`，专用数据库 `shufang_test_sync503` 和 `shufang_test_sync503_restore`，执行完整既有 0000–0015 迁移。测试断连只针对随机测试工作区，未断开生产连接。重复测试最初暴露测试自身固定快照 ID 冲突，已改用 UUID，再次重复运行通过。

## 线上产物、备份与回退

Linux x86_64 / Rust 1.93.1，服务二进制 SHA-256：

`1e609bac49799100be9e93e8b59dc109662bae01dc5f7adf0c14efb4e5edc217`

新镜像 `shufang:sync503-20261008`，不可变 ID：

`sha256:9e65280b5b86d6d3e065c2efe4b7d074f2cca93b31d818a655e7a6064fbee06f`

从线上原镜像复用运行层，只替换经测试的二进制。生产小主机未进行完整源码编译。构建输入和源码哈希见 [source manifest](sync503/source-manifest.json)，补丁见 [patch](sync503/mysql-reconnect.patch)。这是明确标记的工作区热修复，尚未提交或推送 Git；后续正式发布必须包含此补丁，不能部署未修复的旧 base 来覆盖它。

部署先完成一致性版本备份，再停旧写者并启动新容器；沿用原环境、挂载、网络和重启策略。备份目录：

`/opt/shufang/backups/rust-20261008T004844Z-version-d76cdc13-1877-4e7b-97eb-216e60261734`

备份清单哈希已验证。原容器保持停止状态：`shufang-app-before-sync503-20261008`，原镜像保留。热修复文件及脱敏部署结果在 `/opt/shufang/hotfix-sync503-20261008/`；包含配置的旧容器记录仅限 root 读取，不作为公开证据。

如新镜像出现故障，管理员可执行以下容器回退；先确认目标名称没有被后续部署复用：

```sh
docker stop -t 30 shufang-app
docker rename shufang-app shufang-app-sync503-reverted
docker rename shufang-app-before-sync503-20261008 shufang-app
docker start shufang-app
```

该流程只回退程序，不回退数据库，也会重新带回旧版本断连不恢复的缺陷。隔离环境使用实际旧生产二进制进行旧版→热修复切换验证，记录见 [rollback](sync503/sync503-rollback.log)。生产未为测试刻意切回旧版。

## 复跑与剩余限制

```powershell
$env:SHUFANG_TEST_MYSQL_URL='mysql://<test-user>:<test-password>@127.0.0.1:33119/shufang_test_sync503'
cargo test --manifest-path base/Cargo.toml -p shufang-mysql --test writer_reconnect -- --ignored --test-threads=1
```

HTTP/自然超时辅助脚本 [sync503_http.py](sync503/sync503_http.py)、[sync503_idle.py](sync503/sync503_idle.py) 固定指向本次独立 WSL Docker 测试实例和回环地址，需要先按脚本容器名、端口启动已迁移测试库及热修复服务；不接受生产地址。测试凭据是该一次性隔离实例的测试值。

未验证：长达数日的持续运行、网络半断开、commit 响应丢失、用户真实 Android 账号的完整双向同步。生产验证使用现有机器认证访问同一快照路径，不等同于 Android 账号端到端通过。没有可用账号会话时明确保留跳过结果。Android APK 无需因本次服务端修复更新，UI 与图标不属于这次补丁范围。
