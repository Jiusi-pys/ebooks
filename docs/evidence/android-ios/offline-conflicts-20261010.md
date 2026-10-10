# 离线并发同步冲突：2026-10-10 交付

本轮完成 Android 的持久冲突队列、发送前检查、条件写入、选择界面与失败恢复，并升级 `https://us.jiusi.org` 的兼容接口。源码仍位于 `android` 分支的未提交工作区，HEAD 为 `40f84d9`；固定 iOS 基准不变。本记录不宣称整个应用已达到全部 1:1 验收门槛。

## APK 与行为

交付 [app-debug.apk](../../../platforms/android/app/build/outputs/apk/debug/app-debug.apk)，版本 0.2.0 / versionCode 2，134973488 字节，SHA-256：

`5d6919ecce8bcdca5968523def9f26f2c2813d7188e507f28e3e50d605275557`

支持 API 26 起、arm64-v8a 与 x86_64；调试签名。来源清单及固定构建版本见 [build-receipt.json](runtime/20261010-conflicts/build-receipt.json)，来源文件清单 SHA-256 为 `8d1d94620429d955a3aa6653ecfc7bceb0e6e5503c298fa59f744353b3130ba1`。交付包与实际运行验收包的全部 51 项阅读资源及原生库逐字节一致，见 [apk-equivalence.json](runtime/20261010-conflicts/apk-equivalence.json)。API 26 拉回的实际安装包哈希与交付包一致，冷启动和书架检查通过。

同一字段的不同修改、删除与修改、大正文以及二进制手写附件，在发送前保留双方版本并暂停同步；不同字段可以自动合并。设置中的待处理列表可以预览并选择本机、服务器或双方副本，稍后处理及重启保留冲突。预览后再次变化会拒绝旧选择。没有服务端条件写入能力时保留离线修改并明确暂停发送。

选择结果提交为新操作；原操作身份和历史不被改写，明确撤回有独立审计记录，远端回执核验后才确认已发送。503 出现在已经提交但回执丢失时，重试识别原操作，不重复写入也不制造假冲突。接收与并发编辑之间也有事务检查，避免下载状态覆盖尚未发送的编辑。

远端已删除书籍／文件夹时，保留本机或双方会创建新身份并重建当前学习依赖，包含原文件记录、卡片、笔记、脑图、学习集、关联及复习引用；原删除身份仍保留。原文件复用已验证哈希，副本在两端实际打开的字节验证通过。唯一关系和稳定设置仅提供本机／服务器选择。依赖复制上限为 10000 条，超过限制明确失败并保留原数据。

## 实际验证

| 项目 | 结果与证据 |
|---|---|
| 核心契约与原子决策 | 5 个专项测试通过；删除书籍复制原文件先出现 `source_not_found` 失败，再修复并通过；引用 ID 前缀边界有单独测试 |
| 真实双客户端 HTTP | 9 项通过：同字段冲突、独立字段合并、重启、双方副本、删除恢复、约 1MB 中文 emoji、迟到写入、提交后返回503、不透明手写附件及学习依赖；追加原文件网络专项通过，见 [source-copy-network.txt](runtime/20261010-conflicts/source-copy-network.txt) |
| Android 设备 | API26 / API28 / MuMu API35 均报告37项；默认有9项条件项目跳过，网络与真实账号专项另行显式运行。API28 最新冲突操作2项追加通过；宽窗口双倍字号与 API26 窄窗口均完成实际冲突选择 |
| 跨端业务与手写 | [第13轮真实网络记录](cross-network/20261010-13/results.json)：Android JNI→独立服务→iOS StudyStore/PencilKit→真实 Chrome IndexedDB 与网页同步模块；三条笔画仍可编辑，两条复习事件，ZIP 往返通过 |
| 共享回归 | Rust workspace 201通过、20个环境条件测试未执行；Clippy `-D warnings` 通过。Web check/lint/test/build通过，624通过、53条件跳过；部署监督器15通过 |
| Android 构建 | 23项单元测试、Lint、双ABI、ELF及APK 16KB对齐、签名检查通过；API26交付APK安装、冷启动、书架和崩溃缓冲检查通过 |
| 服务器候选 | 固定生产源码基础上仅追加预检与可选条件push，保留既有MySQL断连修复；匹配bookworm环境构建、9项协议测试通过，MySQL真实陈旧写入拒绝、重复回执、断连后快照与提交通过 |
| us线上 | 实际Android HTTPS登录、session、`conditionalPush:1`及空操作只读预检通过，见 [real-server-capability.json](runtime/20261010-conflicts/real-server-capability.json)。未在生产书库执行破坏性并发业务测试 |

