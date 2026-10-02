#!/bin/bash
set -euo pipefail
TASK_IOS_DIR="$(cd "$(dirname "$0")" && pwd)"
if TASK_PROJECT="$(/usr/bin/python3 "$TASK_IOS_DIR/scripts/prepare-local-project.py")"; then
  open -a Xcode "$TASK_PROJECT"
else
  echo "本地工程入口准备失败，请保留上面的提示交给助手检查。"
  read -r -p "按回车关闭。" _unused
  exit 1
fi
