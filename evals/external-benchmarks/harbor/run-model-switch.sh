#!/usr/bin/env bash
# W2② 换模型验证：把模型从 claude-sonnet-5 换成 deepseek-v4-pro，其余变量全部对齐。
#
# 用法：
#   caffeinate -dimsu bash run-model-switch.sh <job-name> [题名...]
#   SID_MODELSWITCH_FAMILY=anthropic bash run-model-switch.sh modelswitch-base   # 同档基线
#
# ## ⚠️ 这一步的产出**不是**「哪个模型强」
#
# 那是模型的事，不是 harness 的事。本步买的是**「harness 的那些修复在另一族
# 协议上还成立吗」** —— 判据是**机理**，不是分数：
#
#   | 判据                       | 期望                | 为什么它比分数强                       |
#   | 权限 deny 数               | **0**（与 sonnet 同）| #141 那条 144→0 若与模型有关，说明它是   |
#   |                            |                     | 「给某个模型调出来的」，那是最容易被问穿 |
#   |                            |                     | 的质疑                                  |
#   | 撞满 40 轮的题数           | 与 sonnet 同量级     | #138 轮数预算是 harness 侧的            |
#   | 429/降级链是否再次打空     | 无                  | #119/#142                               |
#   | reward                     | **只报，不作判据**   | n=10，且换模型必然换能力 —— 拿它比大小   |
#   |                            |                     | 就跑偏成模型横评了                      |
#
# ⛔ **不许把两个模型的 reward 并排讲成「谁更准」**。样本 n=10、SE≈15pp，
# 而且换模型同时换掉了「能力」这个我们控制不了的变量 —— 那不是 harness 的成绩。
#
# ⛔ **不许拿 deepseek 与 sonnet 比 TTFB**（记忆铁律：禁止跨网关路由汇总 TTFB）。
# `deepseek-v4-pro` 与 `origin-deepseek-v4-pro` 同底层模型同 provider，
# `(ttft−ttfb)/ttft` 一个 86.77% 一个 5.02%，差 17 倍 —— 那是路由缓冲指纹，不是性能。
#
# ## 七项必控变量：本脚本与 sonnet 基线的对齐关系
#
#   | 变量        | 本脚本                          | 对齐方式                        |
#   | 模型        | **deepseek-v4-pro（唯一变量）** | ← 就是要换的那个                |
#   | 网关        | 同一个 shim 程序，不同族实例     | 同一份 gateway.py（B1 已改双族）|
#   | 容器/题目   | terminal-bench-sample@2.0 ×10   | 完全相同                        |
#   | verifier    | 同一套 test.sh                  | 完全相同                        |
#   | 轮数预算    | 40（agent 默认）                | 完全相同                        |
#   | 权限档      | skip（不显式传）                | 完全相同                        |
#   | 并发 -n     | **6**（W0 定档）                | 完全相同                        |
#
# 🔴 **第 8 个变量是 `-n`，它变了**（W0 从 1 改到 6）。所以 **本脚本的结果与此前
# 所有 `-n 1` 的 run 不可并排**。要对照就用 `SID_MODELSWITCH_FAMILY=anthropic`
# 在**同一档**下跑一遍 sonnet 基线，两个 job 背靠背 —— §22.7 五个混淆项里
# 有三个是「上游窗口不同」。
#
# ## 二进制：刻意仍用 30586ff003c9
#
# HEAD(7d4ef4fd) 比它新 7 个提交，但那 7 个**全在 `evals/`**，
# `git diff --name-only 30586ff003c9..HEAD | grep '^packages/\(core\|cli\)/src/'` 为空
# ⇒ 产品代码等价。闸 0 会报「陈旧」，那是**预期**（它只警告不拦）。
set -uo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"

JOB="${1:-modelswitch-$(date +%m%d-%H%M)}"
shift || true
TASK_FILTER=()
for t in "$@"; do TASK_FILTER+=(-i "$t"); done

