#!/usr/bin/env bash
# L2 发版闸入口（方案 P3 / T20）。逻辑全在 release-gate.ts，这里只做一件事：
# 整次运行套 `caffeinate -dimsu`，防宿主睡眠污染耗时与超时判定。
#
#   scripts/eval/release-gate.sh <version> [--ruler <traj-bench checkout>] [--dry-run] [--force]
#
# caffeinate 只是预防；事后真正的判据是 `pmset -g log` 里运行区间内有没有 Sleep（TS 侧）。
# 没有 caffeinate（非 macOS）就不包，TS 侧会把「未经 caffeinate 包住」判成 INVALID ——
# 不在这里直接退出，是为了让这次失败也落成一份裁决文件，而不是只有一行 stderr。
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TS="${SCRIPT_DIR}/release-gate.ts"

if command -v caffeinate >/dev/null 2>&1; then
    exec caffeinate -dimsu env SID_L2_CAFFEINATED=1 bun run "$TS" "$@"
fi
echo "⚠️ 找不到 caffeinate，本次运行会被判 INVALID" >&2
exec bun run "$TS" "$@"
