#!/usr/bin/env bash
# 换档重测那 10 题(§17.5 第一优先)。除权限档外,所有变量与第五棒(§14.7/§15)一致。
#
# 用法:  caffeinate -dimsu bash run-permission-switch.sh [job-name] [题名...]
#
# 不给题名 = 跑全部 10 题。给题名 = 只跑这几题(每个都变成 harbor 的 `-i`,支持 glob):
#
#     bash run-permission-switch.sh permswitch-r3 polyglot-c-py regex-log
#
# **补跑存在的意义**:基础设施故障(上游额度耗尽 / 网关 502)会让某题
# `num_turns=0`、一次 API 调用都没发生,而它的 `reward=0.0` 与真的没解出来
# **逐字节一样**(判据见 `verifier_health.agent_ran`)。这种题必须补跑,
# 但为此重跑全部 10 题要花 ~$7 且把已经跑好的样本也一起换掉 ——
# 换掉就意味着**分母里混进两批不同时间、不同上游状态的数据**。
# 补跑只花 ~$1,且只补该补的那几题。
#
# ⚠️ 补跑结果**落在新 job 目录**,不覆盖原目录。复算时要么整体用新 job,
# 要么明确写清"某题取自哪个 job" —— 别让两批数据在同一张表里不加标注地混着。
#
# ⚠️ 跑之前必须过的两道闸(都踩过,都不报错):
#
# 1. **verifier 的 uv 下载速率 ≥500KB/s**。10 题的 test.sh 全部实时从 GitHub 下
#    17.8MB 的 uv;宿主链路劣化到 70KB/s 时,verifier 在 103/243/413 秒后放弃,
#    reward 全部写 0 —— 而 `sid_subtype` 照样是 `success`。
#    **那是一轮"绿着坏掉"的假数据**(2026-08-29 实测,烧掉 $3.12)。判据:
#      docker run --rm alpine:3 sh -c 'apk add -q curl; curl -sL -o /dev/null -m 30 \
#        -w "%{speed_download}B/s\n" \
#        https://github.com/astral-sh/uv/releases/download/0.7.13/uv-x86_64-unknown-linux-gnu.tar.gz'
#    基线(能跑那次)verifier 全程 24-56s;降速那次是 103-413s 后放弃。
# 2. **上游错误率**(2026-08-30 从「10 题里 4 题被上游打死」改成可执行判据)。
#    原来这条只写着「curl /__stats 看看」——**没有任何东西真的去测**,
#    于是那一轮直接开跑,结果 4/10 题报废:2 题一次 API 调用都没成功
#    (403 额度耗尽 / 502 断连),2 题跑到第 3、8 轮被 429 打空重试链。
#    实测当时上游错误率 **35%**(20 连:13×200 / 7×429)。
#    ⚠️ 判据不是「能不能连上」——单发探针几乎总是 200。要测**错误率**。
#    ⚠️ 也不要指望重试链兜住:同一轮里 `fix-code-vulnerability` 吃了 39 次
#    429 仍拿到 1.0,而 `build-cython-ext` 吃了 30 次就死了 ——
#    **35% 下能不能活是抛硬币,不是阈值**。所以宁可等上游恢复再开跑。
#    本脚本会**自动跑这道闸**(下面的 preflight_upstream),超阈值直接拒绝启动;
#    确实要在劣化的上游上跑,用 SID_HARBOR_SKIP_PREFLIGHT=1 显式跳过。
set -uo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"

JOB="${1:-permswitch-$(date +%m%d-%H%M)}"
shift || true
# 剩下的位置参数都是题名 → 每个拼成一个 `-i`。空数组时不加任何 -i,即跑全部。
TASK_FILTER=()
for t in "$@"; do TASK_FILTER+=(-i "$t"); done