# ── 协议族：本脚本的开关 ──────────────────────────────────────────────────────
# openai   → deepseek-v4-pro，shim 实例在 4101（B1 改造后支持 openai 族）
# anthropic→ claude-sonnet-5，shim 实例在 4100（同档基线用）
FAMILY="${SID_MODELSWITCH_FAMILY:-openai}"
case "$FAMILY" in
  openai)
    GW_PORT="${SID_MODELSWITCH_PORT:-4101}"
    HARBOR_MODEL="openai/deepseek-v4-pro"
    SHIM_MODEL_NAME="deepseek-v4-pro"
    PROBE_PATH="/v1/chat/completions"
    ;;
  anthropic)
    GW_PORT="${SID_MODELSWITCH_PORT:-4100}"
    HARBOR_MODEL="anthropic/claude-sonnet-5"
    SHIM_MODEL_NAME="claude-sonnet-5-ppchat"
    PROBE_PATH="/v1/messages"
    ;;
  *) echo "⛔ SID_MODELSWITCH_FAMILY 只能是 openai / anthropic，得到 '$FAMILY'"; exit 2 ;;
esac

# 网关地址。`192.168.5.2` = colima host-gateway，⚠️ **不是** 172.17.0.1
# （那是 VM 内的 docker bridge，宿主服务不在上面；实测容器侧 connection refused）。
export SID_HARBOR_GATEWAY_URL="http://192.168.5.2:${GW_PORT}"
# ⚠️ 见头注释「二进制」一节：刻意仍用 30586ff（与 HEAD 产品代码等价）。
export SID_HARBOR_BINARY_ARM64=~/.local/share/sid-harbor-gateway/bins/sid-code-arm64-30586ff003c9
export SID_HARBOR_BINARY_X64=~/.local/share/sid-harbor-gateway/bins/sid-code-x64-30586ff003c9
# provider 由 -m 的前缀段解析（harbor base.py 的 _init_model_info），
# 这里**仍显式写一遍**：`_render_settings` 的回落值是硬编码的 "openai"，
# 只靠解析的话，-m 写错格式时会静默落到 openai 而不是报错。
export SID_HARBOR_PROVIDER="$FAMILY"
export HARBOR_TELEMETRY=0
export PYTHONPATH="$(pwd)"
# 权限档：**不显式传** —— 默认已是 skip 布尔 flag。显式传会撞 __init__ 的互斥校验。

# ⚠️ `-n 6` 是 W0（2026-08-31）实测定的档：nop 三档 -n 1/3/6 全部 0/10 坏掉，
# 墙钟 10.16→4.12→2.44 min。但那 4.17× **全部来自 verifier 的 8.3%**
#（nop 的 agent_execution 恒为 0），所以**真 agent 在 -n 6 下的墙钟收益本轮才第一次被测到**。
# 🔴 首次用真 agent 上 -n 6 **必须盯内存**：W0 那 714MiB 峰值只对 nop 成立
#（nop 不解题、qemu 那两题的 qemu 没真跑起来）。见收尾的内存采样。
COMMON=(-d terminal-bench-sample@2.0 -m "$HARBOR_MODEL" -n "${SID_MODELSWITCH_N:-6}" -k 1
        --registry-path registry.local.json
        --jobs-dir runs --agent-setup-timeout-multiplier 8
        --verifier-timeout-multiplier 6 --agent-timeout-multiplier 4
        --environment-build-timeout-multiplier 3 -y)

