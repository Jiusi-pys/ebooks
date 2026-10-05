# 共用 TLS 入口调整候选（待用户范围授权）

现场 TCP 443 是 sing-box Trojan，UDP 443 是 Hysteria2。Trojan 的 HTTP fallback 到 127.0.0.1:8080 不携带客户端 IP。此调整涉及非书库服务，不能仅凭书库修复范围切换生产入口。

## 候选拓扑

TCP 443 → HAProxy 终止现有证书的 TLS → 识别 HTTP/1 请求 → Nginx 的仅回环 PROXY protocol 端口 → Rust；其他已解密 TCP → 仅回环的 sing-box Trojan 无 TLS 入站。UDP 443 Hysteria2 继续由 sing-box 提供。保留原 Trojan 用户配置、路由和原 HTTP fallback；私钥和代理凭据不进入仓库。

先在 TCP 14443/14444 与 Nginx 18081 验证，原 TCP/UDP 443 服务持续运行。临时配置从当前 sing-box 配置提取、权限 0600，不在日志中输出用户或密钥。HAProxy 证书文件在主机内组合现有证书与私钥，权限 0600。

候选 HAProxy TCP 配置（备用端口；发布时替换为 443 / 4443 / 8081）：

```haproxy
frontend shufang_tls_candidate
    mode tcp
    bind :14443 ssl crt /etc/haproxy/shufang.pem
    timeout client 300s
    tcp-request inspect-delay 3s
    tcp-request content accept if HTTP
    use_backend shufang_http_candidate if HTTP
    default_backend shufang_trojan_candidate

backend shufang_http_candidate
    mode tcp
    timeout connect 5s
    timeout server 300s
    server nginx 127.0.0.1:18081 send-proxy

backend shufang_trojan_candidate
    mode tcp
    timeout connect 5s
    timeout server 300s
    server trojan 127.0.0.1:14444
```

Nginx 候选仅回环 server 使用 `listen 127.0.0.1:18081 proxy_protocol`、`set_real_ip_from 127.0.0.1`、`real_ip_header proxy_protocol`；每个 Rust 转发 location 明确覆盖 `proxy_set_header X-Real-IP $remote_addr`。不接收公网 PROXY protocol，也不透传外部 X-Real-IP。

## 发布门槛与回退

1. HAProxy 配置检查、sing-box check、nginx -t 均通过。
2. 备用 TLS 端口：HTTP API 与 OAuth 正常，服务证书有效；从两个不同真实来源 IP 发起请求，观察 Nginx 获取真实来源，伪造 X-Real-IP 不生效。
3. 使用当前真实 Trojan 配置在隔离客户端走备用端口，确认 TCP 和 UDP 转发能力；不得只凭端口连通宣称 Trojan 兼容。
4. 备份三项入口配置，切换时仅改变 TCP 443；验证 Hysteria2 UDP 443、Trojan、书库 HTTPS、两个来源的登录限流互不影响。
5. 任一路失败，停止新 HAProxy TCP 443，恢复原 sing-box 和 Nginx 配置，检查并重启，确认原 HTTPS/Trojan/Hysteria2 路径。

当前仅为候选配置和验收流程，尚未安装 HAProxy、运行候选入口或切换生产 TCP 443；全部网络运行结果待实际验证。