# 网关地址。`192.168.5.2` = colima host-gateway,⚠️ **不是** 172.17.0.1
# (那是 VM 内的 docker bridge,宿主服务不在上面;实测容器侧 connection refused)。
# 端口默认 4100 = shim 的 `--port` 默认值。⚠️ 别填 4000 —— 那上面是
# claude-trace-proxy(透传),占位 token 会被原样转给上游 → 401,而 401 长得像
# 「key 不对」,排查方向会跑偏(见 sid_code_agent.py 的 DEFAULT_GATEWAY_PORT 注释)。
export SID_HARBOR_GATEWAY_URL="http://192.168.5.2:${SID_HARBOR_GATEWAY_PORT:-4100}"
# ⚠️ 必须指向当前 HEAD 编出来的包。缺口 B 的教训:TS 改了不重编 = 改了等于没改,且不报错。
export SID_HARBOR_BINARY_ARM64=~/.local/share/sid-harbor-gateway/bins/sid-code-arm64-30586ff003c9
export SID_HARBOR_BINARY_X64=~/.local/share/sid-harbor-gateway/bins/sid-code-x64-30586ff003c9
export SID_HARBOR_PROVIDER=anthropic
export HARBOR_TELEMETRY=0
export PYTHONPATH="$(pwd)"
# 权限档:**不显式传** —— 默认已是 skip 布尔 flag。显式传会撞 __init__ 的互斥校验。

COMMON=(-d terminal-bench-sample@2.0 -m anthropic/claude-sonnet-5 -n 1 -k 1
        --registry-path registry.local.json
        --jobs-dir runs --agent-setup-timeout-multiplier 8
        --verifier-timeout-multiplier 6 --agent-timeout-multiplier 4
        --environment-build-timeout-multiplier 3 -y)

# ── 闸 2:上游错误率 ────────────────────────────────────────────────────────
# 判据:20 连、间隔 3s(贴近真实调用节奏),非 200 占比 > 20% 即拒绝启动。
# 20% 这个线来自实测:35% 时 4/10 题报废;10% 左右那一轮(基线)10 题全跑完。
# ── 闸 1:verifier 的 uv 下载速率(2026-08-31 第十二棒补:原来这条**只是注释**)────
#
# §21.9 交接里写着「跑前那两道闸**脚本会自己跑**」——**那句话不准**:
# 脚本自动跑的只有闸 2(上游错误率),闸 1 一直只是文件头的一段注释。
# 而本棒开跑前手动探它,第一次拿到 **38KB/s**(判据要求 ≥500KB/s)——
# 比 2026-08-29 那次烧掉 $3.12 的 70KB/s **还差**,30s 只下到 1.15MB/17.8MB。
# 那一轮的形态是:verifier 在 103/243/413 秒后放弃、reward 全写 0,
# 而 `sid_subtype` 照样是 `success` —— **一轮"绿着坏掉"的假数据**。
#
# 所以把它变成真的会跑的代码。判据与文件头注释同源(≥500KB/s),
# 探针**必须在容器内跑**:verifier 是在容器里下 uv 的,宿主链路好不代表容器好
#(本棒实测两者接近,但那是事实不是保证 —— colima 的 VM 有自己的网络栈)。
#
# ⚠️ 与闸 0 不同,这道闸**拦**:闸 0 拦不住的是"人有意跑旧版",而这里没有
# 任何正当理由在 70KB/s 的链路上开跑 —— 那只会产出假数据。
# 确实要跑用 SID_HARBOR_SKIP_PREFLIGHT=1(与闸 2 同一个开关)。
preflight_uv_speed() {
  local min="${SID_HARBOR_UV_MIN_BPS:-500000}" url speed
  url="${SID_HARBOR_UV_URL:-https://github.com/astral-sh/uv/releases/download/0.7.13/uv-x86_64-unknown-linux-gnu.tar.gz}"
  echo "--- 闸 1:verifier 的 uv 下载速率(容器内探,判据 ≥$((min / 1000))KB/s)"
  if ! command -v docker >/dev/null 2>&1; then
    echo "    ⚠️ 没有 docker,跳过本闸(无法在容器内探)"; return 0
  fi
  # ⚠️ 速率与 http_code **必须一起取**(变异 ③ 揪出的、我自己写的归因 bug):
  # URL 打不通时 curl 也吐 `speed_download=0`,只判速率会把它归因成"链路太慢、
  # 等恢复再跑",而真相是"探针根本没连上"——两者的下一步动作完全不同
  #(等 vs 查网络/镜像)。**错误归因比没有归因更坏**是本仓反复记的教训。
  local probe code
  probe=$(docker run --rm alpine:3 sh -c \
    "apk add -q curl; curl -sL -o /dev/null -m 30 -w '%{speed_download} %{http_code}' '$url'" 2>/dev/null \
    | tr -d '\n')
  speed=$(printf '%s' "$probe" | awk '{print $1}' | cut -d. -f1)
  code=$(printf '%s' "$probe" | awk '{print $2}')
  if [ -z "$speed" ] || ! [ "$speed" -ge 0 ] 2>/dev/null; then
    echo "    ⛔ 探针没拿到速率(容器起不来 / docker 不可用)——**不放绿**,这与「很慢」同样致命"
    echo "       手动复核:docker run --rm alpine:3 sh -c 'apk add -q curl; curl -sL -o /dev/null -m 30 -w \"%{speed_download}B/s http=%{http_code}\\n\" $url'"
    return 1
  fi
  if [ "$code" != "200" ]; then
    echo "    ⛔ 探针未取到文件(http=${code:-000},speed=${speed}B/s)——**这不是「链路慢」**,"
    echo "       是探针没连上(URL 变了 / 容器无外网 / DNS)。别当成"等一会儿就好"去等。"
    echo "       手动复核同上;确实要跳过:SID_HARBOR_SKIP_PREFLIGHT=1"
    return 1
  fi
  if [ "$speed" -lt "$min" ]; then
    echo "    ⛔ ${speed}B/s < ${min}B/s —— verifier 会在 103~413s 后放弃并把 reward 全写 0,"
    echo "       而 sid_subtype 照样是 success(2026-08-29 实测,烧掉 \$3.12 的假数据)。"
    echo "       等链路恢复再跑;确实要跑:SID_HARBOR_SKIP_PREFLIGHT=1 bash $0 ..."
    return 1
  fi
  echo "    ✅ ${speed}B/s ≥ ${min}B/s"
  return 0
}