# ── 闸 1：verifier 的 uv 下载速率（与 run-permission-switch.sh 同源同判据）─────
#
# 判据 ≥500KB/s。低于它的形态是 verifier 在 103~413s 后放弃、reward 全写 0，
# 而 `sid_subtype` 照样是 success —— 一轮"绿着坏掉"的假数据（2026-08-29 烧掉 $3.12）。
# ⚠️ 速率与 http_code **必须一起取**：URL 打不通时 curl 也吐 speed=0，
# 只判速率会把「探针没连上」误归因成「链路太慢，等等再跑」—— 两者下一步动作相反。
preflight_uv_speed() {
  local min="${SID_HARBOR_UV_MIN_BPS:-500000}" url speed probe code
  url="${SID_HARBOR_UV_URL:-https://github.com/astral-sh/uv/releases/download/0.7.13/uv-x86_64-unknown-linux-gnu.tar.gz}"
  echo "--- 闸 1：verifier 的 uv 下载速率（容器内探，判据 ≥$((min / 1000))KB/s）"
  command -v docker >/dev/null 2>&1 || { echo "    ⚠️ 没有 docker，跳过本闸"; return 0; }
  probe=$(docker run --rm alpine:3 sh -c \
    "apk add -q curl; curl -sL -o /dev/null -m 30 -w '%{speed_download} %{http_code}' '$url'" 2>/dev/null | tr -d '\n')
  speed=$(printf '%s' "$probe" | awk '{print $1}' | cut -d. -f1)
  code=$(printf '%s' "$probe" | awk '{print $2}')
  if [ -z "$speed" ] || ! [ "$speed" -ge 0 ] 2>/dev/null; then
    echo "    ⛔ 探针没拿到速率（容器起不来）——**不放绿**，这与「很慢」同样致命"; return 1
  fi
  if [ "$code" != "200" ]; then
    echo "    ⛔ 探针未取到文件（http=${code:-000}）—— **这不是「链路慢」**，是探针没连上。"
    echo "       别当成「等一会儿就好」去等：查 URL/容器外网/DNS。"; return 1
  fi
  if [ "$speed" -lt "$min" ]; then
    echo "    ⛔ ${speed}B/s < ${min}B/s —— verifier 会放弃并把 reward 全写 0，而 sid_subtype 照样 success。"
    echo "       等链路恢复；确实要跑：SID_HARBOR_SKIP_PREFLIGHT=1"; return 1
  fi
  echo "    ✅ ${speed}B/s ≥ ${min}B/s"; return 0
}

