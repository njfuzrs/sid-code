#!/usr/bin/env bash
# W3 扩规模：分批续跑 driver。一条臂 = 一个 job 目录 = 一个分母。
#
# ## 为什么按「时间」分批而不是按「题」分批
#
# `harbor/job.py:252` 有 `existing_config != self.config → FileExistsError`，
# 而 `-i` 过滤器**会被写进 config.json 的 `datasets[].task_names`**
# （实测 `runs/modelswitch-base-fill/config.json` → `['polyglot-c-py','regex-log']`）。
# ⇒ 每批一个 `-i` 的 job 目录**永远合不回一个 job**，分母碎成 N 份，
#   而那正是 05 号被咬过的「两侧分母装的不是同一批题」。
#
# ⇒ 本脚本**全程不传 `-i`**。中断了就 resume（实测 3s 返回、已完成 trial
#   checksum 逐字未动），失败的题由 `w3-classify.py` 删目录后自动重新入队。
#
# ## 循环
#
#   跑/续跑 → w3-classify 判据 → 删「非能力失败」→ 续跑 → 直到收敛
#
# 停止条件（**必须有**）：连续两轮坏题集合不变 ⇒ 停手。
# 05 号 §00 已**两次实测**否决「重跑一次就好」（35% 与 80%，形态逐字相同），
# 不设停止条件就是无限烧钱。
#
# 用法：
#   bash w3-run.sh w3-sid-ds-72                       # dry-run（不删目录）
#   SID_W3_APPLY=1 bash w3-run.sh w3-sid-ds-72        # 真删并续跑
#   SID_W3_ARM=cc SID_W3_APPLY=1 bash w3-run.sh w3-cc-sonnet-72
set -uo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"

JOB="${1:?用法: w3-run.sh <job-name>}"
ARM="${SID_W3_ARM:-sid}"                  # sid | cc
FAMILY="${SID_MODELSWITCH_FAMILY:-openai}"
DATASET="${SID_HARBOR_DATASET:-terminal-bench-local@2.0}"
MAX_ROUNDS="${SID_W3_MAX_ROUNDS:-4}"
APPLY="${SID_W3_APPLY:-0}"
JOBDIR="runs/$JOB"

# ── 代理：harbor 要 clone github 上的任务定义 ───────────────────────────────
# 🔴 实测教训：不带代理时 `harbor run` 挂在
# `git clone https://github.com/laude-institute/terminal-bench-2.git` 上，
# 报 `CalledProcessError ... exit status 128`（真因是
# `Failed to connect to github.com port 443`）—— 而那个报错**指向 git，
# 不指向网络**，很容易误判成"harbor 坏了"。
# ⛔ 端口一律探测，不写死（本仓铁律）。
if [ -z "${https_proxy:-}" ]; then
  PROXY_ADDR="$(bash ../lib/detect-proxy-port.sh 2>/dev/null | awk -F': ' '/→ 结果/{print $2}')"
  if [ -n "${PROXY_ADDR:-}" ]; then
    export https_proxy="http://${PROXY_ADDR}" http_proxy="http://${PROXY_ADDR}"
    echo "--- 代理已设为 ${PROXY_ADDR}（harbor 需要它 clone 任务定义）"
  else
    echo "⚠️ 未探测到代理 —— 若任务定义未缓存，harbor 会在 git clone 处失败"
  fi
fi

# ── 🔴 臂与 job 名一致性闸 ─────────────────────────────────────────────────
# 为什么要这道闸：`SID_W3_ARM` 忘传时 driver 静默走 sid 默认值，于是
# **拿 sid 跑出一个名叫 `w3-cc-sonnet-72` 的 job** —— 目录名说是 cc、里面是 sid，
# 而两侧都不报错，等到 T5 汇总时才发现「harness 对照」两边其实是同一个 harness。
# 08 号文档初稿的 §4.4 命令就漏了这个参数（2026-09-07 复核时抓到）。
# ⇒ 判据取「job 名里的意图」与「实际臂」是否矛盾，矛盾就停手。
case "$JOB" in
  *-cc-*|cc-*|*ccrun*)
    if [ "$ARM" != cc ]; then
      echo "⛔ job 名 '$JOB' 看着是 cc 臂，但 ARM=${ARM}（默认值）。"
      echo "   要跑 cc 臂请显式传： SID_W3_ARM=cc SID_W3_APPLY=1 bash w3-run.sh $JOB"
      echo "   （若确实想用 sid 臂跑这个名字，改个不含 'cc' 的 job 名）"
      exit 2
    fi ;;