preflight_upstream() {
  # 连数与间隔可覆盖 —— 这是为了**这道闸自己能被便宜地自证**:
  # 默认 20 连 × 3s = 60s,自证时跑两遍就 2 分钟,曾把验证本身跑超时。
  local n="${SID_HARBOR_PREFLIGHT_N:-20}" gap="${SID_HARBOR_PREFLIGHT_GAP:-3}" ok=0 codes=""
  PREFLIGHT_STATS_BEFORE=$(curl -s -m 10 "${SID_HARBOR_GATEWAY_URL/192.168.5.2/127.0.0.1}/__stats" 2>/dev/null || true)
  echo "--- 闸 2:上游错误率(${n} 连,间隔 ${gap}s)"
  for _ in $(seq $n); do
    local c
    # ⚠️ **必须用流式请求**,而且 max_tokens 不能是 8。2026-08-30 实测:同一时刻
    # 「max_tokens=8 非流式」探 5 次全 200,而「流式」探 5 次只有 3 次 200 ——
    # **闸用错了请求形态,就会在上游已经劣化时报绿**。那次它报 10% 放行,
    # 随后补跑的两题双双一次 API 调用都没成功(各 19 次 `Remote end closed` / err=502)。
    # agent 真实发的是 `stream:true` + `max_tokens=128000`(见 trial 日志的
    # `maxTokens` 字段),所以闸必须贴着这个形态探。
    c=$(curl -s -o /dev/null -w '%{http_code}' -m 40 \
      -X POST "${SID_HARBOR_GATEWAY_URL/192.168.5.2/127.0.0.1}/v1/messages" \
      -H 'content-type: application/json' -H 'x-api-key: no-auth-dummy' \
      -H 'anthropic-version: 2023-06-01' \
      -d '{"model":"claude-sonnet-5","max_tokens":2048,"stream":true,"messages":[{"role":"user","content":"Briefly explain a C/Python polyglot file."}]}' \
      2>/dev/null || echo 000)
    [ "$c" = "200" ] && ok=$((ok + 1))
    codes="$codes $c"
    sleep "$gap"
  done
  local fail_pct=$(( (n - ok) * 100 / n ))
  echo "    码:$codes"
  # 网关自己的计数器是**累积值(stock)**,直接当当前健康度用是错的(evals/CLAUDE.md §1.6)。
  # 这里只报**探测窗口内的差值(flow)**,与上面的探针互为交叉校验:
  # 探针看的是「我发的请求成不成」,__stats 看的是「网关到上游那一跳成不成」。
  local s1="${PREFLIGHT_STATS_BEFORE:-}" s2
  s2=$(curl -s -m 10 "${SID_HARBOR_GATEWAY_URL/192.168.5.2/127.0.0.1}/__stats" 2>/dev/null || true)
  if [ -n "$s1" ] && [ -n "$s2" ]; then
    python3 - "$s1" "$s2" <<'PYSTATS' || true
import json, sys
def agg(t):
    try: d = json.loads(t).get("stats", {})
    except Exception: return None
    ok = d.get("200_/v1/messages", 0)
    bad = d.get("upstream_error", 0) + d.get("upstream_429", 0) + d.get("upstream_403", 0)
    return ok, bad
a, b = agg(sys.argv[1]), agg(sys.argv[2])
if a and b:
    dok, dbad = b[0] - a[0], b[1] - a[1]
    tot = dok + dbad
    if tot > 0:
        print(f"    网关→上游(本窗口 flow):成功 {dok} / 失败 {dbad} → {dbad * 100 // tot}%")
    else:
        print("    网关→上游(本窗口 flow):窗口内无新请求")
PYSTATS
  fi
  echo "    200=${ok}/${n}  失败率=${fail_pct}%"
  if [ "$fail_pct" -gt 20 ]; then
    echo "    ⛔ 失败率 ${fail_pct}% > 20% —— **拒绝启动**。"
    echo "       实测 35% 时 10 题里 4 题被上游打死(2 题零调用 / 2 题重试链耗尽),"
    echo "       而那 4 题的 reward=0.0 与真的没解出来逐字节一样。等上游恢复再跑。"
    echo "       确实要在劣化的上游上跑:SID_HARBOR_SKIP_PREFLIGHT=1 bash $0 ..."
    return 1
  fi
  echo "    ✅ 失败率 ${fail_pct}% ≤ 20%"
  return 0
}