# ── 闸 2：上游错误率 ──────────────────────────────────────────────────────────
#
# 判据：20 连、间隔 3s，非 200 占比 > 20% 即拒绝启动。
# 20% 这条线来自实测：35% 时 10 题里 4 题报废（2 题零调用 / 2 题重试链耗尽），
# 而那 4 题的 reward=0.0 与真的没解出来**逐字节一样**。
#
# ⚠️ **必须用流式探针**（2026-08-30 实测）：同一时刻「max_tokens=8 非流式」5 次全 200，
# 而「流式」5 次只有 3 次 200 —— **闸用错请求形态就会在上游已劣化时报绿**。
# agent 真实发的是 `stream:true` + 大 max_tokens，所以闸必须贴着这个形态探。
#
# ⚠️ **两族的请求体与认证头都不同**，探针必须按族切。用错族的形态是
# 恒 403（shim 的族校验拦住）——而 403 长得像权限问题，会把人引向查 key。
preflight_upstream() {
  local n="${SID_HARBOR_PREFLIGHT_N:-20}" gap="${SID_HARBOR_PREFLIGHT_GAP:-3}" ok=0 codes=""
  local url="${SID_HARBOR_GATEWAY_URL/192.168.5.2/127.0.0.1}"
  echo "--- 闸 2：上游错误率（${n} 连，间隔 ${gap}s，族=${FAMILY}）"
  local body hdr_auth hdr_extra
  if [ "$FAMILY" = "anthropic" ]; then
    hdr_auth="x-api-key: no-auth-dummy"; hdr_extra="anthropic-version: 2023-06-01"
    body='{"model":"claude-sonnet-5","max_tokens":2048,"stream":true,"messages":[{"role":"user","content":"Briefly explain a C/Python polyglot file."}]}'
  else
    hdr_auth="authorization: Bearer no-auth-dummy"; hdr_extra="x-sid-probe: 1"
    body='{"model":"deepseek-v4-pro","max_tokens":2048,"stream":true,"messages":[{"role":"user","content":"Briefly explain a C/Python polyglot file."}]}'
  fi
  PREFLIGHT_STATS_BEFORE=$(curl -s -m 10 "${url}/__stats" 2>/dev/null || true)
  local i c
  for i in $(seq "$n"); do
    # ⚠️ **不许写 `|| echo 000`**（2026-09-01 实测踩到，形态与本仓
    # `grep -c ... || echo 0` 那条完全同源）：流式响应被 `-o /dev/null` 提前断开时，
    # curl **既打印了 `200` 又以非零退出**，`|| echo` 于是追加一个 `000`，
    # 变量变成 `200000` → 判为非 200。冒烟 20 连里 4 次这样，
    # 失败率虚报 **20%**（真值 0%），**恰好压在拒绝阈值上** ——
    # 一个会让健康的上游被判成劣化、从而白等的假红。
    # 正确做法：退出码单独看，`http_code` 只取**末 3 位**。
    c=$(curl -s -o /dev/null -w '%{http_code}' -m 40 -X POST "${url}${PROBE_PATH}" \
      -H 'content-type: application/json' -H "$hdr_auth" -H "$hdr_extra" \
      -d "$body" 2>/dev/null)
    # curl 没打印任何东西（连不上/超时）才算 000。
    c="${c:-000}"; c="${c: -3}"
    [ "$c" = "200" ] && ok=$((ok + 1))
    codes="$codes $c"
    sleep "$gap"
  done
  local fail_pct=$(( (n - ok) * 100 / n ))
  echo "    码:$codes"
  # 网关计数器是**累积值(stock)**，直接当当前健康度用是错的。这里只报**窗口内差值(flow)**，
  # 与上面的探针互为交叉校验：探针看「我发的请求成不成」，__stats 看「网关到上游那一跳成不成」。
  local s1="${PREFLIGHT_STATS_BEFORE:-}" s2
  s2=$(curl -s -m 10 "${url}/__stats" 2>/dev/null || true)
  if [ -n "$s1" ] && [ -n "$s2" ]; then
    python3 - "$s1" "$s2" "$PROBE_PATH" <<'PYSTATS' || true
import json, sys
path = sys.argv[3]
def agg(t):
    try: d = json.loads(t).get("stats", {})
    except Exception: return None
    ok = d.get(f"200_{path}", 0)
    bad = sum(v for k, v in d.items() if k.startswith("upstream_"))
    return ok, bad
a, b = agg(sys.argv[1]), agg(sys.argv[2])
if a and b:
    dok, dbad = b[0] - a[0], b[1] - a[1]
    tot = dok + dbad
    print(f"    网关→上游(本窗口 flow)：成功 {dok} / 失败 {dbad}"
          + (f" → {dbad * 100 // tot}%" if tot > 0 else " → 窗口内无新请求"))
PYSTATS
  fi
  echo "    200=${ok}/${n}  失败率=${fail_pct}%"
  if [ "$fail_pct" -gt 20 ]; then
    echo "    ⛔ 失败率 ${fail_pct}% > 20% —— **拒绝启动**。实测 35% 时 4/10 题报废，"
    echo "       而它们的 reward=0.0 与真的没解出来逐字节一样。等上游恢复。"
    echo "       确实要跑：SID_HARBOR_SKIP_PREFLIGHT=1 bash $0 ..."
    return 1
  fi
  echo "    ✅ 失败率 ${fail_pct}% ≤ 20%"
  return 0
}

