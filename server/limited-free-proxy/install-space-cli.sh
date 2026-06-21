#!/usr/bin/env bash
set -euo pipefail

TARGET_DIR="${1:-$HOME/.local/bin}"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

mkdir -p "$TARGET_DIR"

echo "安装目录: $TARGET_DIR"
echo "构建中..."

(
  cd "$SCRIPT_DIR"
  GOBIN="$TARGET_DIR" go install ./cmd/space-cli
)

BIN_PATH="$TARGET_DIR/space-cli"
if [[ ! -x "$BIN_PATH" ]]; then
  echo "安装失败: 未找到 $BIN_PATH" >&2
  exit 1
fi

echo "安装成功: $BIN_PATH"
echo
echo "如果当前 shell 还找不到命令，请先加入 PATH:"
echo "  export PATH=\"$TARGET_DIR:\$PATH\""
echo
echo "快速验证:"
echo "  space-cli models --device-fingerprint codex-local-smoke"
