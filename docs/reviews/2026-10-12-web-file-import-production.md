# Web 导入修复生产发布

2026-10-12，经用户明确授权，已更新 `https://us.jiusi.org/` 前端。
发布源码提交：`5d8d65fc8f65364f0643b5c226c3af55f0728aba`。
候选测试见 [发布前验证](2026-10-12-web-file-import-release.md)，线上结果见
[机器可读证据](../evidence/web-file-import-20261012.json)。

## 发布结果

- 在独立工作树构建；未包含主工作区未提交的 EPUB 插图排版改动。
- 实际发布目录：`/var/www/shufang-public-20261005`。先添加新哈希资源，再原子
  替换 `index.html`；旧版所有资源仍在，已打开的旧页面可继续取得旧资源。
- 公网验证全部 8 个文件 SHA-256 与候选相同。主脚本
  `assets/index-uItsmvjZ.js` 的 SHA-256 为
  `cb08a2ac23b3a18db0e27158a887d0a28f6acbbbf3e6d6f51711891576a232d1`，
  已确认包含 native Blob 品牌检测，旧版 Blob-only 检测已移除。
- 浏览器实际打开生产登录页成功。没有在真实书库添加测试书；真实 File 导入
  已在隔离浏览器完成，不能将该验证表述为生产账号端到端导入成功。
- Rust 服务容器 ID、镜像、启动时间均保持一致，健康检查
  `{"ok":true,"readOnly":false}`。数据库和已有原文件未更改；无 schema 迁移。
- 发布前服务器约 218 MB 可用，本地构建，上传压缩包 1,954,065 字节。

## 备份与回退

服务器保存目录：`/opt/shufang/frontend-file-import-20261012`。
包含候选包、逐文件 manifest、旧静态文件完整备份、旧入口、部署脚本及结果。
旧静态文件备份 `previous-public.tar.gz` 的 SHA-256：
`1226bc05f6c3211e44abf3982f3e1c655425d1bba862ea5c8a9368f2b00f30f3`。
独立本机副本位于主工作区 `.tools/epub-release-20261012/`，下载后哈希一致。

部署脚本在切换后的验证失败时自动恢复旧入口。本次所有验证成功，无需回退。
后续如需人工回退，先确认没有更新的前端发布，再原子恢复备份入口：

```sh
python3 - <<'PY'
import hashlib, os
from pathlib import Path
root = Path('/var/www/shufang-public-20261005')
old = Path('/opt/shufang/frontend-file-import-20261012/previous-index.html')
assert hashlib.sha256((root/'index.html').read_bytes()).hexdigest() == 'b7898af6cc0e21775fe00d5deafe3237247d2c60ccba7fe3f5791be5aed6910b'
assert hashlib.sha256(old.read_bytes()).hexdigest() == '7e57894968e947b332ff3d5f9e8b8b29c869ed5333511e526e3e5a7b7e443fbb'
temporary = root/'index.rollback.html'
temporary.write_bytes(old.read_bytes())
temporary.chmod(0o644)
os.replace(temporary, root/'index.html')
PY
```

该回退只恢复前端入口，不涉及数据库回滚。新旧静态资源均保留。
用户已打开的页面需刷新以加载此次修复。
