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
#   SC_MODEL                   被测模型名（sid-code 侧的 `name`），**必填**。
#                              ⚠️ 这个值必须记进 run meta 才能复算：换了模型的两次 run
#                              分数没有可比性，而模型名不落盘的话事后分不清是哪个模型跑的。
#                              以前写死成 `"name":"m"` —— 那对网关是无效模型名，
#                              网关会用它的默认模型顶上，于是**跑的是哪个模型完全不可知**。
#   SC_MODEL_ID                发往网关的**真实模型 id**（wire model），缺省 = SC_MODEL。
#                              ⚠️ sid-code 的 `name` 是**本地别名**，`modelId` 才进 HTTP 请求体
#                              （见 `packages/core/src/config/config.ts` 的 ModelConfig 注释）。
#                              本机 settings.json 里就有这种拆分：
#                              `name=claude-sonnet-5-ppchat` / `model_id=claude-sonnet-5`。
#                              只传 name 不传 model_id 时别名会被当真名发给网关 → **400/404**，
#                              而那个错在 agent 输出里长得像「模型不可用」，不像配置错。
#   SC_PROVIDER                协议族，默认 openai（anthropic 族传 anthropic）
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

# ⚠️ 镜像 registry 前缀，**默认必须留空**（2026-08-25 从 `docker.1ms.run` 改过来）。
#
# 旧值来自「Docker Hub 不可达、只能走镜像站」那个前提，但它顺带引入了一个更严重的
# 问题：**带 registry 前缀的镜像名 swebench harness 认不出来**。
# harness 用的是 dataset 里那个名字（实测
# `swebench/sweb.eval.x86_64.pytest-dev_1776_pytest-7982:latest`，
# 由 `make_test_spec(d).image` 给出，见 `run_evaluation.py` 的 `wanted` 映射），
# 打成 `docker.1ms.run/swebench/...` 它一个都命中不了，于是回落去 registry 拉 ——
# 而 dockerd 在本网络出网不通，最终报的是**拉取失败**，根因（名字对不上）被埋两层。
#
# 现在镜像由 `pull-image.sh` 在**宿主侧**拉好并 `docker load` 进 daemon，
# 打的就是无前缀的官方名字，所以这里也必须无前缀才能对上。
# 想临时换源只影响 pull-image.sh（它有自己的 SWE_REGISTRY），不影响这里的名字。
SWE_REGISTRY="${SWE_REGISTRY:-}"

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
  # SWE_REGISTRY 为空时**不能拼出前导斜杠**（`/swebench/...` 不是合法镜像名，
  # 而 docker 报的错是 "invalid reference format"，看不出是空变量拼出来的）。
  if [[ -n "$SWE_REGISTRY" ]]; then
    echo "${SWE_REGISTRY}/swebench/${key}" | tr '[:upper:]' '[:lower:]'
  else
    echo "swebench/${key}" | tr '[:upper:]' '[:lower:]'
  fi
}