esac
if [ "$ARM" = cc ]; then
  case "$JOB" in
    *sid*) echo "⛔ ARM=cc 但 job 名 '$JOB' 含 'sid' —— 名实不符，停手。"; exit 2 ;;
  esac
fi

# ── 🔴 题集指纹闸：防「跑到一半题集变了」───────────────────────────────────
#
# `registry.local.json` 由 `gen-local-registry.py` 按 `docker images` **实况派生**
# ⇒ 一次 `docker prune`（或任何让镜像消失的操作）后重新生成，题集就少了。
#
# 后果（2026-09-07 实测，用 nop + 临时 registry 验的，⛔ 没碰 registry.local.json）：
#
#   | 场景 | 报错 |
#   | 同一 registry 路径、内容缩水（**这就是 prune 后的真实形态**） | `ValueError: Existing trial config does not match planned job config.` |
#   | 换了 registry 路径 | `FileExistsError: ... cannot be resumed with a different config.` |
#
# ⚠️ 本文档初稿把两者都写成 `FileExistsError` —— **错的**。真实的 prune 场景走
# `ValueError`（`job.py:359`），因为 `DatasetConfig` 只记 name/version/registry_path，
# **不记题目清单**；不匹配是在逐个比 `TrialConfig`（内含 `task`）时才发现的。
#
# ⇒ 这道闸把指纹存进 job 目录，跑前比一次。**报错在 harbor 之前，且说得清是什么变了。**
FP_FILE="$JOBDIR/.w3-taskset-fingerprint"
taskset_fp() {
  python3 - "$DATASET" <<'PYFP'
import hashlib, json, sys
name = sys.argv[1].split("@")[0]
ver = sys.argv[1].split("@")[1] if "@" in sys.argv[1] else None
for e in json.load(open("registry.local.json")):
    if e.get("name") == name and (ver is None or str(e.get("version")) == ver):
        ts = sorted(t["name"] if isinstance(t, dict) else t for t in e["tasks"])
        print(f"{len(ts)}:{hashlib.sha256(chr(10).join(ts).encode()).hexdigest()[:16]}")
        break
else:
    print("MISSING")
PYFP
}
FP_NOW="$(taskset_fp)"
if [ "$FP_NOW" = MISSING ]; then
  echo "⛔ registry.local.json 里找不到 dataset '$DATASET' —— 停手。"
  echo "   先跑: python3 gen-local-registry.py"
  exit 2
fi
if [ -f "$FP_FILE" ]; then
  FP_OLD="$(cat "$FP_FILE")"
  if [ "$FP_NOW" != "$FP_OLD" ]; then
    echo "⛔ **题集与本 job 首跑时不一致** —— resume 会以 ValueError 失败，停手。"
    echo "   首跑: $FP_OLD"
    echo "   现在: $FP_NOW    （格式 = 题数:sha16）"
    echo "   多半是中途 docker prune / 重新生成了 registry.local.json。"
    echo "   ⇒ 要么把镜像补回来（bash pull-tb-images.sh）让指纹复原，"
    echo "     要么换一个新 job 名重跑（⛔ 别把两个题集的结果混进一个分母）。"
    exit 2
  fi
fi

# ── 磁盘余量闸（72 题的容器持续吃盘）──────────────────────────────────────
DISK_FREE_G="$(colima ssh -p swebench -- df -BG /var/lib/docker 2>/dev/null \
  | awk 'NR==2{gsub(/G/,"",$4); print $4}')"
