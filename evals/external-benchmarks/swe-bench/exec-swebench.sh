#!/usr/bin/env bash
#
# SWE-bench 阶段 A —— 容器编排（§4.4 gold 自检 / §4.5 runner / §4.6 判分）
#
# 事实源：`接入计划.md` §4.4 / §4.5 / §4.6
#
# ## 为什么编排在 shell 而不在 TS 里
#
# 这一层做的全是 `docker cp` / `docker exec` / 起停容器，中间没有一处需要
# 数据结构。放进 TS 只会把每条 docker 命令包一层 `Bun.spawnSync`，
# 而**出错时看到的是被包了一层的输出**，排查要先剥壳。
# 判定逻辑（哪些字段、怎么映射、什么算 ungraded）在 `runner.ts` / `grade.ts`，
# 那部分有单测；shell 这一层刻意只做搬运，不做判断。
#
# ## 用法
#
#   # ① gold 自检（§4.4）：环境错 vs 能力差的唯一分离手段
#   ./exec-swebench.sh gold pytest-dev__pytest-7982
#
#   # ② 跑 agent（§4.5）
#   ./exec-swebench.sh run smoke-1                    # 全部 10 条
#   ./exec-swebench.sh run smoke-1 pytest-dev__pytest-7982   # 单条
#
#   # ③ 判分（§4.6）：丢给官方 harness，不自己判
#   ./exec-swebench.sh grade smoke-1
#
# 环境变量：
#   SC_BASE_URL / SC_API_KEY   模型网关（**只走 exec env，绝不进 argv**）
#   SWE_ARCH                   amd64|arm64，默认按 daemon 实测
#   SWE_MAX_TURNS              默认 40
#   SWE_TIMEOUT                单实例秒数，默认 1800

set -euo pipefail

SWE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SWE_DIR/../../.." && pwd)"
VENV_PY="$SWE_DIR/.venv/bin/python"
SWEBENCH="$SWE_DIR/.venv/bin/swebench"
RUN_NET="${SWE_RUN_NET:-sid-swebench-run}"
PROXY_NAME="${SWE_PROXY:-sid-swebench-proxy}"
MODEL_NAME="sid-code"
MAX_TURNS="${SWE_MAX_TURNS:-40}"
TIMEOUT_SEC="${SWE_TIMEOUT:-1800}"

# ⚠️ 镜像 registry 前缀。**不能留空**：官方镜像名硬编码 `x86_64` 且只发布在
# Docker Hub，而 Docker Hub 在本网络不可达（实测 `registry-1.docker.io`
# 连接超时）。走镜像站时**必须把它当普通 registry 直接引用**，
# 不能配成 daemon 的 `registry-mirrors` —— 后者会让 docker 的 auth 流程报
# `Host doesn't match cfgHost=registry-1.docker.io`，然后**静默挂住不报错**
# （实测挂了 20 分钟、零字节、无任何日志）。
SWE_REGISTRY="${SWE_REGISTRY:-docker.1ms.run}"

ok() { printf '  \033[32m✅\033[0m %s\n' "$1"; }
bad() { printf '  \033[31m❌\033[0m %s\n' "$1" >&2; }
info() { printf '  \033[36m→\033[0m %s\n' "$1"; }

need_docker() {
  docker info >/dev/null 2>&1 || {
    bad "docker daemon 不可达。先跑 setup-env.sh 并 export DOCKER_HOST"
    exit 1
  }
}

detect_arch() {
  if [[ -n "${SWE_ARCH:-}" ]]; then
    echo "$SWE_ARCH"
    return
  fi
  # 官方 per-instance 镜像只有 amd64（实测 manifest 里就一个
  # `"architecture":"amd64"`），所以默认按 amd64 走 —— arm64 上靠 qemu。
  echo "amd64"
}

# 官方镜像名规则（抄 swebench/image_builder/image_spec.py:38-43）：
#   sweb.eval.{x86_64|arm64}.{instance_id}:latest
# 且带 namespace 时 `__` 被改写成 `_1776_`（docker hub 不允许双下划线）。
# ⚠️ 这就是 §4.4 那条「它打印出来的本地 image key 不是你能 pull 的名字」。
image_name() {
  local iid="$1" arch="$2" tag_arch
  tag_arch="x86_64"
  [[ "$arch" == "arm64" ]] && tag_arch="arm64"
  local key="sweb.eval.${tag_arch}.${iid}:latest"
  key="${key//__/_1776_}"
  echo "${SWE_REGISTRY}/swebench/${key}" | tr '[:upper:]' '[:lower:]'
}