# ── 闸 3：网关身份 + **族一致** ────────────────────────────────────────────────
#
# 两件事一起验，因为它们的失败形态都是「403 / 401，但真因是配置指错」：
#
#   a) **是不是我们的 shim**。判据不是「端口连得上」（透传代理也连得上），而是
#      `/__stats` 返回 shim 的那个 JSON 结构。实测区分度：shim 回
#      `{"stats":{...},"upstream_model":...}`；claude-trace 的 `/__stats` 回一个
#      **HTML 页面且 http=200** —— **只看状态码会被骗过**。
#   b) **族对不对**（本脚本新加）。shim 是按 `--model-name` 的 provider 定族的，
#      起错族的形态是**全轮 403**，而 403 长得像权限问题。所以这里主动打一次
#      本族端点，看它是不是 403-族不匹配。
#
# 这道闸**拦**：网关或族指错时整轮数据全是废的，没有任何正当理由继续。
preflight_gateway_identity() {
  local url="${SID_HARBOR_GATEWAY_URL/192.168.5.2/127.0.0.1}"
  echo "--- 闸 3：网关身份 + 族一致（判据=/__stats 结构 + 本族端点非 403）"
  local body
  body=$(curl -s -m 10 "${url}/__stats" 2>/dev/null || true)
  if [ -z "$body" ]; then
    echo "    ❌ ${url}/__stats 无响应 —— shim 没在跑？起它："
    echo "       python3 ~/.local/share/sid-harbor-gateway/gateway.py --port ${GW_PORT} --model-name ${SHIM_MODEL_NAME}"
    return 1
  fi
  if ! printf '%s' "$body" | python3 -c '
import json, sys
try: d = json.load(sys.stdin)
except Exception: sys.exit(1)          # 不是 JSON（claude-trace 会回 HTML）
sys.exit(0 if isinstance(d.get("stats"), dict) and "upstream_model" in d else 1)
' 2>/dev/null; then
    echo "    ❌ ${url}/__stats 有响应但**不是 shim 的结构**（很可能是透传代理，如 :4000 的 claude-trace）"
    echo "       症状预告：占位 token 被原样转上游 → 401，报错长得像「key 不对」"
    return 1
  fi
  local model
  model=$(printf '%s' "$body" | python3 -c 'import json,sys; print(json.load(sys.stdin).get("upstream_model",""))' 2>/dev/null)
  if [ "$model" != "$SHIM_MODEL_NAME" ]; then
    echo "    ❌ shim 的上游是 '${model}'，但本脚本（族=${FAMILY}）要的是 '${SHIM_MODEL_NAME}'"
    echo "       ⚠️ 这**不是**权限问题：起 shim 时 --model-name 给错了，或端口指到了另一个族的实例。"
    return 1
  fi
  # 族一致的**实证**：打一次本族端点。403 = shim 那侧是另一族（B1 加的族校验在拦）。
  # ⚠️ 判 403 而不判 200：此刻可能上游正忙/限流，200 不是必需的，
  # 但 403 一定意味着**族配错**（token 是对的，端点是对的，只有族会拦）。
  # ⚠️ 请求头必须用**数组**，不能用 `$(... && echo -H '...')`：未加引号的命令替换
  # 会被词分割，`'authorization:` `Bearer` `no-auth-dummy'` 变成三个词，多出来的
  # 被 curl 当成**额外的 URL** → 它发 4 次请求、打印 4 个 http_code，拼成
  # `401000000000`（实测冒烟输出）。而头本身也坏了 → 401，长得像「key 不对」。
  local c hdrs=(-H 'content-type: application/json')
  if [ "$FAMILY" = anthropic ]; then
    hdrs+=(-H 'x-api-key: no-auth-dummy' -H 'anthropic-version: 2023-06-01')
  else
    hdrs+=(-H 'authorization: Bearer no-auth-dummy')
  fi
  c=$(curl -s -o /dev/null -w '%{http_code}' -m 30 -X POST "${url}${PROBE_PATH}" \
    "${hdrs[@]}" \
    -d '{"model":"probe","max_tokens":16,"messages":[{"role":"user","content":"hi"}]}' 2>/dev/null)
  c="${c:-000}"; c="${c: -3}"
  if [ "$c" = "403" ]; then
    echo "    ❌ 本族端点 ${PROBE_PATH} 返回 403 —— **族配错了**（shim 上游 ${model} 不是 ${FAMILY} 族）"
    echo "       ⚠️ 403 在这里**不是**权限问题，是配置问题。看 shim 启动横幅的「协议族=」那一行。"
    return 1
  fi
  echo "    ✅ ${url} 是 shim（上游=${model}，族=${FAMILY}，本族端点 http=${c} 非 403）"
  return 0
}

