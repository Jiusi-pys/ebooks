# 后端剩余发布验收

对应部署提交 `427e988baf18eaff19ba1f030d434a3d4ba6fdd3`。完整源码构建输入为 `90fdf65849bba75a027b65575993247d4f6f4e07`；两提交的整个 base Rust 树逐项 Git diff 无差异，后者仅补部署与人工验收文档。

## 完整源码构建

独立 WSL Linux 构建器执行 `docker build --network host -f deploy/Dockerfile.rust .`，实际完成 Rust WASM、Node 编译既有浏览器、官方原生 Codex 包、Rust 服务和 Debian 非 root 运行镜像。镜像 `sha256:c36cb142997dc8cb4dd4111e22aeb44e1113afe6d3e96197fc0e65b2371c4808`。镜像内原生 Codex 为 0.160.0，服务可启动并返回真实 health。

源构建服务二进制 SHA-256：`84550ded331ec314f446c082db4e20d6a4e2fee3ccbb9c93cc33444f7fdd683f`。

Codex 二进制 SHA-256：`12eb3e81114588aca3b7998f4f19e8997b056aca08e57a7ca7c8a3ec8c652aad`，完整源码镜像与服务器既有运行镜像一致。

生产主机 1GB RAM、初始约 637MB 空闲盘，未尝试在生产主机执行资源不足的完整编译。完整镜像已在独立构建器验证；发布提取其 Rust 服务，复用服务器已验运行基础层和相同 Codex，从而保持原前端文件及避免重复存储大型运行层。不能将此表述为完整镜像在服务器本地从源码编译。

## 预构建监督器

新增显式 `DEPLOY_BUILD_MODE=prebuilt`：只对 Rust 启用，HTTP 仍仅接受完整提交 SHA，核对远端 base HEAD、管理员登记提交、不可变镜像 ID 和镜像 OCI revision。缺失或不匹配时在任何停写前失败。默认 source 构建模式保留。

先写失败测试再实现，Python 15 tests passed。真实 HTTPS 发布接口的缺失 manifest 测试已失败关闭，当前生产容器 ID 保持不变。登记合格源构建二进制镜像后，实际监督器发布结果记录于同目录 JSON。

## 需要用户授权的剩余边界

服务器真实 Codex status：available=true、authenticated=false，未有持久 auth.json。实际 HTTPS tRPC 的 Codex 请求返回 412 / ChatGPT login required；OpenAI 空密钥请求返回 412 / AI API key is not configured。这里只验证正确的前置条件失败，不声称真实模型成功。

用户手动步骤见[人工验收流程](../manual-backend-acceptance.md)。真实 ChatGPT 账号授权、付费 Provider 密钥、实际 MCP 客户端授权及其兼容性需要用户参与；后端假执行器、CLI 可运行和无凭证错误均不能替代真实外部模型成功。长期稳定性观察也不因一次发布成功而算完成。

## 实际生产发布通过

通过真实 HTTPS `/api/deploy` 提交候选，任务 `b1f027b9205e4130a10d697f3bef962a` 返回 succeeded；先一致性备份和完整迁移检查，再停旧写入者、启动新容器、三次健康检查。源码构建服务实际执行哈希与登记一致，容器 restartCount=0。原 owner 会话保持有效，HTTPS 读取至少九本书，原静态文件逐项 SHA 校验一致；第二写入者启动再次被锁拒绝。机器可读结果见 [生产发布结果](rust-release-live.json)。

完整 Docker 源码构建和预构建监督器生产发布这两个先前缺口已补齐；生产主机本地完整源码编译仍未执行且不作为该小型服务器的发布策略。未授权外部模型仍保持明确失败，真实账号流程由用户按手动文档完成。