if [ -n "${DISK_FREE_G:-}" ]; then
  echo "--- 磁盘余量: ${DISK_FREE_G}G"
  if [ "$DISK_FREE_G" -lt 20 ] 2>/dev/null; then
    echo "⛔ 余量 < 20G —— 停手（跑满会以各种伪装成 reward=0 的形态失败）。"
    echo "   ⛔ **别在 arm 跑到一半 docker prune** —— 题集一变上面那道指纹闸就会拦，"
    echo "      而已花的钱回不来。正确顺序：让当前 arm 跑完 → 清理 → 开下一条臂。"
    exit 2
  fi
fi

echo "=== W3 分批续跑  job=$JOB  臂=$ARM  dataset=$DATASET ==="
echo "    删除模式: $([ "$APPLY" = 1 ] && echo '真删 (SID_W3_APPLY=1)' || echo 'dry-run（只打印，不删）')"
[ "$APPLY" != 1 ] && echo "    ℹ️ dry-run 下不会重跑任何题 —— 看完判据再加 SID_W3_APPLY=1"

# ── 网关 stats 快照：用**差**（flow）而不是末次值（stock）─────────────────
# CLAUDE.md 铁律第 4 条：末次快照除以累加值得到的是错数。
GW_PORT=4101; [ "$FAMILY" = anthropic ] && GW_PORT=4100
[ "$ARM" = cc ] && GW_PORT=4100
snap_stats() { curl -s -m 10 "http://127.0.0.1:${GW_PORT}/__stats" 2>/dev/null || echo '{}'; }
STATS_BEFORE="$(snap_stats)"

run_once() {
  local round="$1"
  echo ""
  echo "--- 第 $round 轮 $(date '+%F %T') ---"
  if [ "$ARM" = cc ]; then
    SID_CC_JOB="$JOB" SID_HARBOR_DATASET="$DATASET" \
      bash run-claude-code-contrast.sh
  else
    SID_HARBOR_DATASET="$DATASET" SID_MODELSWITCH_FAMILY="$FAMILY" \
      bash run-model-switch.sh "$JOB"
  fi
  echo "--- 第 $round 轮结束 rc=$? $(date '+%F %T') ---"
}

# ── 判据一次，回填 BAD / PENDING / KEEP ────────────────────────────────────
# 🔴 **删除必须发生在 harbor run 之前。** `job.py:333` 只把**没有 result.json**
# 的 trial 重新入队 ⇒ 坏 trial 只要还带着 result.json，跑一轮对它毫无作用。
# 先跑后删的写法会让每次 resume 白赔一整轮（实测 72 题一轮是小时级）。
# 顺带解决第二件事：dry-run 不再需要先花钱才能看到判据。
classify_pass() {
  local args=(--json)
  [ "$APPLY" = 1 ] && args+=(--apply)
  local out rc
  out="$(python3 w3-classify.py "$JOBDIR" "${args[@]}" 2>&1)"; rc=$?
  echo "$out" | grep -v '^JSON:'
  if [ "$rc" = 3 ]; then
    # 🔴 判据自己坏了 ⇒ fail-closed。⛔ 不许「判不出来就继续跑」：
    # 那会让下一轮在一个不可信的分母上继续花钱。
    echo "⛔ 判据 fail-closed（rc=3）—— 停手，不再续跑。先修判据。"
    exit 3
  fi
  local summary
  summary="$(echo "$out" | sed -n 's/^JSON://p')"
  [ -z "$summary" ] && { echo "⛔ 判据没输出 JSON 摘要 —— 停手（宁可停也不瞎跑）"; exit 1; }
  BAD="$(python3 -c "import json,sys;print(' '.join(json.loads(sys.argv[1])['drop_tasks']))" "$summary")"
  PENDING="$(python3 -c "import json,sys;print(json.loads(sys.argv[1])['pending'])" "$summary")"
  KEEP="$(python3 -c "import json,sys;print(json.loads(sys.argv[1])['keep'])" "$summary")"
  echo "    → 计分 $KEEP 题 / 待重跑 $(echo $BAD | wc -w | tr -d ' ') 题 / 未跑完 $PENDING 题"
}

