# MySQL 0015：Rust 仓库运行状态

用户选择保留 MySQL；既有 0000–0014 迁移和生产同步表不修改。
0015 只追加 Rust 内部 revision、local_values、change_log 表。已有 sync_heads、
sync_operations、sync_entities、快照、凭据、账户仍是主账本，SQLite 不是生产主库。

旧起点：支持现有全部历史 MySQL 迁移链，更新器依序执行缺失迁移直到 0015。
先停写/保存 MySQL 与原文件及独立密钥备份，运行现有 migrator，再启动候选。
DDL 为独立 CREATE TABLE IF NOT EXISTS，失败后重跑；不误记成功、不修改旧账本。
Rust 启动只检查新表和 workspace/node 身份，不自动 db:push 或改旧 schema。

新表对 Node 0014 读取/同步兼容；生产共享数据库只允许一个业务写入者，混合版本
节点使用独立库和 v2 同步。Rust 实体 revision 对既有状态使用初始版本 1；之后
所有更新和操作序列、钟、revision、change log 在同一个锁定 head 的事务中提交。
MySQL commit 返回失败时不得假定提交失败，重试复用 operation/delivery ID。

验证：空库全链、0014 升级、至少一个多版本旧起点、重复迁移、部分 DDL 后失败
重跑、既有账户/实体/操作/文件保留。隔离库测试原子提交、错误 revision/clock、
重复 operation ID、快照分页和恢复世代。完整历史归档随版本新增，不覆盖旧归档。
部署恢复回退保留新写入；容器回滚不能撤销 0015。

整库恢复输出独立库和工作区；先安全备份，保留所有历史操作，换新 epoch。
单实体恢复通过新操作回放，不回退整个数据库；手动删除版本只删指定版本。
最终真实 HTTPS/MySQL/两节点及单写入切换完成前不宣称 0015 已验收。

## Observed production 0014 line endings

The isolated production clone retained ledger timestamp 1790469000000 and hash
0d33a43b95cc793c398193ac609bb0db2c88118a27db925c2be820884f6438d1. The deployed Node
0014 file and unchanged Git source hash to
6aa0d710b0e63a5eaac84f106ecff5a764cf8b1e553b9644d38f3e26a7c100b7. Replacing only LF
with CRLF reproduces the recorded historical hash exactly. Both byte sequences and
provenance are preserved in the new immutable line-ending evidence archive; the CRLF
sequence is explicitly a reconstruction, not a captured original execution file.
Rust accepts this exact historical alias only for this exact canonical source and
timestamp. It leaves the ledger unchanged and still rejects all other hash drift.