artifact_for() {
  local arch="$1" ver suffix
  ver="$(node -e 'console.log(require("'"$REPO_ROOT"'/package.json").version)' 2>/dev/null ||
    grep -m1 '"version"' "$REPO_ROOT/package.json" | sed 's/.*"version": *"\([^"]*\)".*/\1/')"
  suffix="linux-x64"
  [[ "$arch" == "arm64" ]] && suffix="linux-arm64"
  echo "$REPO_ROOT/dist/release/$ver/sid-code-$ver-$suffix.tar.gz"
}

subset_ids() {
  # 只取 `instances:` 段，**不取 candidate_pool** —— 候选池是替补，
  # 捎带进来会让 n 从 10 变 15，而 solved_count 的分母就错了。
  awk '
    /^instances:[[:space:]]*$/ { inb=1; next }
    inb && /^[a-zA-Z_]+:/ { inb=0 }
    inb && /^[[:space:]]*-[[:space:]]+instance_id:/ {
      gsub(/.*instance_id:[[:space:]]*"?/, ""); gsub(/"[[:space:]]*$/, ""); print
    }
  ' "$SWE_DIR/verified-subset.yaml"
}

# ─────────────────────────────────────────────────────────────────────────────
# ① gold 自检（§4.4）
# ─────────────────────────────────────────────────────────────────────────────
#
# **gold 都跑不过就是环境问题，不是 agent 问题** —— 这是把「环境错」与
# 「能力差」分开的唯一手段。所以它必须在跑 agent 之前做，而且失败要停。
cmd_gold() {
  need_docker
  local iid="${1:?需要 instance_id}"
  info "gold 自检: $iid"
  local out
  # ⚠️ `--namespace ''` 在 swebench 5.0.2 里**已被删除**（实测
  # `Error: No such option: --namespace`）。5.0.2 的替代是 `--task-repo`，
  # 但它需要一个逐实例 Dockerfile 的外部仓库，本仓没有 —— 所以这里走
  # 默认行为（拉 registry 镜像），镜像来源由 SWE_REGISTRY 控制。
  set +e
  out="$("$SWEBENCH" eval verified --gold -i "$iid" \
    --run-id "validate-gold-$iid" -j 1 --report-dir "$SWE_DIR/runs/gold" 2>&1)"
  local code=$?
  set -e
  echo "$out" | tail -20
  # ⚠️ **退出码不可信**：实测整个实例报错时 `swebench eval` 仍然 exit 0，
  # 摘要里写的是 `Instances resolved: 0` / `Instances with errors: 1`。
  # 判据必须是摘要里的计数（与 preflight.ts 的 judgeBuildOutcome 同一口径）。
  if echo "$out" | grep -qE "Instances with errors:[[:space:]]*[1-9]"; then
    bad "gold 自检失败：harness 报实例出错（注意此时 exit=$code，退出码不可信）"
    return 1
  fi
  if echo "$out" | grep -qE "Instances resolved:[[:space:]]*0"; then
    bad "gold 自检失败：gold patch 都没解出 → **这是环境问题，不是 agent 问题**"
    return 1
  fi
  ok "gold 自检通过（环境可信，可以开始跑 agent）"
}