# ── 闸 0:点名的二进制必须**含有本次要验的改动**(2026-08-30 第十二棒实测差点踩死)─────
#
# 形态:上面 `SID_HARBOR_BINARY_*` 是**写死的路径**,里面嵌着一个 commit12。
# 修完代码若忘了重编 + 改这两行,评测跑的就是**旧字节** —— 而这件事
# **不报任何错**:harbor 正常跑完、10 题都有分、build.json 里 commit 字段
# 老老实实写着那个旧 commit(没人会去看)。于是判据全部"不成立",
# 结论是「修复没生效」,而真相是「修复没进二进制」。
#
# ⚠️ 第十二棒撞到的正是这一形态:HEAD=30586ff(含 P1-1 入账修复),
# 而这两行还指着 7f437eb(修复前一个 commit)。若照着跑那一次 $7,
# 拿到的会是「三个数仍是 41/40/40」→ 误判成「②那条修复是错的」。
#
# 判据用**产物字节**里内联的 commit(与 `_write_build_info` 同一口径,
# 走 `scripts/artifact-identity.ts`),**不是**路径里那串文件名 ——
# 文件名是人写的,会撒谎;字节不会。判「是不是当前 HEAD 的祖先且 != HEAD」
# 即为陈旧。⚠️ 只报警不拦:有意跑旧版做 A/B 是正当用法(本棒就做了),
# 拦死会把一个正当用法变成必须绕过的门。
preflight_binary_freshness() {
  local repo head warned=0
  repo="$(git rev-parse --show-toplevel 2>/dev/null || true)"
  [ -n "$repo" ] || { echo "--- 闸 0:不在 git 仓库内,跳过二进制新鲜度检查"; return 0; }
  head="$(git -C "$repo" rev-parse HEAD 2>/dev/null || true)"
  [ -n "$head" ] || return 0
  command -v bun >/dev/null 2>&1 || { echo "--- 闸 0:没有 bun,跳过二进制新鲜度检查"; return 0; }
  echo "--- 闸 0:二进制新鲜度(判据=产物字节内联 commit,非文件名)"
  local var path c checked=0
  for var in SID_HARBOR_BINARY_ARM64 SID_HARBOR_BINARY_X64; do
    eval "path=\${$var:-}"
    [ -n "$path" ] || continue
    checked=$((checked + 1))
    path="${path/#\~/$HOME}"
    if [ ! -f "$path" ]; then
      echo "    ⛔ $var 指向的文件不存在:$path"; warned=1; continue
    fi
    c=$(cd "$repo" && bun run scripts/artifact-identity.ts read "$path" 2>/dev/null \
        | tr -d ' \n' | sed -n 's/.*"commit":"\([0-9a-f]\{40\}\)".*/\1/p')
    if [ -z "$c" ]; then
      echo "    ⚠️ $var 读不出内联 commit(可能是老产物)——无法判新鲜度:$(basename "$path")"
      warned=1; continue
    fi
    if [ "$c" = "$head" ]; then
      echo "    ✅ $var = HEAD(${c:0:12})"
    elif git -C "$repo" merge-base --is-ancestor "$c" "$head" 2>/dev/null; then
      echo "    ⛔ $var 是**陈旧产物**:${c:0:12} 落后 HEAD(${head:0:12}) $(git -C "$repo" rev-list --count "$c..$head" 2>/dev/null) 个提交"
      echo "       本次改动若在这些提交里,评测跑的是旧字节,而**不会报任何错**。重编:"
      echo "         bash scripts/build-branch-artifact.sh --target bun-linux-arm64 --no-tarball"
      echo "         cp dist/branch-builds/*-${head:0:12}/sid-code <bins>/sid-code-arm64-${head:0:12}"
      echo "         bash scripts/build-branch-artifact.sh --target bun-linux-x64-baseline --no-tarball"
      echo "         cp dist/branch-builds/*-${head:0:12}/sid-code <bins>/sid-code-x64-${head:0:12}"
      echo "       然后把本脚本顶部那两行 SID_HARBOR_BINARY_* 改成新路径。"
      warned=1
    else
      echo "    ⚠️ $var 的 commit ${c:0:12} 不是 HEAD 的祖先(另一条分支/更新的产物)"
      warned=1
    fi
  done
  # ⚠️ **不能在 checked=0 时报绿**(本棒自证变异 ④ 揪出的、我自己写的 bug):
  # 两个变量都没设时原文案打「两个架构的产物都与 HEAD 对齐」——
  # 它一个文件都没读却报了绿,而这恰好是 §21.5-1 那条教训(假绿比不做更坏)。
  # 未点名不是错(agent 会按 commit 自动发现),但必须说清"这道闸没生效",
  # 而不是冒充"检查通过"。
  if [ "$checked" = 0 ]; then
    echo "    ⚠️ 未点名任何 SID_HARBOR_BINARY_*(本闸未生效)——二进制由 agent 按 commit 自动发现,新鲜度由那条路径自己保证"
  elif [ "$warned" = 0 ]; then
    echo "    ✅ 已点名的 $checked 个产物都与 HEAD 对齐"
  fi
  return 0   # 只报警不拦(见上方注释:跑旧版做 A/B 是正当用法)
}

