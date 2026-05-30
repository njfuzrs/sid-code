#!/usr/bin/env bash
# Auto-generated setup script for T0903
# 由 import-trajectory-platform.ts 生成；请勿手改（重新导入会覆盖）
set -euo pipefail

WORKDIR="${1:-/tmp/sid-eval-T0903}"
REPO_URL="https://github.com/example/repo.git"
REPO_COMMIT="abc123"

if [ ! -d "$WORKDIR/.git" ]; then
  git clone "$REPO_URL" "$WORKDIR"
fi
cd "$WORKDIR"
git fetch --all --quiet || true
git checkout "$REPO_COMMIT"
echo "[setup] T0903 ready at $WORKDIR @ $REPO_COMMIT"
