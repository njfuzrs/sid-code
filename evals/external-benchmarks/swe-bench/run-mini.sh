#!/usr/bin/env bash
#
# 路 B 对照侧驱动 —— 用 mini-SWE-agent 跑我们那 10 条 subset
#
# 事实源：`docs-research/.../01-coding-agent评测集全景与sid-code接入方案.md`
#   A7.12.4（路 B 定义）/ A7.14.4（一题实测的完整命令）/ A7.14.8（预算裁决）
#
# ## 这个脚本存在的唯一理由：把「必控变量」从纪律变成代码
#
# 路 B 的产出是「同模型下 sid-code vs 标准 scaffold 的差值」。差值有意义的前提是
# **除 harness 外全部必控变量对齐**。手敲那条命令有 4 个地方一错就整轮白跑，
# 而且**全部不报错**：
#
#   1. 漏掉 `-c swebench.yaml` → 默认 config 整份失效（含 instance_template）。
#      上游自己在 --help 里用红字警告这条。形态：agent 拿到一个空模板照样跑。
#   2. 不覆盖 `step_limit` → 用 mini 默认 250，而我们侧是 80。
#      **比的是"谁预算多"**，而 A7.11.4 已证明 agent 会把预算用完。
#   3. 不覆盖 `cost_limit` → 用 mini 默认 3.0，它会**硬停**。
#      被停掉的题看起来像"没解出来"。
#   4. 漏 `HF_*_OFFLINE` → 本网络下 HF 不可达，跑不起来（这条会报错，属于良性）。
#
# 所以这四条写死在脚本里，不做成可调旋钮 —— 做成旋钮就会有人在跑不出想要的
# 结果时去调它，而调完之后两边不可比，报告上看不出来。
#
# ## ⚠️ 不要与 harbor / 自建 SWE-bench 链路并行跑
#
# 三条链路共用同一个 colima daemon（本机只有一个 profile `swebench`），
# 且镜像全是 amd64、在 aarch64 VM 上走 qemu 全模拟。并行的后果不是"慢一点"：
#   - CPU 争抢会把 qemu 下的超时推过线，形态是 `VerifierTimeoutError`，
#     **长得像链路坏了**（harbor README 已记同型教训）；
#   - 耗时口径被污染，而路 B 的产出本身就是耗时/轮数的差值 ——
#     **没有任何字段能记录"当时另一边在编 cython 扩展"**。
#
# ## ⚠️ 跑之前先 caffeinate
#
# A7.15：宿主休眠会同时污染 `agent_ms` 并静默给超时闸门续命。实测 717 秒休眠
# 让一题跑到墙钟 2× 上限还不被杀。mini 侧我们**没有** host_slept_ms 检测，
# 所以只能靠 caffeinate 预防（脚本会自己包一层，见下）。
#
# ## 用法
#
#   evals/external-benchmarks/swe-bench/run-mini.sh                 # 跑全部 10 条
#   evals/external-benchmarks/swe-bench/run-mini.sh --dry-run       # 只打印命令
#   MINI_FILTER='astropy__astropy-12907' ...run-mini.sh             # 单题
#
# 环境变量：
#   MINI_REPO      mini-swe-agent 仓库路径（默认 ../github/mini-swe-agent）
#   MINI_OUT       输出目录（默认 /tmp/mini-routeb-<时间戳>）
#   MINI_MODEL     模型（默认 anthropic/claude-sonnet-5，**必控变量**）
#   MINI_BASE_URL  网关（默认从 sid-code settings.json 读，与我方同源）
#   MINI_WORKERS   并发（默认 1；>1 会污染耗时口径，脚本会点破）
#   MINI_FILTER    instance_id 正则（默认由 subset 生成）

set -euo pipefail

# ⚠️ 一律用 ${VAR} 形式：`set -u` 下裸 $VAR 拼接中文/全角字符时曾踩过
# unbound variable（release.sh 那次，见 CLAUDE.md 引用的教训）。
SWE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SWE_DIR}/../../.." && pwd)"

# A7.14.8 的裁决值。改这里必须同步改 mini-adapt.ts 的 EXPECTED_STEP_LIMIT，
# 那边有断言核对，不同步会在转换时报"必控变量不对齐"。
STEP_LIMIT=80
COST_LIMIT=0

MINI_REPO="${MINI_REPO:-${REPO_ROOT}/../github/mini-swe-agent}"
MINI_MODEL="${MINI_MODEL:-anthropic/claude-sonnet-5}"
MINI_WORKERS="${MINI_WORKERS:-1}"
DRY_RUN=0
for a in "$@"; do
  case "${a}" in
    --dry-run) DRY_RUN=1 ;;
    *) echo "未知参数：${a}" >&2; exit 2 ;;
  esac