# ── 闸 3:网关端点必须是**我们的 shim**,不是别的服务 ─────────────────────────
#
# 2026-08-31 实测踩到:`SID_HARBOR_GATEWAY_URL` 的默认端口原是 `4000`,
# 而 shim 在 `4100`;4000 上跑的是 claude-trace-proxy —— 一个**透传**代理。
# 打过去的结果是 **401**,而 401 的字面意思是「凭据不对」,人会去翻 key、
# 翻 settings.json,查不到真因是「网关指错了一个端口」。
#
# 判据不是「端口连得上」(透传代理也连得上),而是 **`/__stats` 返回 shim 的
# 那个 JSON 结构**。实测区分度:shim 的 `/__stats` 回
# `{"stats":{...},"upstream_model":...}`;claude-trace 的 `/__stats` 回一个
# **HTML 页面且 http=200** —— 所以**只看状态码会被骗过**,必须验结构。
# 同理不存在的路径:shim 回 403(端点收窄),claude-trace 回 200(万能透传)。
#
# 这道闸**拦**:网关指错时整轮数据全是废的,没有任何正当理由继续。
preflight_gateway_identity() {
  local url="${SID_HARBOR_GATEWAY_URL/192.168.5.2/127.0.0.1}"
  echo "--- 闸 3:网关身份(判据=/__stats 是 shim 的 JSON 结构,非仅状态码)"
  local body
  body=$(curl -s -m 10 "${url}/__stats" 2>/dev/null || true)
  if [ -z "$body" ]; then
    echo "    ❌ ${url}/__stats 无响应 —— shim 没在跑?"
    echo "       起它: python3 ~/.local/share/sid-harbor-gateway/gateway.py --port 4100 --model-name <上游模型名>"
    return 1
  fi
  # 用 python 验结构而不是 grep 字符串:HTML 里也可能恰好含 "stats" 字样。
  if ! printf '%s' "$body" | python3 -c '
import json, sys
try:
    d = json.load(sys.stdin)
except Exception:
    sys.exit(1)          # 不是 JSON(claude-trace 会回 HTML)
sys.exit(0 if isinstance(d.get("stats"), dict) and "upstream_model" in d else 1)
' 2>/dev/null; then
    echo "    ❌ ${url}/__stats 有响应但**不是 shim 的结构**(很可能是透传代理,如 :4000 的 claude-trace)"
    echo "       症状预告:占位 token 会被原样转给上游 → 401,报错长得像「key 不对」"
    return 1
  fi
  local model
  model=$(printf '%s' "$body" | python3 -c 'import json,sys; print(json.load(sys.stdin).get("upstream_model",""))' 2>/dev/null)
  echo "    ✅ ${url} 是 shim(上游模型=${model:-?}）"
  return 0
}