# ── 闸 0：点名的二进制必须含有本次要验的改动（只报警不拦）─────────────────────
#
# 形态：`SID_HARBOR_BINARY_*` 是写死路径，里面嵌着一个 commit12。忘了重编 + 改路径，
# 评测跑的就是**旧字节**，而这件事**不报任何错**：harbor 正常跑完、题都有分、
# build.json 里老老实实写着那个旧 commit（没人会去看）。于是判据全部"不成立"，
# 结论是「修复没生效」，而真相是「修复没进二进制」。
#
# 判据用**产物字节**里内联的 commit，不是路径里那串文件名 —— 文件名是人写的会撒谎。
# ⚠️ 本脚本**预期它报陈旧**（见头注释：那 7 个提交全在 evals/，产品代码等价）。
preflight_binary_freshness() {
  local repo head warned=0 var path c checked=0
  repo="$(git rev-parse --show-toplevel 2>/dev/null || true)"
  [ -n "$repo" ] || { echo "--- 闸 0：不在 git 仓库内，跳过"; return 0; }
  head="$(git -C "$repo" rev-parse HEAD 2>/dev/null || true)"
  [ -n "$head" ] || return 0
  command -v bun >/dev/null 2>&1 || { echo "--- 闸 0：没有 bun，跳过"; return 0; }
  echo "--- 闸 0：二进制新鲜度（判据=产物字节内联 commit，非文件名）"
  for var in SID_HARBOR_BINARY_ARM64 SID_HARBOR_BINARY_X64; do
    eval "path=\${$var:-}"
    [ -n "$path" ] || continue
    checked=$((checked + 1))
    path="${path/#\~/$HOME}"
    [ -f "$path" ] || { echo "    ⛔ $var 指向的文件不存在：$path"; warned=1; continue; }
    c=$(cd "$repo" && bun run scripts/artifact-identity.ts read "$path" 2>/dev/null \
        | tr -d ' \n' | sed -n 's/.*"commit":"\([0-9a-f]\{40\}\)".*/\1/p')
    if [ -z "$c" ]; then
      echo "    ⚠️ $var 读不出内联 commit：$(basename "$path")"; warned=1; continue
    fi
    if [ "$c" = "$head" ]; then
      echo "    ✅ $var = HEAD(${c:0:12})"
    elif git -C "$repo" merge-base --is-ancestor "$c" "$head" 2>/dev/null; then
      local nsrc
      nsrc=$(git -C "$repo" diff --name-only "$c..$head" | grep -cE '^packages/(core|cli)/src/' || true)
      nsrc=${nsrc:-0}
      if [ "$nsrc" = 0 ]; then
        echo "    ✅ $var 落后 HEAD $(git -C "$repo" rev-list --count "$c..$head") 个提交，"
        echo "       但那些提交**零个**触及 packages/{core,cli}/src/ ⇒ **产品代码等价**，可用于本轮"
      else
        echo "    ⛔ $var 是陈旧产物：${c:0:12}，且落后的提交里有 $nsrc 个文件动了产品代码"
        echo "       评测会跑旧字节且**不报任何错**。重编后改本脚本顶部那两行路径。"
        warned=1
      fi
    else
      echo "    ⚠️ $var 的 commit ${c:0:12} 不是 HEAD 的祖先（另一条分支/更新的产物）"; warned=1
    fi
  done
  # ⚠️ **不能在 checked=0 时报绿**：一个文件都没读却报「都对齐」正是「假绿比不做更坏」。
  if [ "$checked" = 0 ]; then
    echo "    ⚠️ 未点名任何 SID_HARBOR_BINARY_*（**本闸未生效**）——二进制由 agent 按 commit 自动发现"
  elif [ "$warned" = 0 ]; then
    echo "    ✅ 已点名的 $checked 个产物可用于本轮"
  fi
  return 0   # 只报警不拦：跑旧版做 A/B 是正当用法
}