# ─────────────────────────────────────────────────────────────────────────────
# ② 跑 agent（§4.5）
# ─────────────────────────────────────────────────────────────────────────────
cmd_run() {
  need_docker
  local run_id="${1:?需要 run_id}"
  shift || true
  local arch
  arch="$(detect_arch)"
  local artifact
  artifact="$(artifact_for "$arch")"
  [[ -f "$artifact" ]] || {
    bad "产物不存在: $artifact（先 make build 或从 dist/release 取）"
    exit 1
  }
  : "${SC_BASE_URL:?必须设 SC_BASE_URL（模型网关）}"
  : "${SC_API_KEY:?必须设 SC_API_KEY —— 只走 exec env，绝不进 argv}"

  local ids
  if [[ $# -gt 0 ]]; then ids="$*"; else ids="$(subset_ids)"; fi

  local out_dir="$SWE_DIR/runs/$run_id"
  mkdir -p "$out_dir"
  : >"$out_dir/predictions.jsonl"
  : >"$out_dir/records.jsonl"

  local proxy_ip=""
  proxy_ip="$(docker inspect -f "{{(index .NetworkSettings.Networks \"$RUN_NET\").IPAddress}}" \
    "$PROXY_NAME" 2>/dev/null || true)"
  [[ -n "$proxy_ip" ]] || {
    bad "取不到 allowlist 代理在 $RUN_NET 上的 IP。先跑 net-setup.sh"
    bad "⚠️ 没有代理 = agent 自由出网 = 它会去读上游修复，**分数不可信**（§5.1：实测 25% rollout 试图 git log 找答案）"
    exit 1
  }
  info "arch=$arch  产物=$(basename "$artifact")  代理=$proxy_ip:8080"

  for iid in $ids; do
    run_one "$iid" "$run_id" "$arch" "$artifact" "$proxy_ip" "$out_dir" || true
  done
  ok "predictions 落盘: ${out_dir#"$REPO_ROOT"/}/predictions.jsonl"
}

run_one() {
  local iid="$1" run_id="$2" arch="$3" artifact="$4" proxy_ip="$5" out_dir="$6"
  local img cname
  img="$(image_name "$iid" "$arch")"
  cname="sid-swe-${run_id}-${iid//__/_}"
  cname="$(echo "$cname" | tr '[:upper:]' '[:lower:]' | cut -c1-60)"

  info "── $iid"
  # 现取题面（§4.2：不落在 yaml 里）。**只取白名单字段，不含任何答案。**
  local meta
  meta="$(HF_HUB_OFFLINE=${HF_HUB_OFFLINE:-1} "$VENV_PY" "$SWE_DIR/fetch-instance.py" "$iid" 2>/dev/null | tail -1)" || {
    bad "$iid: 题面现取失败（instance_id 可能不在 dataset 里 —— 那会静默变成 ungraded）"
    return 1
  }
  local ps_file="$out_dir/$iid.prompt.txt"
  "$VENV_PY" - "$meta" "$SWE_DIR/prompt-v1.txt" "$ps_file" <<'PY'
import json, sys
meta = json.loads(sys.argv[1])
tpl = open(sys.argv[2]).read()
assert "{problem_statement}" in tpl, "prompt-v1.txt 缺 {problem_statement} 占位符"
open(sys.argv[3], "w").write(tpl.replace("{problem_statement}", meta["problem_statement"]))
PY

  docker rm -f "$cname" >/dev/null 2>&1 || true
  local t0 t1
  t0=$(date +%s%3N 2>/dev/null || date +%s000)

  # 起容器：接**隔离 network**，出网只能过 allowlist 代理
  docker run -d --name "$cname" --platform "linux/$arch" \
    --network "$RUN_NET" \
    -e "http_proxy=http://$proxy_ip:8080" \
    -e "https_proxy=http://$proxy_ip:8080" \
    "$img" sleep infinity >/dev/null || {
    bad "$iid: 容器起不来（镜像 $img 拉不到？）"
    return 1
  }

  # docker cp 产物 + 题面
  local tmp_extract
  tmp_extract="$(mktemp -d)"
  tar -xzf "$artifact" -C "$tmp_extract"
  local bin_path
  bin_path="$(find "$tmp_extract" -type f -name 'sid-code*' -perm -u+x | head -1)"
  [[ -n "$bin_path" ]] || {
    bad "$iid: 产物里找不到可执行的 sid-code"
    rm -rf "$tmp_extract"
    docker rm -f "$cname" >/dev/null 2>&1
    return 1
  }
  docker cp "$bin_path" "$cname:/usr/local/bin/sid-code" >/dev/null
  docker exec "$cname" chmod +x /usr/local/bin/sid-code
  docker cp "$ps_file" "$cname:/tmp/prompt.txt" >/dev/null
  rm -rf "$tmp_extract"

  # 跑 agent。API key 走 -e，**不进 argv**（进了 docker inspect 就能读到）
  local agent_out agent_exit=0 timed_out=0
  set +e
  agent_out="$(timeout "$TIMEOUT_SEC" docker exec \
    -e "SC_API_KEY=$SC_API_KEY" -e "SC_BASE_URL=$SC_BASE_URL" \
    "$cname" bash -lc "$(build_agent_script)" 2>&1)"
  agent_exit=$?
  set -e
  [[ $agent_exit == 124 ]] && timed_out=1
  t1=$(date +%s%3N 2>/dev/null || date +%s000)

  # 提取 patch。**与 agent 段分开跑**：agent 非 0 退出时工作树里可能已有部分改动，
  # 合成一段会让 `set -e` 跳过提取，把一个本该有 patch 的结果记成 no_patch。
  local extract_out
  set +e
  extract_out="$(docker exec "$cname" bash -lc "$(build_extract_script)" 2>&1)"
  set -e

  # 落盘由 TS 侧做判定（isTestPath / parseNumstatZ 都有单测）
  printf '%s' "$extract_out" >"$out_dir/$iid.extract.raw"
  bun run "$SWE_DIR/record.ts" \
    --instance "$iid" --run-dir "$out_dir" \
    --agent-exit "$agent_exit" --timed-out "$timed_out" \
    --wall-ms "$((t1 - t0))" || bad "$iid: 记录落盘失败"

  docker rm -f "$cname" >/dev/null 2>&1 || true
}

build_agent_script() {
  cat <<SCRIPT
set -e
source /opt/miniconda3/bin/activate
conda activate testbed
cd /testbed
export SID_CONFIG_DIR=/tmp/sid-cfg
mkdir -p "\$SID_CONFIG_DIR"
python -c 'import json,os; json.dump({"availableModels":[{"name":"m","provider":"openai","api_key":os.environ["SC_API_KEY"],"base_url":os.environ["SC_BASE_URL"]}],"model":"m"}, open(os.environ["SID_CONFIG_DIR"]+"/settings.json","w"))'
/usr/local/bin/sid-code -p --max-turns $MAX_TURNS --permission-mode acceptEdits -- "\$(cat /tmp/prompt.txt)"
SCRIPT
}

build_extract_script() {
  cat <<'SCRIPT'
cd /testbed
git add -A >/dev/null 2>&1 || true
echo '===NUMSTAT==='
git --literal-pathspecs diff --cached --no-renames --numstat -z
echo ''
echo '===DIFF==='
git --literal-pathspecs diff --cached --no-renames
SCRIPT
}

# ─────────────────────────────────────────────────────────────────────────────
# ③ 判分（§4.6：不自己判）
# ─────────────────────────────────────────────────────────────────────────────
cmd_grade() {
  need_docker
  local run_id="${1:?需要 run_id}"
  local out_dir="$SWE_DIR/runs/$run_id"
  local preds="$out_dir/predictions.jsonl"
  [[ -s "$preds" ]] || {
    bad "$preds 不存在或为空 —— 先跑 run"
    exit 1
  }
  info "官方 harness 判分: run_id=$run_id"
  # ⚠️ **同一 run_id 重跑会复用缓存**（§4.6）—— 换了 patch 必须换 run_id，
  # 否则读回的是上一次的结论，那是个假结果而不是重跑。
  set +e
  "$SWEBENCH" eval verified -p "$preds" --run-id "$run_id" -j 1 \
    --report-dir "$out_dir" --timeout "$TIMEOUT_SEC" 2>&1 | tail -30
  set -e
  # 映射成验收字段 —— report 缺失时 grade.ts 会 exit 3 而**不是**报 0 分
  bun run "$SWE_DIR/grade.ts" --run-id "$run_id" --report-only
}

case "${1:-}" in
gold)
  shift
  cmd_gold "$@"
  ;;
run)
  shift
  cmd_run "$@"
  ;;
grade)
  shift
  cmd_grade "$@"
  ;;
*)
  sed -n '1,40p' "${BASH_SOURCE[0]}" | grep -E '^#' | sed 's/^# \{0,1\}//'
  exit 2
  ;;
esac
