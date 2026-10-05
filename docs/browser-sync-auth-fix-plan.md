# 浏览器同步 401 修复方案

既有网页 workspaceSync 使用同源登录 Cookie 访问 /api/v2，Node 适配器允许正常书库会话并对写入检查同源。Rust 迁移只保留机器/节点令牌，遗漏浏览器路径。

仅修改 Rust 后端：没有提供任何机器鉴权头时，复用已有 library 鉴权中间件，校验当前账号、credentialVersion、会话有效期及写入同源；显式提供错误机器凭证时禁止回落 Cookie。机器 owner / 节点 workspace scope / peer 管理权限保持现有边界。前端不变，无 schema 变更或迁移。

先测试再实现：有效浏览器 capabilities/changes/entities/snapshot 可用；匿名、旧 bootstrap、撤销 cookie、错误密钥+有效 cookie、跨站写入拒绝；机器节点回归。通过 Windows/Linux 回归及 Clippy 后构建 Linux 二进制，验证当前生产 MySQL 读接口，使用既有一致性备份/完整迁移/单写入者监督器发布。保留 Codex 登录缓存和静态文件。