preflight_binary_freshness

if [ "${SID_HARBOR_SKIP_PREFLIGHT:-0}" = "1" ]; then
  echo "⚠️ 已显式跳过跑前闸（SID_HARBOR_SKIP_PREFLIGHT=1）——本轮数据可能混入上游故障样本。"
elif ! preflight_gateway_identity; then
  exit 1
elif ! preflight_uv_speed; then
  exit 1
elif ! preflight_upstream; then
  exit 1
fi

# ── 内存采样：真 agent 首次上 -n 6，这是 W0 明确留下的未验项 ──────────────────
#
# W0 那 714 MiB 峰值**只对 nop 成立**（nop 不解题、qemu 那两题的 qemu 没真跑起来）。
# ⚠️ OOMKill 会**伪装成能力失败**：容器被杀 → 题目 reward=0 → 看起来像"没解出来"。
# 所以必须留一份带时间戳的采样，事后能把「0 分」与「那一刻内存打满」对上。
MEM_LOG="runs/${JOB}.mem.log"
mkdir -p runs
( while :; do
    printf '%s ' "$(date +%FT%T)"
    docker stats --no-stream --format '{{.Name}}={{.MemUsage}}' 2>/dev/null | tr '\n' ' '
    echo
    sleep 15
  done ) > "$MEM_LOG" 2>&1 &
MEM_PID=$!
# shellcheck disable=SC2064  # 刻意现在展开 PID
trap "kill $MEM_PID 2>/dev/null || true" EXIT

echo "=== 启动 $(date '+%F %T')  job=$JOB  族=$FAMILY  模型=$HARBOR_MODEL  -n=${SID_MODELSWITCH_N:-6} ${TASK_FILTER[*]:+(只跑 ${TASK_FILTER[*]})} ==="
harbor run "${COMMON[@]}" "${TASK_FILTER[@]+"${TASK_FILTER[@]}"}" \
  -a sid_code_agent:SidCodeAgent --job-name "$JOB"
RUN_RC=$?
echo "=== 结束 $(date '+%F %T') rc=$RUN_RC ==="

kill "$MEM_PID" 2>/dev/null || true
# 内存峰值：把 MiB/GiB 归一到 MiB 再取每行合计的最大值。
if [ -s "$MEM_LOG" ]; then
  echo "--- 内存峰值（容器合计，判据：接近 15.58GiB 即须复核 OOM）"
  python3 - "$MEM_LOG" <<'PYMEM' || true
import re, sys
peak, peak_line = 0.0, ""
for line in open(sys.argv[1], encoding="utf-8", errors="replace"):
    tot = 0.0
    for val, unit in re.findall(r"=\s*([\d.]+)(MiB|GiB|KiB)\s*/", line):
        v = float(val)
        tot += v * (1024 if unit == "GiB" else 1 / 1024 if unit == "KiB" else 1)
    if tot > peak:
        peak, peak_line = tot, line.split()[0]
print(f"    峰值 {peak:.0f} MiB @ {peak_line}（W0 的 nop 基线是 714 MiB，仅供对比）")
PYMEM
  grep -icE 'oom|killed' "$MEM_LOG" >/dev/null 2>&1 && echo "    ⚠️ 采样日志里出现 oom/killed 字样，须复核" || true
