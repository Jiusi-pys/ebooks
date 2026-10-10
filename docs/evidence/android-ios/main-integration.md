# Android 合入 main

用户已授权提交、推送和合并。Android 实现提交 `d38fdec`；整合的远端 main 为 `cc59ea3`，包含 Windows 与 iOS 1.4.2。合并保留 main 的 Windows、iOS 工具及原始验收记录；iOS 冲突采用已通过跨端验收的 PortableInk/ZIP 兼容实现，不删除任一平台。

合并工作树重新运行：Web check/lint/test/build 全通过，628 通过、53 条件跳过；Rust workspace 201 通过、20 平台/环境跳过，Clippy `-D warnings` 通过；Android 23 单元测试、Lint、APK 构建通过；部署监督器 15 通过。汉王两种尺寸的 88 次实际测试及限制见 [模拟验收](hanvon-mumu-acceptance.md)。数据库迁移链未新增或改写；iOS 兼容源码采用已验收版本，本轮没有新的 Apple 环境运行声明。

main 之前的 Linux CI 在 `credentials.rs` 失败，原因是没有 `SHUFANG_CREDENTIAL_KEY`。流水线为 Rust 测试进程生成临时 256 位密钥，既不写入源码，也不传给生产部署进程。保留加密与篡改检查，不跳过测试。线上流水线与部署状态以对应合并提交的 GitHub Actions 结果为准，本地通过不代替线上结果。

提交范围为源码、构建/部署脚本、兼容历史和验收证据。APK、生成的原生库、模型、构建缓存及本机凭据保持在忽略目录；两个原有 MCP 诊断截图未纳入。APK 下载文件仍在本机既有交付路径，不将其误称为 Git 源码中的制品。
