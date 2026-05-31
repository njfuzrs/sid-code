#!/usr/bin/env bash
# Auto-generated setup script for unknown
# 由 import-trajectory-platform.ts 生成；请勿手改（重新导入会覆盖）
set -euo pipefail

WORKDIR="${1:-/tmp/sid-eval-unknown}"
REPO_URL="# TODO: fill repo_url for unknown"
REPO_COMMIT="HEAD"

if [ ! -d "$WORKDIR/.git" ]; then
  git clone "$REPO_URL" "$WORKDIR"
fi
cd "$WORKDIR"
git fetch --all --quiet || true
git checkout "$REPO_COMMIT"
echo "[setup] unknown ready at $WORKDIR @ $REPO_COMMIT"