done

info() { printf '\033[36m%s\033[0m\n' "$*"; }
ok()   { printf '\033[32m%s\033[0m\n' "$*"; }
bad()  { printf '\033[31m%s\033[0m\n' "$*" >&2; }

# ── 前置检查：每一条失败都比"跑到一半才发现"便宜得多 ──

if [[ ! -d "${MINI_REPO}" ]]; then
  bad "❌ 找不到 mini-swe-agent：${MINI_REPO}"
  bad "   设 MINI_REPO 指向它，或 git clone 到那个位置"
  exit 2
fi

MINI_PY="${MINI_REPO}/.venv/bin/python"
if [[ ! -x "${MINI_PY}" ]]; then
  bad "❌ mini 的 venv 不存在：${MINI_PY}"
  bad "   建它（A7.14.4 实测通过的命令）："
  bad "     cd ${MINI_REPO}"
  bad "     uv venv --python 3.12 .venv && uv pip install --python .venv/bin/python -e ."
  exit 2
fi

# ⚠️ `-c swebench.yaml` 里那个文件名是 mini 的**内置 config 目录**下的相对名，
# 不是我们仓库里的路径。先确认它真的在，否则 get_config_path 会抛。
#
# ⚠️⚠️ 每一处从 mini 取值的地方都必须 **只取最后一行**（实测踩到，2026-08-28）：
# mini 在 import 时打一段启动横幅（版本号 + v2 迁移指南链接 + "Loading global
# config from ..."，共 4 行），而它走的是 **stdout 而不是 stderr**（rich console
# 默认写 stdout）。所以：
#   - `2>/dev/null` **治不了**它 —— 本脚本第一版就是这么写的，然后报
#     「❌ mini 内置 config 不在：This is mini-swe-agent version 2.4.6...」，
#     形态是**文件明明在，脚本说找不到**，而报错里那段横幅把人引向别的方向。
#   - 用 `tail -1` 取最后一行才对，且 print 的内容必须**保证是单行**。
# 归因教训：`$( )` 不捕获 stderr 是对的，但前提是那段输出真的走 stderr ——
# 这条假设没核就写进注释，是「回源码核对却核错了源」的同型。
DEFAULT_CFG="$(
  "${MINI_PY}" - <<'PY' | tail -1
from minisweagent.config import builtin_config_dir
print(builtin_config_dir / "benchmarks" / "swebench.yaml")
PY
)"
if [[ ! -f "${DEFAULT_CFG}" ]]; then
  bad "❌ mini 内置 config 不在：${DEFAULT_CFG}"
  exit 2
fi
ok "✓ mini 内置 config：${DEFAULT_CFG}"

# ── 网关与 key：必须与 sid-code 侧**同一个网关**，否则差值里掺网关差异 ──
#
# ⚠️ 不打印 key 本身，只打印长度与来源（CLAUDE.md：不回显密钥值）。
#
# ## ⚠️ 为什么要按 gateway_host 挑，不能只按 model_id 挑（实测踩到，2026-08-28）
#
# `~/.sid-code/settings.json` 里 **有两个条目的 model_id 都是 claude-sonnet-5**：
#   claude-sonnet-5-gateway → uniapi.ruijie.com.cn
#   claude-sonnet-5-ppchat  → code.ppchat.vip     ← smoke-10 用的是这个
# 只按 model_id 挑会拿到**先出现的那个**（uniapi），于是"同模型"成立而
# "同网关"不成立。两个网关的限流、缓存策略、计价口径都不同，
# 而这些**全部落在 harness 差值里**，无法事后分离。
#
# 所以优先按 `SMOKE_GATEWAY`（从 smoke-10 的 run-meta 读）精确匹配；
# 匹配不到才退化到 model_id，**并明确报出退化这件事**。
SMOKE_META="${SWE_DIR}/runs/smoke-10/run-meta.json"
SMOKE_GATEWAY=""
SMOKE_MODEL_ID=""
if [[ -f "${SMOKE_META}" ]]; then
  # 用系统 python3（不 import mini → 无 stdout 横幅污染，见上方长注释）
  SMOKE_GATEWAY="$(python3 -c "import json,sys;print(json.load(open(sys.argv[1])).get('gateway_host',''))" "${SMOKE_META}")"
  SMOKE_MODEL_ID="$(python3 -c "import json,sys;print(json.load(open(sys.argv[1])).get('model_id',''))" "${SMOKE_META}")"