# ## ⚠️ arm64 宿主 + qemu 时必须用 **baseline** 变体的 x64 产物
#
# 实测踩到（2026-08-25，arm64 mac + colima，官方镜像只有 amd64 所以必走 qemu）：
# 常规 `sid-code-<ver>-linux-x64` 产物在 qemu-x86_64 里**一启动就
# `Illegal instruction (core dumped)`**（进程 exit 132 = 128+SIGILL）。
# 原因是 Bun 默认编译的 x64 产物要求 AVX2 等较新指令，而 qemu-x86_64 不实现它们。
#
# ⚠️ 这个失败形态**会伪装成 agent 能力差**，而且伪装得很好：
#   - harness 记的是 `agent_exit=132` → outcome 落在 `agent_error`；
#   - 更坏的情形是它落在 `patch_produced`：qemu 的 core dump
#     （`core`、`qemu_sid-code_<ts>_<pid>.core`）掉在 `/testbed` 里，
#     被 `git add -A` 收进工作树，于是**「patch」是两个 core 文件的二进制 diff**，
#     `patch_bytes=326` 看着还挺正常。实测第一次就是这样：
#     一次 SIGILL 崩溃被记成「产出了 patch」。
#   - 唯一的裸眼线索是 `wall_ms`（2162ms —— 真跑一题是分钟量级）。
#
# 解法：`bun build --compile --target=bun-linux-x64-baseline`。
# 实测 baseline 产物在同一 qemu 容器里 `--version` 与 `--self-check` 全过
# （含内嵌 ripgrep 可执行）。
#
# 查找顺序（**baseline 优先**，因为跑 evals 的场景就是 qemu）：
#   ① SWE_ARTIFACT 显式指定（tar.gz 或裸二进制都收）
#   ② dist/release/<ver>/sid-code-<ver>-linux-x64-baseline.tar.gz
#   ③ dist/release/<ver>/sid-code-<ver>-linux-x64.tar.gz（原生 x64 机器上就该用这个）
# 找到 ③ 而没有 ② 时**不静默接受** —— cmd_run 会警告「qemu 下大概率 SIGILL」，
# 否则下一个人要把上面这段重新debug一遍。
artifact_for() {
  local arch="$1" ver suffix
  if [[ -n "${SWE_ARTIFACT:-}" ]]; then
    echo "$SWE_ARTIFACT"
    return
  fi
  ver="$(node -e 'console.log(require("'"$REPO_ROOT"'/package.json").version)' 2>/dev/null ||
    grep -m1 '"version"' "$REPO_ROOT/package.json" | sed 's/.*"version": *"\([^"]*\)".*/\1/')"
  suffix="linux-x64"
  [[ "$arch" == "arm64" ]] && suffix="linux-arm64"
  local baseline="$REPO_ROOT/dist/release/$ver/sid-code-$ver-$suffix-baseline.tar.gz"
  [[ -f "$baseline" ]] && {
    echo "$baseline"
    return
  }
  echo "$REPO_ROOT/dist/release/$ver/sid-code-$ver-$suffix.tar.gz"
}