fi

# ── 跑完自动嚼一遍轨迹（只读旁路，失败一律不改 RUN_RC）────────────────────────
#
# 为什么接进流程：digest 在第九棒就存在，而**九棒里零次被跑过** ——
# 一个「跑完手工再跑一下」的步骤等于没有这个步骤。价值不在工具，在它被真的执行。
# ⚠️ 逐题落盘再读，**不在管道里边跑边抽字段**：边跑边 grep 时输出被截断/顺序错乱
# 都不会报错，而你以为自己读全了。
digest_all() {
  local run_dir="runs/$JOB" d name home out n_ok=0 n_skip=0
  [ -d "$run_dir" ] || { echo "  ⚠️ 找不到 ${run_dir}，跳过 digest"; return 0; }
  local dig_dir="$run_dir/_digests"
  mkdir -p "$dig_dir" || return 0
  echo "--- digest：逐题嚼轨迹 → $dig_dir/"
  for d in "$run_dir"/*__*/; do
    [ -d "$d" ] || continue
    name=$(basename "$d" | sed 's/__.*//')
    home="$d/agent/sid-home"
    out="$dig_dir/$name.txt"
    # 判据必须是「**有没有会话子目录**」而不是「sessions 目录在不在」：
    # 实测零调用的题 `sessions/` 建出来了但是空的，按后者判会把一个**预期内的
    # 空轨迹**报成 `digest rc≠0`（假红）。
    if ! compgen -G "$home/trajectories/sessions/*/" >/dev/null 2>&1; then
      echo "    - $name: NO_TRAJ（零调用，预期）"; n_skip=$((n_skip + 1)); continue
    fi
    if SID_CONFIG_DIR="$(pwd)/$home" bun "$SID_CODE_REPO/scripts/trace-digest.ts" \
         >"$out" 2>"$out.stderr"; then
      n_ok=$((n_ok + 1))
      # ⚠️ 不能写 `$(grep -c ... || echo 0)`：grep -c 无匹配时**既打印 0 又以 1 退出**，
      # `|| echo 0` 再补一个 0 → 变量变成两行 `0\n0`。用 `|| true` 兜退出码。
      local hi
      hi=$(grep -c '^  \[高\]' "$out" 2>/dev/null || true)
      echo "    ✓ $name: 高危 ${hi:-0} 条 → $(basename "$out")"
    else
      echo "    ⚠️ $name: digest rc≠0（详见 $out.stderr）"
    fi
  done
  echo "  digest 完成：跑成 $n_ok / 跳过 $n_skip"
}

# 仓库根：digest 脚本在 sid-code 仓里，而本脚本 cwd 是 harbor 目录。
# ⚠️ 用 git rev-parse 而不是写死相对层数 —— 目录挪动时后者会静默指向不存在的路径。
SID_CODE_REPO="${SID_CODE_REPO:-$(git rev-parse --show-toplevel 2>/dev/null || true)}"
if [ -z "$SID_CODE_REPO" ] || [ ! -f "$SID_CODE_REPO/scripts/trace-digest.ts" ]; then
  echo "⚠️ 找不到 scripts/trace-digest.ts，跳过 digest（可用 SID_CODE_REPO=... 指定）"
elif ! command -v bun >/dev/null 2>&1; then
  echo "⚠️ 没有 bun，跳过 digest"
else
  digest_all || true
fi

if [ -f progress-permission-switch.py ]; then
  echo "--- 逐题进度（判据见 verifier_health.py）"
  python3 progress-permission-switch.py "runs/$JOB" 2>&1 | sed 's/^/    /' || true
fi

echo
echo "▶ 下一步：跑判据分析（**机理，不是分数**）"
echo "    python3 analyze-model-switch.py runs/$JOB [runs/<sonnet 同档基线 job>]"

exit $RUN_RC