fi

read -r GW_HOST GW_URL KEY_LEN MATCH_MODE <<<"$(
  python3 - "${MINI_MODEL}" "${SMOKE_GATEWAY}" <<'PY'
import json, os, sys
from urllib.parse import urlparse
p = os.path.expanduser("~/.sid-code/settings.json")
d = json.load(open(p))
want = sys.argv[1].split("/")[-1]
prefer_host = sys.argv[2] if len(sys.argv) > 2 else ""

# 只认 provider=anthropic 且 model_id/name 对得上的条目。
# 找不到就什么都不打印，让 shell 侧报错 —— **不退化到"随便挑一个"**：
# 挑错网关的形态是 404 后静默 fallback（A2 那条）。
cands = []
for m in d.get("availableModels", []):
    if m.get("provider") != "anthropic":
        continue
    if m.get("model_id") != want and m.get("name") != want:
        continue
    url = m.get("base_url") or m.get("baseURL") or ""
    cands.append((urlparse(url).netloc, url, len(m.get("api_key") or "")))

# 优先取与 smoke-10 同网关的那个。这一步是"同网关"这条必控变量的落点。
exact = [c for c in cands if prefer_host and c[0] == prefer_host]
if exact:
    host, url, klen = exact[0]
    print(host, url, klen, "exact")
elif cands:
    host, url, klen = cands[0]
    # `fallback` 会让 shell 侧打出一条显式警告 —— 退化本身不禁止，
    # 但**不许静默**：静默退化就是一轮不可比的数据长得可比。
    print(host, url, klen, "fallback")
PY
)" || true

if [[ -z "${GW_URL:-}" || "${KEY_LEN:-0}" == "0" ]]; then
  bad "❌ 在 ~/.sid-code/settings.json 里找不到 provider=anthropic 且匹配 ${MINI_MODEL} 的条目"
  bad "   路 B 要求两边**同一个网关同一个模型**，所以这里不退化到别的条目"
  exit 2
fi
ok "✓ 网关：${GW_HOST}（key 长度 ${KEY_LEN}，值不打印）"

# ── 与 smoke-10 对账：这一段是路 B 能不能成立的门禁，不是提示 ──
#
# 三条必控变量按严重度分级处置：
#   模型不同   → **exit 2**（第一必控变量，跑了也白跑）
#   网关不同源 → 报警但放行（可能是刻意的，但必须在报告里写明）
#   挑中方式是 fallback → 报警（说明 settings 里没有与 smoke-10 同网关的同名模型）
if [[ "${MATCH_MODE:-}" == "fallback" ]]; then
  bad "⚠️ 网关是**退化挑中**的：settings.json 里没有 host=${SMOKE_GATEWAY:-?} 且匹配"
  bad "   ${MINI_MODEL} 的条目，于是取了第一个同模型条目（${GW_HOST}）"
fi
if [[ -n "${SMOKE_GATEWAY}" ]]; then
  if [[ "${SMOKE_GATEWAY}" != "${GW_HOST}" ]]; then
    bad "🔴 网关与 smoke-10 不同源：mini 用 ${GW_HOST}，smoke-10 用 ${SMOKE_GATEWAY}"
    bad "   差值里会掺进网关差异（限流/缓存/计价口径都不同），**且事后无法分离**。"
    bad "   要么让 settings.json 里有一个 host=${SMOKE_GATEWAY} 的同名模型条目，"
    bad "   要么接受并在报告里写明 —— 但**不要默认它无害**"
  else
    ok "✓ 网关与 smoke-10 同源：${GW_HOST}"
  fi
fi
if [[ -n "${SMOKE_MODEL_ID}" && "${MINI_MODEL##*/}" != "${SMOKE_MODEL_ID}" ]]; then
  bad "🔴 模型与 smoke-10 不同：mini=${MINI_MODEL##*/}，smoke-10=${SMOKE_MODEL_ID}"
  bad "   模型是路 B 的**第一必控变量**，不一致则整轮作废"
  exit 2
fi

# ── subset：跑的必须是同样那 10 条 ──
#
# ⚠️ 从 verified-subset.yaml 现取，**不硬编码一份 id 列表**。
# 硬编码的形态是 subset 重新生成后两边跑的题目悄悄不同了，而两份报告都正常。
if [[ -z "${MINI_FILTER:-}" ]]; then
  MINI_FILTER="$(
    python3 - "${SWE_DIR}/verified-subset.yaml" <<'PY'