PREV_BAD=""
for round in $(seq 1 "$MAX_ROUNDS"); do
  # 第一轮若 job 目录还不存在，没什么可判的 —— 直接跑。
  if [ -d "$JOBDIR" ] && ls -d "$JOBDIR"/*__*/ >/dev/null 2>&1; then
    echo ""
    echo "--- 第 $round 轮 · 跑前判据 ---"
    classify_pass

    if [ -z "$BAD" ] && [ "$PENDING" = 0 ]; then
      echo "✅ 全部题目都有可计分结果 —— 收敛，停。"
      break
    fi
    if [ "$APPLY" != 1 ]; then
      echo "ℹ️ dry-run：未删、未跑（**没花钱**）。确认判据无误后："
      echo "     SID_W3_APPLY=1 bash w3-run.sh $JOB"
      break
    fi
    if [ "$BAD" = "$PREV_BAD" ] && [ -n "$BAD" ]; then
      # 同一批题重跑仍坏 ⇒ 它们不是抖动，继续重跑只是烧钱。
      echo "🛑 坏题集合与上一轮**逐字相同** ⇒ 这些不是上游抖动，停手。"
      echo "   仍坏: $BAD"
      echo "   ⇒ 逐题看 runs/$JOB/<task>__*/agent/sid-home/debug.log 定性质"
      break
    fi
    PREV_BAD="$BAD"
  fi

  # 🔴 dry-run 绝不调 run_once。
  # 上一版这里有个真 bug：job 目录还不存在时（首跑），循环会跳过判据直接
  # `run_once`，于是 **dry-run 会先花掉一整轮的钱**，然后打印"未跑（没花钱）"
  # —— 一句与事实相反的话，而它读起来完全正常。
  if [ "$APPLY" != 1 ]; then
    echo ""
    echo "ℹ️ dry-run：**不会启动任何 harbor run**（一分钱不花）。"
    echo "   $JOBDIR $([ -d "$JOBDIR" ] && echo '已有产物，判据见上' || echo '尚无产物 —— 判据无从谈起')"
    echo "   要真跑： SID_W3_APPLY=1 bash w3-run.sh $JOB"
    break
  fi

  run_once "$round"
  [ -d "$JOBDIR" ] || { echo "⛔ $JOBDIR 不存在 —— 第一轮就没起来，停手"; exit 1; }
  # 首跑成功后落指纹（⛔ 只写一次，之后只读不覆盖 —— 覆盖就等于把闸拆了：
  # 题集变了也会被"更新"成新指纹，于是下一轮什么都拦不住）。
  [ -f "$FP_FILE" ] || { echo "$FP_NOW" > "$FP_FILE"; echo "--- 已记题集指纹: $FP_NOW"; }
  [ "$round" = "$MAX_ROUNDS" ] && echo "🛑 已达轮数上限 ${MAX_ROUNDS}，停手。"
done

# ── 网关重试是否真的生效（T1 的唯一判据）───────────────────────────────────
echo ""
echo "=== 网关重试计数（flow = 本次跑的增量，⛔ 不是累计快照）==="
python3 - "$STATS_BEFORE" "$(snap_stats)" <<'PY'
import json, sys
def st(s):
    try: return json.loads(s).get("stats", {}) or {}
    except Exception: return {}
a, b = st(sys.argv[1]), st(sys.argv[2])
keys = ("retry_attempt", "retry_success", "retry_exhausted",
        "retry_exhausted_budget", "retry_skip_headers_sent",
        "retry_skip_not_retryable", "upstream_error", "upstream_429")
for k in keys:
    d = (b.get(k, 0) or 0) - (a.get(k, 0) or 0)
    if d: print(f"    {k:<28} +{d}")