preflight_binary_freshness

if [ "${SID_HARBOR_SKIP_PREFLIGHT:-0}" = "1" ]; then
  echo "⚠️ 已显式跳过跑前闸(SID_HARBOR_SKIP_PREFLIGHT=1)——本轮数据可能混入上游故障样本。"
elif ! preflight_gateway_identity; then
  exit 1
elif ! preflight_uv_speed; then
  exit 1
elif ! preflight_upstream; then
  exit 1
fi

echo "=== 启动 $(date '+%F %T')  job=$JOB ${TASK_FILTER[*]:+(只跑 ${TASK_FILTER[*]})} ==="
# ── E1：verifier 的 uv 走宿主本地镜像（2026-09-02 接入）───────────────────────
#
# 与 run-model-switch.sh / run-claude-code-contrast.sh 同一套（共用 lib/uv-mirror.sh）。
# 理由与判据见 lib/uv-mirror.sh 头注释：verifier 下 uv tarball 时 curl 打不通
# github.com，会让 reward=0 变成**假 0**（没判分），而它与"没解出来"逐字节相同。
# ⚠️ 三条 runner 必须同时接 —— 只接一部分就是不受控变量。门禁：
# tests/eval/harbor-uv-mirror-parity.test.ts
UV_MIRROR_PID=""
if [ "${SID_HARBOR_SKIP_UV_MIRROR:-0}" = "1" ]; then
  echo "--- E1：已显式跳过 uv 本地镜像（SID_HARBOR_SKIP_UV_MIRROR=1）——verifier 将直连 github"
else
  echo "--- E1：起 uv 本地镜像（消灭 verifier 的外网下载）"
  if _uv_mirror_env="$(bash ../lib/uv-mirror.sh start)"; then
    eval "$_uv_mirror_env"
    COMMON+=(--ve "UV_INSTALLER_GITHUB_BASE_URL=${UV_MIRROR_BASE_URL}")
    echo "    ✅ 已注入 --ve UV_INSTALLER_GITHUB_BASE_URL=${UV_MIRROR_BASE_URL}"
  else
    echo "    ⚠️ uv 镜像未起成 —— 退回直连 github（= 本轮之前的行为，不更坏）。"
    echo "       但那正是基线 5 题假 0 的成因，本轮仍可能复发。"
  fi
fi

harbor run "${COMMON[@]}" "${TASK_FILTER[@]+"${TASK_FILTER[@]}"}" \
  -a sid_code_agent:SidCodeAgent --job-name "$JOB"
RUN_RC=$?
# E1 镜像服务收尾（tarball 已落盘，停进程不影响下次复用）。
bash ../lib/uv-mirror.sh stop "${UV_MIRROR_PID:-}" >/dev/null 2>&1 || true
echo "=== 结束 $(date '+%F %T') rc=$RUN_RC ==="