import re, sys
txt = open(sys.argv[1], encoding="utf-8").read()
# 只读 `instances:` 段，**不读 candidate_pool**（候选池是替补，捎带进来会让 n 从 10 变 15）。
# 与 runner.ts parseSubset 同一口径：顶格 key 终止 instances 段。
ids, in_inst = [], False
for raw in txt.split("\n"):
    line = re.sub(r"\s+#.*$", "", raw)
    if re.match(r"^instances:\s*$", line):
        in_inst = True
        continue
    if in_inst and re.match(r"^[a-zA-Z_]+:", line):
        break
    if not in_inst:
        continue
    # ⚠️ 值是**带双引号**的（`instance_id: "astropy__astropy-12907"`）。
    # 第一版字符类写成 `[A-Za-z0-9_.\-]+` 漏了引号 → **零命中**，
    # 而 `if not ids` 那条兜底把它报成"形状变了"，把人引向 subset 而不是这行正则。
    # 与记忆里「密钥正则的前缀盲区」同型：字符类漏一个字符即全漏，且不报错。
    m = re.search(r"""instance_id:\s*["']?([A-Za-z0-9_.\-]+)["']?""", line)
    if m:
        ids.append(m.group(1))
if not ids:
    raise SystemExit("subset 里一条 instance_id 都没解析出来 —— 形状变了")
# 反向自证：零命中已被上面拦住，但**命中数不对**同样危险（比如只匹配到一半）。
# subset 当前是 10 条；数量异常时宁可报错也不要静默跑一个更小的分母
# —— 分母悄悄变小 = 分数虚高，这条在 harbor 那边也踩过（A1 的排除计数）。
if len(ids) != len(set(ids)):
    raise SystemExit(f"subset 里有重复 instance_id：{len(ids)} 条含 {len(set(ids))} 个唯一值")
# mini 的 --filter 是 re.match（前缀匹配），所以用 ^(a|b|c)$ 精确锚定。
print("^(" + "|".join(re.escape(i) for i in ids) + ")$")
PY
  )"
fi
N_INST="$(( $(grep -o '|' <<<"${MINI_FILTER}" | wc -l | tr -d ' ') + 1 ))"
ok "✓ subset：${N_INST} 条（filter 由 verified-subset.yaml 现取）"

if [[ "${MINI_WORKERS}" -gt 1 ]]; then
  bad "⚠️ MINI_WORKERS=${MINI_WORKERS} —— 并发会污染耗时口径，且上游会返 429。"
  bad "   分数仍可比，但**耗时/轮数不可与串行的 sid-code 侧并排**"
fi

MINI_OUT="${MINI_OUT:-/tmp/mini-routeb-$(date +%Y%m%d-%H%M%S)}"

# ── 组装命令 ──
#
# 逐个 flag 的理由（不要凭"看起来没用"删掉任何一条）：
#   -c "${DEFAULT_CFG}"      必须显式给！否则默认 config 整份失效（陷阱 1）
#   -c agent.step_limit=80   A7.14.8 裁决，与我方 SWE_MAX_TURNS 数值直接相等
#   -c agent.cost_limit=0    0 = 不限（源码 `0 < cost_limit` 才判停），压掉默认 3.0
#   HF_*_OFFLINE=1           本网络 HF 不可达（A7.14.4 实测）
#   MSWEA_CONFIGURED=true    跳过 mini 的首次配置向导（非交互必须）
#   LITELLM_LOCAL_MODEL_COST_MAP=True  免掉每次启动等一次远端 cost map 超时
#                            （A7.14.3 ①：本地备份 3212 条已含 claude-sonnet-5）
CMD=(
  "${MINI_PY}" -m minisweagent.run.benchmarks.swebench
  --subset SWE-bench/SWE-bench_Verified --split test
  --filter "${MINI_FILTER}"
  -m "${MINI_MODEL}"
  -o "${MINI_OUT}"
  -w "${MINI_WORKERS}"
  --redo-existing
  -c "${DEFAULT_CFG}"
  -c "agent.step_limit=${STEP_LIMIT}"
  -c "agent.cost_limit=${COST_LIMIT}"
)

info ""
info "══ 路 B 对照侧（mini-SWE-agent）══"
info "  模型      ${MINI_MODEL}"
info "  网关      ${GW_HOST}"
info "  step_limit ${STEP_LIMIT}   cost_limit ${COST_LIMIT}（A7.14.8 裁决）"
info "  题数      ${N_INST}   并发 ${MINI_WORKERS}"
info "  输出      ${MINI_OUT}"
info ""