设备测试与构建日志位于 [runtime/20261010-conflicts/](runtime/20261010-conflicts/)。网络专项使用验收包、独立测试书库及服务器；常规37项结果不把跳过项当作执行成功。整个网页控件交互、全部实体组合和物理手写体验仍有原计划中的后续门槛。

## 线上备份、切换与回退

升级前独立数据库导出及全部业务文件、凭据运行目录备份位于本机受限的 `.tools/us-conditional-private-backup-20261010/`，未纳入版本库。数据库为77766211字节、运行归档31501257字节；哈希及归档解压读取检查通过。历史版本ZIP未重复传输，保留于 `/opt/shufang/runtime-rust/versions/` 并逐个记录SHA-256；它们不替代数据库及原文件备份。服务短暂停止以建立数据库快照，导出建立后恢复原服务，再完成文件备份。见不含凭据的 [server-backup.json](runtime/20261010-conflicts/server-backup.json)。

生产补丁目录 `/opt/shufang/hotfix-conditional-20261010/`，旧容器 `shufang-app-before-conditional-20261010` 保留。候选二进制SHA-256为 `44574b9fbb2e68d091eab4afa6694d36716ae4baf52797d1722feef13e55d2fb`。切换前后实体数99、同步序号4330、迁移账本条目16一致；MySQL0014 / SQLite0003 / IndexedDB11未改变。实际运行、重启次数0见 [server-state.txt](runtime/20261010-conflicts/server-state.txt)；[部署记录](runtime/20261010-conflicts/server-deployment.json)包含镜像身份。

首次使用滚动 `rust:1.93.1-slim` 构建，因GLIBC版本高于生产bookworm，启动失败；自动回退成功，失败日志保留。随后改为固定 `rust:1.93.1-slim-bookworm`，重新完整构建、启动兼容检查及MySQL网络验证后部署成功。旧生产二进制在隔离同一数据库上的实际回退／重新切换验证见 [mysql-rollback.json](runtime/20261010-conflicts/mysql-rollback.json)。

程序回退：停止当前 `shufang-app`，将其改名保留，将旧容器改名为 `shufang-app` 再启动；先核验端口和只有一个写进程。程序回退不恢复数据库，也不能让旧Android发送器忽略撤回记录。数据库恢复须先完整停止写入、校验私有备份，在隔离库演练后按原配置恢复数据库与配套文件；不得直接覆盖仍在写入的书库。

可重复导出最小服务器源码：`python deploy/build_conditional_sync_source.py --output <新目录>`，随后使用固定bookworm Rust镜像执行协议测试和release构建。原生产基础提交为 `3cbda7f69e1d02f5d9b5c81e7644712b19054c8f`，来源范围见 [server-source-manifest.json](runtime/20261010-conflicts/server-source-manifest.json)。服务器未合入整个Android工作区，也未修改已发布迁移。

## 审核与边界

按 agentic-review 的理解、反例、验证三轮复核共享事务、条件检查、重复回执、入站编辑竞态和生产回退，已修复依赖原文件遗漏及引用前缀误改。当前审查范围未发现剩余可复现的阻断问题；风险等级3，原因是涉及用户数据同步、删除冲突和生产可用性。用户明确要求修复并提供部署连接作为本次升级授权；仍建议独立维护者复核补丁与运行记录，不将本次单一审核当作独立双重审核。

失败记录还包括：API28大字号下PDF被WebView再次缩放，已固定textZoom=100并继续由阅读字号应用系统缩放；API26的Compose截图工具不能捕获弹窗，截图采集按API限制调整，业务断言全部保留并重跑。首次网络脚本与设备测试占用相同端口，失败后串行重跑。所有这些失败均与最终通过记录区分保存。

线上并发业务写入仍未使用独立WAN账号进行；Android／iOS／Web业务与手写往返在隔离真实网络验证。汉王7英寸及10.9英寸真机、物理笔与厂商刷新接口、arm64设备实际运行仍未验证；不以模拟器替代这些门槛。