if not (b.get("retry_success", 0) - a.get("retry_success", 0)):
    print("    ⚠️ retry_success 增量为 0 —— 本轮重试**一次都没成功触发**。")
    print("       这不等于坏：可能上游本轮很稳。但也不能据此说「重试生效了」。")
PY

echo ""
if ls -d "$JOBDIR"/*__*/ >/dev/null 2>&1; then
  echo "=== 收尾：分母核账（⛔ 引用时别拿 72 当分母）==="
  python3 w3-classify.py "$JOBDIR" 2>&1 | head -5

  # ── 🔴 事后核验「这个 job 到底是哪条臂跑的」——**按内容，不按名字** ──────────
  #
  # 上面那道臂闸（§59）只看 job 名里的关键字，是**跑前的启发式**：
  # 它挡得住「名字像 cc 但 ARM=sid」，挡不住「名字不含 cc、ARM 也没传」——
  # 那种情况下两道判据都放行，产出一个 sid 跑的、名字中性的 job，
  # 而到 T5 汇总时它会被当成 cc 臂并排进去（08 号 §9.2-⑦ 那个真错的形态）。
  #
  # ⇒ 这一条读 `config.json` 的 `agent.name`（harbor 自己写下的**观测值**），
  #    与声明的 ARM 对账。它是唯一能在**事后**发现名实不符的判据。
  ACTUAL_ARM="$(python3 -c "
import sys; sys.path.insert(0, '.')
from arm_health import detect_arm
import glob
for d in sorted(glob.glob('$JOBDIR/*__*')):
    a = detect_arm(d)
    if a: print(a); break
else: print('UNKNOWN')
" 2>/dev/null || echo UNKNOWN)"
  echo ""
  echo "=== 收尾：臂核验（按 config.json 内容，⛔ 不按目录名）==="
  echo "    声明 ARM=$ARM   实测 agent=$ACTUAL_ARM"
  if [ "$ACTUAL_ARM" = UNKNOWN ]; then
    echo "    ⚠️ 判不出实际臂（config.json 缺 agent.name 或是新 agent）—— ⛔ 别猜，人工核。"
  elif [ "$ACTUAL_ARM" != "$ARM" ]; then
    echo "    ⛔ **名实不符**：声明 ${ARM}，实际跑的是 ${ACTUAL_ARM}。"
    echo "       ⇒ 这一份产物**不能**当 $ARM 臂用（08 号 §9.2-⑦：两侧都不报错，"
    echo "         到汇总才发现「对照」两边是同一个 harness）。"
    echo "       ⇒ 改个正确的 job 名重跑；⛔ 别把它并排进对照表。"
  else
    echo "    ✅ 一致"
  fi

  # ── 归档：🔴 `runs/` 不入库，这一步是唯一留下第二份的机会 ──────────────────
  #
  # 为什么接进流程而不是「跑完手工再跑一下」：`run-model-switch.sh:432` 那段
  # 注释记着同型教训 —— digest 在第九棒就存在，而**九棒里零次被跑过**。
  # 价值不在工具，在它被真的执行。T4 一条臂 $36–41，漏采一次就是白花。
  #
  # ⚠️ 只读旁路：失败一律不改 RUN_RC（跑分产物已经落盘，汇总失败不该动结论）。
  echo ""
  echo "=== 收尾：汇总归档（results/ 不在 gitignore 里 ⇒ 唯一能进版本库的那一份）==="
  if python3 w3-summary.py "$JOBDIR" -o results/ 2>&1 | tail -22; then
    echo "    ⚠️ 记得 git add results/ —— runs/ 整个被 ignore，不 commit 就只有本机一份。"
  else
    echo "    ⚠️ 汇总失败（不影响已落盘的跑分产物）。手工重跑："
    echo "       python3 w3-summary.py $JOBDIR -o results/"
  fi
else
  echo "=== 收尾：无产物，跳过分母核账 ==="
fi