if [[ "${DRY_RUN}" == "1" ]]; then
  info "── dry-run：以下命令未执行 ──"
  printf '  ANTHROPIC_BASE_URL=%s ANTHROPIC_API_KEY=<%d 字符> \\\n' "${GW_URL}" "${KEY_LEN}"
  printf '  HF_HUB_OFFLINE=1 HF_DATASETS_OFFLINE=1 MSWEA_CONFIGURED=true \\\n'
  printf '  LITELLM_LOCAL_MODEL_COST_MAP=True \\\n'
  printf '  %q ' "${CMD[@]}"
  printf '\n\n'
  info "转换（跑完后）："
  info "  bun run ${SWE_DIR#"${REPO_ROOT}/"}/mini-adapt.ts --mini-dir ${MINI_OUT} --run-id routeb-mini"
  exit 0
fi

# ⚠️ docker 必须先起来。不检查的话 mini 会在第一题上抛，
# 而那个报错长得像"数据集问题"（它在 load_dataset 之后才建容器）。
if ! docker info >/dev/null 2>&1; then
  bad "❌ docker 不可用 —— 先 colima start swebench"
  bad "   ⚠️ 起之前确认没有 harbor / 自建链路在跑（三条链路共用同一个 daemon）"
  exit 2
fi
ok "✓ docker 可用"

# API key 只在这一行出现，不 export 到脚本全局，减少它进日志的面。
# caffeinate -dimsu：A7.15 的教训，宿主休眠会同时污染耗时并给超时闸门续命。
info "开跑（caffeinate 防休眠已挂）…"
# ⚠️ 用系统 python3（不 import mini → 无横幅污染）。这一处若被横幅污染，
# 形态是 key 变成 "This is mini-swe-agent version..." → 上游 401，
# 而 401 长得像「凭据过期」，会把人引去查网关而不是查这一行。
# ⚠️ 必须按 **GW_HOST 精确挑**，不能只按 model_id（实测踩到，2026-08-28）：
# 两个条目的 model_id 都是 claude-sonnet-5（uniapi / ppchat 各一个），
# 只按 model_id 挑会拿到**第一个**的 key，而 GW_URL 上面已经挑成了另一个 ——
# 于是 key 与 URL 来自不同条目。形态是上游 401，而 401 长得像「凭据过期」，
# 会把人引去查网关凭据，而不是查这两处挑法不一致。
KEY="$(
  python3 - "${MINI_MODEL}" "${GW_HOST}" <<'PY'
import json, os, sys
from urllib.parse import urlparse
d = json.load(open(os.path.expanduser("~/.sid-code/settings.json")))
want = sys.argv[1].split("/")[-1]
host = sys.argv[2]
for m in d.get("availableModels", []):
    if m.get("provider") != "anthropic":
        continue
    if m.get("model_id") != want and m.get("name") != want:
        continue
    url = m.get("base_url") or m.get("baseURL") or ""
    # 同一条目才输出 —— host 对不上就继续找，**不退化**。
    if urlparse(url).netloc != host:
        continue
    print(m.get("api_key") or "")
    break
PY
)"
if [[ -z "${KEY}" ]]; then
  bad "❌ 取不到 host=${GW_HOST} 的 api_key —— 上面挑 URL 与这里挑 key 的逻辑不一致了"
  exit 2
fi
env -u ANTHROPIC_AUTH_TOKEN \
  ANTHROPIC_BASE_URL="${GW_URL}" \
  ANTHROPIC_API_KEY="${KEY}" \
  HF_HUB_OFFLINE=1 HF_DATASETS_OFFLINE=1 \
  MSWEA_CONFIGURED=true \
  LITELLM_LOCAL_MODEL_COST_MAP=True \
  caffeinate -dimsu "${CMD[@]}"

ok ""
ok "✅ mini 跑完 → ${MINI_OUT}"
ok ""
ok "下一步（两步，别跳）："
ok "  1. 转换：bun run ${SWE_DIR#"${REPO_ROOT}/"}/mini-adapt.ts --mini-dir ${MINI_OUT} --run-id routeb-mini"
ok "  2. 判分：bun run ${SWE_DIR#"${REPO_ROOT}/"}/grade.ts --run-id routeb-mini"
ok ""
ok "⚠️ exit_status=Submitted **不等于 solved**（A7.14.4）—— 判分归官方 harness，"
ok "   在跑完第 2 步之前，mini 侧一个分数都还没有。"
