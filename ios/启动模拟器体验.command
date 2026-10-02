#!/bin/bash
# Double-click in Finder. Only starts a loopback sample service and simulator.
set -euo pipefail
TASK_IOS_DIR="$(cd "$(dirname "$0")" && pwd)"
TASK_DERIVED_DIR="${TMPDIR:-/tmp}/shufang-ios-preview"
TASK_SERVER_PID=""
finish() {
  if [ -n "$TASK_SERVER_PID" ]; then kill "$TASK_SERVER_PID" 2>/dev/null || true; fi
}
trap finish EXIT
trap 'exit 130' INT TERM
fail() {
  echo "配置未完成：$1"
  read -r -p "按回车关闭窗口。" _unused
  exit 1
}
cd "$TASK_IOS_DIR"
echo "正在准备书房 iPhone 模拟器体验。第一次构建可能需要几分钟。"
xcodebuild -version || fail "请先安装 Xcode，并完成首次启动。"
TASK_PROJECT="$(/usr/bin/python3 scripts/prepare-local-project.py)" || fail "本地工程入口准备失败。"
TASK_DEVICE_ID="$(xcrun simctl list devices available -j | /usr/bin/python3 -c '
import json,sys
items=json.load(sys.stdin)["devices"]
for runtime in sorted(items, key=lambda s: tuple(int(x) if x.isdigit() else 0 for x in s.split("-")[-2:]), reverse=True):
    if ".iOS-" not in runtime: continue
    phones=[d for d in items[runtime] if d.get("isAvailable") and d["name"].startswith("iPhone")]
    if phones:
        preferred=next((d for d in phones if d["name"]=="iPhone 17 Pro"),phones[0])
        print(preferred["udid"]); break
')"
[ -n "$TASK_DEVICE_ID" ] || fail "请在 Xcode → Settings → Components 安装 iOS Simulator。"
# Reuse only our fixture; never silently replace another process on this port.
if ! /usr/bin/python3 -c '
import urllib.request,json
r=urllib.request.Request("http://127.0.0.1:8787/api/v1/books",headers={"X-API-Key":"simulator-only"})
try:
    d=json.load(urllib.request.urlopen(r,timeout=2))
    assert d["books"][0]["extId"]=="demo-book"
except Exception: raise SystemExit(1)
' 2>/dev/null; then
  mkdir -p "$TASK_DERIVED_DIR"
  /usr/bin/python3 scripts/smoke-server.py > "$TASK_DERIVED_DIR/sample-server.log" 2>&1 &
  TASK_SERVER_PID=$!
  sleep 1
  kill -0 "$TASK_SERVER_PID" 2>/dev/null || fail "本地样本服务未启动。端口 8787 可能已被占用。"
fi
xcrun simctl boot "$TASK_DEVICE_ID" 2>/dev/null || true
xcrun simctl bootstatus "$TASK_DEVICE_ID" -b || fail "模拟器启动失败。"
mkdir -p "$TASK_DERIVED_DIR"
xcodebuild -project "$TASK_PROJECT" -scheme Shufang -configuration Debug \
  -destination "id=$TASK_DEVICE_ID" -derivedDataPath "$TASK_DERIVED_DIR" build \
  > "$TASK_DERIVED_DIR/build.log" 2>&1 || fail "构建失败，日志：$TASK_DERIVED_DIR/build.log"
open -a Simulator --args -CurrentDeviceUDID "$TASK_DEVICE_ID"
xcrun simctl install "$TASK_DEVICE_ID" "$TASK_DERIVED_DIR/Build/Products/Debug-iphonesimulator/Shufang.app"
xcrun simctl launch "$TASK_DEVICE_ID" com.shufang.reader || fail "App 启动失败。"
echo ""
echo "书房已经打开。首次连接请填写："
echo "服务器：http://127.0.0.1:8787"
echo "密钥：simulator-only"
echo "这是本机样本，不是你的真实书库。样本数据在服务退出后丢弃。"
echo "体验时保留本窗口；若已有真实服务器连接，请勿为了样本覆盖真实设置。"
read -r -p "体验结束后，按回车关闭本窗口及本次启动的样本服务。" _unused