# ── 跑完自动嚼一遍轨迹(§20.10 第五优先,本轮补上)────────────────────────────
#
# 为什么要接进流程:digest 在第九棒就存在,而**九棒里零次被跑过** ——
# 一个「跑完手工再跑一下」的步骤,等于没有这个步骤。第十棒第一次跑了它,
# 当场推翻两处判读、挖出两个缺陷($0)。价值不在工具,在**它被真的执行**。
#
# ⚠️ 它是**只读旁路**:失败一律不改 $RUN_RC。评测结果不能因为分析步骤炸了而变色 ——
# 那会把「分析脚本有 bug」伪装成「这轮评测失败」。
#
# ⚠️ 逐题落盘再读,**不在管道里边跑边抽字段**(§19.7 的告诫,第十棒验证过它是对的):
# 边跑边 grep 时,输出被截断/顺序错乱都不会报错,而你以为自己读全了。
digest_all() {
  local run_dir="runs/$JOB" d name home out n_ok=0 n_skip=0
  [ -d "$run_dir" ] || { echo "  ⚠️ 找不到 $run_dir,跳过 digest"; return 0; }
  local dig_dir="$run_dir/_digests"
  mkdir -p "$dig_dir" || return 0
  echo "--- digest:逐题嚼轨迹 → $dig_dir/"
  for d in "$run_dir"/*__*/; do
    [ -d "$d" ] || continue
    name=$(basename "$d" | sed 's/__.*//')
    home="$d/agent/sid-home"
    out="$dig_dir/$name.txt"
    # 零调用的题没有会话轨迹(实测 regex-log 就是),它 rc=1 是**预期**,
    # 不是 digest 坏了 —— 所以这里区分「跳过」与「跑成」,别把两者混成一个数。
    #
    # ⚠️ 判据必须是「**有没有会话子目录**」,不是「sessions 目录在不在」。
    # 初版写的是 `[ ! -d .../sessions ]` —— 实测 regex-log 的 `sessions/` 目录
    # **建出来了但是空的**,于是这条跳不过去,digest 照跑并 rc=1,
    # 一个**预期内的空轨迹**被报成了 `⚠️ digest rc≠0`(假红)。
    if ! compgen -G "$home/trajectories/sessions/*/" >/dev/null 2>&1; then
      echo "    - $name: NO_TRAJ(零调用,预期)"
      n_skip=$((n_skip + 1))
      continue
    fi
    if SID_CONFIG_DIR="$(pwd)/$home" bun "$SID_CODE_REPO/scripts/trace-digest.ts" \
         >"$out" 2>"$out.stderr"; then
      n_ok=$((n_ok + 1))
      # 只把 L0 高危摘出来当一行提要,详情在落盘文件里。
      # ⚠️ 不要据此直接下结论:实测 max_turns 题的 `tool_use_without_result`
      # 曾是**假阳性**(§20.3 已修为 L0 低危),而当时它挂着 🔴 高危。
      #
      # ⚠️ 不能写 `$(grep -c ... || echo 0)`:`grep -c` 无匹配时
      # **既打印 `0` 又以 1 退出**,于是 `|| echo 0` 再补一个 `0`,
      # 变量变成两行 `0\n0`,输出里就出现「高危 0(换行)0 条」。
      # 实测踩到(4/9 题都这样)。用 `|| true` 兜退出码,不要再补打印。
      local hi
      hi=$(grep -c '^  \[高\]' "$out" 2>/dev/null || true)
      hi=${hi:-0}
      echo "    ✓ $name: 高危 $hi 条 → $(basename "$out")"
    else
      echo "    ⚠️ $name: digest rc≠0(详见 $out.stderr)"
    fi
  done
  echo "  digest 完成:跑成 $n_ok / 跳过 $n_skip"
}

# 仓库根:digest 脚本在 sid-code 仓里,而本脚本的 cwd 是 harbor 目录。
# ⚠️ 用 git rev-parse 而不是写死相对层数 —— 目录挪动时后者会静默指向不存在的路径。
SID_CODE_REPO="${SID_CODE_REPO:-$(git rev-parse --show-toplevel 2>/dev/null || true)}"
if [ -z "$SID_CODE_REPO" ] || [ ! -f "$SID_CODE_REPO/scripts/trace-digest.ts" ]; then
  echo "⚠️ 找不到 scripts/trace-digest.ts,跳过 digest(可用 SID_CODE_REPO=... 指定仓库根)"
elif ! command -v bun >/dev/null 2>&1; then
  echo "⚠️ 没有 bun,跳过 digest"
else
  digest_all || true
fi

# 跑完顺手报一遍逐题进度(含「自报成功却 0 分」那格)。同样是只读旁路。
if [ -f progress-permission-switch.py ]; then
  echo "--- 逐题进度(判据见 verifier_health.py)"
  python3 progress-permission-switch.py "runs/$JOB" 2>&1 | sed 's/^/    /' || true
fi

exit $RUN_RC