# 宿主是 arm64 但产物是非 baseline 的 x64 → qemu 下必 SIGILL。**先警告，别等它崩**。
warn_if_non_baseline() {
  local artifact="$1" arch="$2"
  [[ "$arch" == "amd64" ]] || return 0
  [[ "$(uname -m)" == "arm64" || "$(uname -m)" == "aarch64" ]] || return 0
  case "$artifact" in
  *baseline*) return 0 ;;
  esac
  bad "⚠️ 宿主是 arm64、产物是**非 baseline** 的 x64 —— qemu 下大概率一启动就 SIGILL(132)，"
  bad "   而它会被记成 agent_error 甚至 patch_produced（core dump 被 git add 收进 patch）。"
  bad "   编一个 baseline 产物：bun build --compile --target=bun-linux-x64-baseline \\"
  bad "     --define process.env.NODE_ENV='\"production\"' --outfile <path>/sid-code \\"
  bad "     packages/cli/src/entrypoints/bootstrap.ts"
  bad "   然后 SWE_ARTIFACT=<path>/sid-code 再跑。"
  return 1
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
# ## 不给 instance_id 时跑 subset 全部
#
# 为什么需要：`gold_ok` 的判据是「submitted 的**每一条**都有 gold 通过记录」
# （见 grade.ts 的 readGoldOk）—— 少跑哪条，那条的环境就没验证过，
# 而 grade 侧会因此把 gold_ok 记成 null（未跑），整轮失去环境背书。
# 手敲 10 次很容易漏一条，而漏了之后**报告只是显示「未跑」，不报错**。
cmd_gold() {
  need_docker
  if [[ $# -eq 0 ]]; then
    local fail=0 n=0 total
    total="$(subset_ids | wc -l | tr -d ' ')"
    while read -r one; do
      n=$((n + 1))
      info "[${n}/${total}] gold 自检: $one"
      gold_one "$one" || fail=1
    done < <(subset_ids)
    if ((fail)); then
      bad "有实例 gold 自检未通过 —— **先查环境，此时任何 solved_count 都不可信**"
      return 1
    fi
    ok "全部 ${total} 条 gold 自检通过（环境可信）"
    return 0
  fi
  local one
  for one in "$@"; do
    gold_one "$one" || return 1
  done
}

gold_one() {
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
    bad "gold 自检失败：harness 报实例出错（注意此时 exit=${code}，退出码不可信）"
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
    bad "产物不存在: ${artifact}（先 make build 或从 dist/release 取）"
    exit 1
  }
  # arm64 + 非 baseline x64 产物 = qemu 下必崩，**且崩得像 agent 能力差**。
  # 所以这里直接停，不让它跑出一份看起来正常的假结果。
  # 想强行跑（比如你在原生 x86_64 机器上，uname 判断被别的层骗了）：SWE_ALLOW_NON_BASELINE=1
  warn_if_non_baseline "$artifact" "$arch" || {
    [[ -n "${SWE_ALLOW_NON_BASELINE:-}" ]] || {
      bad "   确认要强行跑：SWE_ALLOW_NON_BASELINE=1"
      exit 1
    }
    bad "   SWE_ALLOW_NON_BASELINE=1 已设 —— 继续，但这一轮的分数请当作不可信"
  }
  : "${SC_BASE_URL:?必须设 SC_BASE_URL（模型网关）}"
  : "${SC_API_KEY:?必须设 SC_API_KEY —— 只走 exec env，绝不进 argv}"
  # ⚠️ SC_MODEL 必填、**不给默认值**。给了默认值就会出现「以为在测 A 实际在测 B」，
  # 而分数看起来完全正常 —— 这类错误不会报错，只会静默产出不可比的数字。
  : "${SC_MODEL:?必须设 SC_MODEL（被测模型名，会进 API 请求体且记进 run meta）}"

  local ids
  if [[ $# -gt 0 ]]; then ids="$*"; else ids="$(subset_ids)"; fi

  local out_dir="$SWE_DIR/runs/$run_id"
  mkdir -p "$out_dir"
  : >"$out_dir/predictions.jsonl"
  : >"$out_dir/records.jsonl"

  # ## run meta：模型名与网关 host 必须落盘，否则分数不可复算
  #
  # 不是元数据装饰 —— 换了模型或换了网关的两次 run 的 `solved_count` 之间
  # **没有可比性，而分数本身看不出来这件事**。grade.ts 读这个文件，
  # 读不到就在 unaccounted 里点破「不可与其他 run 并排」。
  #
  # ⚠️ **只记 host，不记完整 URL、绝不记 key**。`SC_API_KEY` 从头到尾只走
  # `docker exec -e`，既不进 argv 也不进任何落盘文件。
  local gw_host
  gw_host="$(printf '%s' "$SC_BASE_URL" | sed -E 's#^[a-zA-Z]+://##; s#/.*$##')"
  "$VENV_PY" - "$out_dir/run-meta.json" "$SC_MODEL" "${SC_MODEL_ID:-}" "$gw_host" \
    "${SC_PROVIDER:-openai}" <<'PY'
import json, sys
out, model, model_id, host, provider = sys.argv[1:6]
# model_id 缺省时等于 model —— 记的是**实际发给网关的那个值**，
# 不是「用户填了什么」。事后复算看的是 wire model，别名对不上厂商侧的任何东西。
json.dump(
    {
        "model": model,
        "model_id": model_id or model,
        "gateway_host": host,
        "provider": provider,
    },
    open(out, "w"),
    indent=2,
)
PY

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

# ## 毫秒时钟：不能用 `date +%s%3N`
#
# 实测（macOS 15）：`date +%s%3N` **exit 0**，但输出是 `17876085973N` ——
# GNU 的 `%3N`（纳秒截断到毫秒）在 BSD date 上不被识别，于是那个 `N`
# 被当成字面量留在输出里。后果是 `$((t1 - t0))` 报
# `value too great for base (error token is "17876085893N")`，
# **而写成 `date +%s%3N || date +%s000` 的兜底根本不会触发**（退出码是 0）。
#
# 所以判据不能是「命令失败了没」，只能换一个两边都对的实现。
# `perl` / `python3` 都在，用 perl 更轻（不必启动解释器读 stdlib）。
now_ms() {
  perl -MTime::HiRes=time -e 'printf "%.0f", time()*1000' 2>/dev/null ||
    python3 -c 'import time;print(int(time.time()*1000))'
}

# ## 便携 timeout：macOS 没有 `timeout`
#
# 实测踩到（2026-08-25）：`timeout 1800 docker exec ...` 在 macOS 上
# **599ms 就返回 exit 127**（command not found）—— `timeout` 是 GNU coreutils
# 的命令，macOS 自带的只有 BSD 那套，`gtimeout` 也没装。
#
# 这个失败形态最坑的地方：**127 被记成了 `agent_error`**，
# 报告里写「agent 非 0 退出：127」，看起来像 agent 自己崩了；
# 而 `wall=599ms` 才是唯一的线索（真跑一题是分钟量级）。
# 换句话说，**harness 的一个环境缺失被记成了被测对象的能力问题** ——
# 正是 gold 自检要防的那类错，只是这次发生在 gold 之后。
#
# 优先用系统的 timeout / gtimeout（Linux CI 上有，语义最准），
# 都没有时用 perl 的 alarm 实现：`$?` 的语义与 GNU timeout 对齐 ——
# **超时返 124**，因为 `timed_out` 的判据就是 `== 124`。
run_with_timeout() {
  local secs="$1"
  shift
  if command -v timeout >/dev/null 2>&1; then
    timeout "$secs" "$@"
  elif command -v gtimeout >/dev/null 2>&1; then
    gtimeout "$secs" "$@"
  else
    perl -e '
      my $secs = shift @ARGV;
      my $pid = fork();
      die "fork failed: $!" unless defined $pid;
      if ($pid == 0) { exec @ARGV or exit 127; }
      # 超时就杀掉子进程并按 GNU timeout 的约定返回 124
      local $SIG{ALRM} = sub { kill "TERM", $pid; sleep 2; kill "KILL", $pid; exit 124 };
      alarm $secs;
      waitpid($pid, 0);
      alarm 0;
      my $st = $?;
      exit($st & 127 ? 128 + ($st & 127) : $st >> 8);
    ' "$secs" "$@"
  fi
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
  t0=$(now_ms)

  # 起容器：接**隔离 network**，出网只能过 allowlist 代理
  docker run -d --name "$cname" --platform "linux/$arch" \
    --network "$RUN_NET" \
    -e "http_proxy=http://$proxy_ip:8080" \
    -e "https_proxy=http://$proxy_ip:8080" \
    "$img" sleep infinity >/dev/null || {
    bad "$iid: 容器起不来（镜像 $img 拉不到？）"
    return 1
  }

  # docker cp 产物 + 题面。
  # 产物既可能是 release 的 tar.gz，也可能是 SWE_ARTIFACT 指的**裸二进制**
  # （手编 baseline 变体时最省事的形态，不必先打包再解开）。
  local tmp_extract bin_path
  tmp_extract="$(mktemp -d)"
  case "$artifact" in
  *.tar.gz | *.tgz)
    tar -xzf "$artifact" -C "$tmp_extract"
    bin_path="$(find "$tmp_extract" -type f -name 'sid-code*' -perm -u+x | head -1)"
    ;;
  *)
    # 裸二进制：可执行位可能没设（比如刚从别处 cp 过来），这里不挑剔，
    # 反正进容器后还会 chmod +x 一次。
    bin_path="$artifact"
    ;;
  esac
  [[ -n "$bin_path" && -f "$bin_path" ]] || {
    bad "$iid: 产物里找不到可执行的 sid-code（artifact=${artifact}）"
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
  agent_out="$(run_with_timeout "$TIMEOUT_SEC" docker exec \
    -e "SC_API_KEY=$SC_API_KEY" -e "SC_BASE_URL=$SC_BASE_URL" \
    -e "SC_MODEL=$SC_MODEL" -e "SC_MODEL_ID=${SC_MODEL_ID:-}" \
    -e "SC_PROVIDER=${SC_PROVIDER:-openai}" \
    "$cname" bash -lc "$(build_agent_script)" 2>&1)"
  agent_exit=$?
  set -e
  [[ $agent_exit == 124 ]] && timed_out=1
  t1=$(now_ms)

  # ## agent 输出必须落盘 —— 非 0 退出时它是**唯一**的线索
  #
  # 实测踩到（2026-08-25，10 题跑分时）：`django__django-13964` 记成
  # `agent_error / exit=1 / wall=66s / patch=0B`，而 `agent_out` 捕获了却从没写出去，
  # 于是**「67 秒就退了」这个事实之外什么都没有** ——
  # 分不清是模型放弃了、网关拒了、还是容器里少个依赖。
  #
  # 这直接违背 §附录 ZZ.5 第 4 条那条判据（「先问它是不是环境故障」）：
  # 那条判据要能执行，前提是**看得到 agent 说了什么**。
  # 一个记成 agent_error 但查不出原因的实例，等于一条不可归因的数据。
  #
  # ⚠️ **不做任何过滤/截断**：截断就会砍掉尾部的报错，而报错通常在尾部。
  # key 不会出现在这里（只走 `docker exec -e`，agent 也不回显它），
  # 但落盘路径仍在 `runs/<id>/` 内，与其他中间产物同级、不额外扩大暴露面。
  printf '%s' "$agent_out" >"$out_dir/$iid.agent.log"

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
python -c 'import json,os; m=os.environ["SC_MODEL"]; json.dump({"availableModels":[{"name":m,"model_id":os.environ.get("SC_MODEL_ID") or m,"provider":os.environ.get("SC_PROVIDER","openai"),"api_key":os.environ["SC_API_KEY"],"base_url":os.environ["SC_BASE_URL"]}],"model":m}, open(os.environ["SID_CONFIG_DIR"]+"/settings.json","w"))'
/usr/local/bin/sid-code -p --max-turns $MAX_TURNS --permission-mode acceptEdits -- "\$(cat /tmp/prompt.txt)"
SCRIPT
}

build_extract_script() {
  cat <<'SCRIPT'
cd /testbed
# ## ⚠️ 先清掉进程崩溃残留物，再 git add
#
# 实测踩到（2026-08-25）：sid-code 在 qemu 下 SIGILL 崩溃，qemu 把 core dump
# 写在 cwd（`/testbed`）里 —— `core` 和 `qemu_sid-code_<ts>_<pid>.core`。
# `git add -A` 把它们收了进去，于是产出的「patch」是：
#
#   diff --git a/core b/core
#   new file mode 100644
#   Binary files /dev/null and b/core differ
#   diff --git a/qemu_sid-code_20260824-215830_15.core b/...core
#   Binary files /dev/null and b/...core differ
#
# `patch_bytes=326`、outcome=`patch_produced` —— **一次崩溃被记成「产出了 patch」**。
# 判分时它当然解不出题，于是最终落在 `wrong_patch`：
# **一个 harness 侧的崩溃被记成了模型改错了。**
#
# 所以清理不是「顺手做的整洁」，是**防止环境故障伪装成能力差**。
# 只删已知的崩溃残留模式，不做通配清理 —— 真删掉了 agent 的产出就成了反向错误。
rm -f core core.[0-9]* qemu_*.core vgcore.* 2>/dev/null || true
git add -A >/dev/null 2>&1 || true
echo '===NUMSTAT==='
# ## ⚠️ NUL 必须在容器内就转成 RS(\x1e)，否则记录分隔符会被 shell 吃掉
#
# 实测踩到（2026-08-25，复核 smoke-2 数据时）：外层拿输出用的是
# `extract_out="$(docker exec ...)"`，而**bash 命令替换会丢弃 NUL 字节**
# （POSIX 行为；bash 会打 warning，但被 2>&1 一起吞了）。
# 于是 `--numstat -z` 的多条记录在落盘时**首尾相接、没有任何分隔符**：
#
#   5<TAB>0<TAB>src/foo.py3<TAB>1<TAB>tests/test_foo.py2<TAB>0<TAB>src/bar.py
#
# 后果不是「少报几个文件名」而是**一道防作弊门禁被静默架空**：
# 按 NUL 切只得到 1 条记录，path 是把后面全部记录粘成的怪串，
# `isTestPath` 对它匹配不上 → **`patch_touches_tests` 恒为 false**。
# 实测同一份输入：NUL 完好判 true，NUL 丢失判 false。
# 全程 exit 0、字段自洽、报告挑不出毛病 —— 又一例「绿了但没测到」。
#
# ⛔ 不要改成不带 `-z` 来绕：那会把含空格/中文的路径 quote 成 "a\tb"，
# 按 TAB 切就切错了 —— `-z` 本来就是为此而用的。
# RS(\x1e) 能活过命令替换，且它不可能出现在 git 的路径里。
# （TS 侧 `parseNumstatZ` 两种分隔符都收，所以这一改不破旧数据。）
git --literal-pathspecs diff --cached --no-renames --numstat -z | tr '\0' '\036'
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
