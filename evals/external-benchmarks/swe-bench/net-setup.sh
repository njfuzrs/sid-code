#!/usr/bin/env bash
#
# SWE-bench 阶段 A —— 防作弊网络设施（幂等）
#
# 事实源：`接入计划.md` §4.1 ①②（preflight 前两项断言的被测对象）
#
# ## 这个脚本解决什么
#
# preflight ①② 断言的是「运行期隔离 network + allowlist 代理」与「构建期/运行期分离」，
# 但**这套设施本身在仓库里原先不存在**（`grep -rln allowlist` 只命中方案文档和 preflight.ts）。
# 断言一个不存在的东西，preflight 永远 fail —— 所以必须先有它。
#
# ## ⚠️ 一个方案文档没点破的矛盾（这是本脚本存在的核心理由）
#
# 「隔离 network」按 docker 的定义（`--internal`）是**完全不能出网**的：
# 不只是拦住 github.com，连你们的模型网关也一起拦住了。
# 所以「隔离 network + allowlist 只放 model API」**不可能只靠给 network 加规则实现** ——
# `docker network` 没有 allowlist 这种东西。
#
# 唯一可行形态是一个**双挂载的代理容器**：
#
#     ┌──────────────────────┐         ┌────────────────┐
#     │ agent 容器            │         │ 代理容器        │
#     │ (仅接 internal 网)     │────────▶│ 接 internal 网  │
#     │ 无法直连任何外部地址    │  HTTP   │ + 接 bridge 网  │──────▶ 只放行网关域名
#     └──────────────────────┘  代理    └────────────────┘        其余一律 403
#
# 也就是说：agent 那一侧真的一个包都出不去，唯一出口是代理，而代理只认 allowlist。
# 这比「给 network 配规则」强：**agent 拿不到任何绕过的手段**，
# 因为它的网络栈里根本没有默认路由。
#
# ## 为什么 allowlist 只放网关域名，不放 github/pypi
#
# 实测佐证（方案 §5.1）：**Opus 4 有 25% 的 rollout 试图用 `git log` 找答案**。
# 放开 github.com 就等于把上游修复摆在 agent 面前，此后每一次「解出」都不是自己挣的。
# 而被测代码库与依赖**已经在镜像里**（官方 per-instance 镜像自带 conda testbed），
# 运行期不需要装任何东西 —— 这也是为什么构建期必须放开、运行期必须收紧。
#
# ## 用法
#
#   bash evals/external-benchmarks/swe-bench/net-setup.sh              # 建
#   bash evals/external-benchmarks/swe-bench/net-setup.sh --check      # 只查
#   bash evals/external-benchmarks/swe-bench/net-setup.sh --teardown   # 拆
#
# 需要先 export DOCKER_HOST（见 setup-env.sh 的输出）。

set -euo pipefail

RUN_NET="sid-swebench-run"     # agent 运行期：internal，一个包都出不去
BUILD_NET="sid-swebench-build" # 镜像构建期：非 internal，要能到 PyPI/conda/GitHub
PROXY_NAME="sid-swebench-proxy"
PROXY_IMAGE="sid-swebench-proxy:local" # 本地构建，见下方「代理镜像本地构建」注释
PROBE_IMAGE="sid-swebench-probe:local" # 连通性探测用（自带 curl），同样本地构建
PROXY_PORT=8080

# allowlist：**只放模型网关**。
# 从 settings.json 的 base_url 里现取，而不是在这里写死一串域名 ——
# 写死的话换 provider 就会静默失效（agent 连不上模型，但报错长得像模型问题）。
ALLOWLIST_DEFAULT="uniapi.ruijie.com.cn"

# ## SWE_ALLOWLIST：显式指定要放开的网关（空格分隔），优先于 settings.json 现取
#
# 为什么需要这个覆盖口：settings.json 里通常配了**很多个** provider
# （本机实测 4 个 host、20+ 个 model 条目），而一次 run 只用其中一个。
# 全都放开有两个坏处：
# 1. **放开面比需要的大** —— allowlist 越长，防作弊的收窄程度越低；
# 2. **连通性门禁会被无关的 host 拖红** —— 实测 `api.deepseek.com` 在本网络下
#    经 tinyproxy 隧道超时（隧道建得起来但数据不通，代理日志里是
#    `Established connection` 后 20s `Closed connection`），
#    而本次真正要用的 `code.ppchat.vip` 是 200。
#    只探第一个 host 时，排序后恰好是 deepseek，于是**门禁红在一个本次用不到的网关上**。
#
# 用法：`SWE_ALLOWLIST="code.ppchat.vip" bash net-setup.sh --up`
# 建议与 `SC_BASE_URL` 保持一致 —— 两者不一致时 agent 连不上模型，
# 而症状长得像模型问题（超时/空回复），排查方向会跑偏。
ALLOWLIST_OVERRIDE="${SWE_ALLOWLIST:-}"

ok() { printf '  \033[32m✅\033[0m %s\n' "$1"; }
bad() { printf '  \033[31m❌\033[0m %s\n' "$1"; }
info() { printf '  \033[36m→\033[0m %s\n' "$1"; }

MODE="setup"
case "${1:-}" in
--check) MODE="check" ;;
--teardown) MODE="teardown" ;;
esac

if ! docker info >/dev/null 2>&1; then
  bad "docker daemon 不可达。先跑 setup-env.sh 并 export DOCKER_HOST"
  exit 1
fi

# ─────────────────────────────────────────────────────────────────────────────
# teardown
# ─────────────────────────────────────────────────────────────────────────────
if [[ "$MODE" == "teardown" ]]; then
  echo "拆除防作弊网络设施"
  docker rm -f "$PROXY_NAME" >/dev/null 2>&1 && ok "代理容器已删" || info "代理容器不存在"
  docker rmi "$PROXY_IMAGE" >/dev/null 2>&1 && ok "代理镜像已删" || info "代理镜像不存在"
  docker rmi "$PROBE_IMAGE" >/dev/null 2>&1 && ok "探测镜像已删" || info "探测镜像不存在"
  for n in "$RUN_NET" "$BUILD_NET"; do
    docker network rm "$n" >/dev/null 2>&1 && ok "network $n 已删" || info "network $n 不存在"
  done
  exit 0
fi

FAILED=0
echo "防作弊网络设施（run=$RUN_NET / build=$BUILD_NET / proxy=$PROXY_NAME:${PROXY_PORT}）"
echo

# 取 allowlist：SWE_ALLOWLIST 优先，否则从 settings.json 的 base_url 抽 host。
# **不打印任何 key**。
ALLOWLIST="$ALLOWLIST_DEFAULT"
SETTINGS="${SID_CONFIG_DIR:-$HOME/.sid-code}/settings.json"
if [[ -n "$ALLOWLIST_OVERRIDE" ]]; then
  ALLOWLIST="$ALLOWLIST_OVERRIDE"
  info "allowlist（SWE_ALLOWLIST 显式指定）: $ALLOWLIST"
elif [[ -f "$SETTINGS" ]]; then
  hosts="$(python3 -c "
import json,re,sys
try:
    d=json.load(open('$SETTINGS'))
except Exception:
    sys.exit(0)
out=set()
for m in d.get('availableModels',[]):
    u=m.get('base_url') or m.get('baseUrl') or ''
    if u: out.add(re.sub(r'https?://','',u).split('/')[0])
print(' '.join(sorted(out)))
" 2>/dev/null || true)"
  [[ -n "$hosts" ]] && ALLOWLIST="$hosts"
  info "allowlist（从 settings.json 的 base_url 现取）: $ALLOWLIST"
else
  info "allowlist（内置默认）: $ALLOWLIST"
fi

# ─────────────────────────────────────────────────────────────────────────────
# 1. 两个 network
# ─────────────────────────────────────────────────────────────────────────────
echo "[1/3] docker network"

# ⚠️ 这里的 `tr -d` 与显式判空都是必须的，别简化。
# 实测：network 不存在时 `docker network inspect` 会先往 **stdout 打一个空行** 再失败，
# 于是朴素写法 `inspect ... || echo missing` 得到的是 `"\nmissing"` ——
# 既不等于 `true` 也不等于 `missing`，一路掉到 else 分支，报成
# 「network 存在但 internal=false」。**一个不存在的 network 被诊断成配置错误**，
# 而提示还叫人去 --teardown 重建，越修越偏。
net_internal() {
  local out
  out="$(docker network inspect -f '{{.Internal}}' "$1" 2>/dev/null | tr -d '[:space:]')"
  if [[ -z "$out" ]]; then echo "missing"; else echo "$out"; fi
}

# 运行期：必须 internal=true
case "$(net_internal "$RUN_NET")" in
true) ok "$RUN_NET 已存在且 internal=true" ;;
missing)
  if [[ "$MODE" == "check" ]]; then
    bad "$RUN_NET 不存在"
    FAILED=1
  else
    docker network create --internal "$RUN_NET" >/dev/null
    ok "$RUN_NET 已建（--internal）"
  fi
  ;;
*)
  bad "$RUN_NET 存在但 internal=false —— 非 internal 的 network 照样出网，等于没隔离。先 --teardown 再重建"
  FAILED=1
  ;;
esac

# 构建期：必须 internal=false（本地构建镜像要装 PyPI/conda 依赖）
case "$(net_internal "$BUILD_NET")" in
false) ok "$BUILD_NET 已存在且 internal=false" ;;
missing)
  if [[ "$MODE" == "check" ]]; then
    bad "$BUILD_NET 不存在"
    FAILED=1
  else
    docker network create "$BUILD_NET" >/dev/null
    ok "$BUILD_NET 已建（可出网）"
  fi
  ;;
*)
  bad "$BUILD_NET 是 internal=true —— 本地重建镜像装不上依赖。先 --teardown 再重建"
  FAILED=1
  ;;
esac

# ─────────────────────────────────────────────────────────────────────────────
# 2. allowlist 代理容器
# ─────────────────────────────────────────────────────────────────────────────
echo "[2/3] allowlist 代理"

proxy_running() { docker ps --filter "name=^${PROXY_NAME}$" --filter "status=running" -q | grep -q .; }

# ## ⚠️ 「容器在跑」不等于「它的 allowlist 是你要的那份」
#
# 实测踩到（2026-08-25）：先用 settings.json 现取的 4 个 host 起了代理，
# 之后改用 `SWE_ALLOWLIST="code.ppchat.vip"` 再跑 `--up`，
# 因为容器还在跑，**这一步直接跳过了重建**，容器里的 filter 仍是那 4 行。
# 于是 `--up` 打印「allowlist（SWE_ALLOWLIST 显式指定）: code.ppchat.vip」、
# 连通性探测也 PASS —— **一片绿，但实际放开的面比声明的大 3 个网关**。
#
# 这正是「绿了但没测到」那一类：门禁只验证了「声明里那个能通」，
# 没验证「声明外的都拦着」。防作弊设施上这个差别是致命的 ——
# 多放开的那几个 host 里任何一个能到 GitHub 镜像，分数就不可信。
#
# 所以判据必须是**容器里的 filter 内容 == 本次期望的 filter 内容**，
# 不一致就重建（重建很便宜，几秒）。
expected_filter() {
  local h
  for h in $ALLOWLIST; do
    printf '(^|\\.)%s$\n' "$(echo "$h" | sed 's/\./\\./g')"
  done
}

proxy_filter_matches() {
  local have want
  have="$(docker exec "$PROXY_NAME" cat /etc/tinyproxy/filter 2>/dev/null || true)"
  want="$(expected_filter)"
  [[ -n "$have" && "$have" == "$want" ]]
}

if proxy_running && proxy_filter_matches; then
  ok "代理容器已在运行，且 allowlist 与本次期望一致"
elif [[ "$MODE" == "check" ]]; then
  # check 模式不改状态，只报告。两种失败要分开说 ——
  # 「没跑」和「跑着但名单不对」的处置不同，混成一句会让人只去 --up 而不看名单。
  if proxy_running; then
    bad "代理在跑，但 allowlist 与期望不一致 —— 放开面可能比声明的大，分数不可信"
    bad "  容器内: $(docker exec "$PROXY_NAME" cat /etc/tinyproxy/filter 2>/dev/null | tr '\n' ' ')"
    bad "  本次期望: $(expected_filter | tr '\n' ' ')"
    bad "  跑一次 net-setup.sh --up 重建"
  else
    bad "代理容器未运行"
  fi
  FAILED=1
else
  if proxy_running; then
    info "代理在跑但 allowlist 与本次期望不一致 —— 重建（否则放开面比声明的大）"
    info "  容器内: $(docker exec "$PROXY_NAME" cat /etc/tinyproxy/filter 2>/dev/null | tr '\n' ' ')"
    info "  本次期望: $(expected_filter | tr '\n' ' ')"
  fi
  docker rm -f "$PROXY_NAME" >/dev/null 2>&1 || true
  info "起 tinyproxy（allowlist 模式）..."

  # tinyproxy 的 Allow/ConnectPort 语义：
  #   - `Allow` 控制**谁能用这个代理**（客户端侧）
  #   - `Filter` + FilterDefaultDeny 控制**能访问哪些目标**（这才是 allowlist）
  # 两者都要配：只配前者的话，任何能连上代理的容器可以访问任意目标。
  # ⚠️ 配置目录**必须落在 $HOME 下**，不能用 `mktemp -d`。
  # 实测：colima 只把 `$HOME` 以 virtiofs 共享进 VM（`mount | grep virtiofs` 只有一条
  # `mount0 on /Users/<me>`），而 macOS 的 `mktemp -d` 给的是 `/var/folders/...`。
  # 那个路径在 guest 里**也存在**（是 guest 自己的 /var/folders），于是 docker 以为
  # 挂载源在，实际是个空目录 —— 报错长这样，完全不提示是「路径没共享」：
  #
  #     error mounting ".../tinyproxy.conf" to rootfs at "/etc/tinyproxy/tinyproxy.conf":
  #     create mountpoint ...: not a directory
  #
  # 这个报错会把人引向「镜像里 /etc/tinyproxy 不是目录」这条错路（实测镜像里它是好的）。
  cfg_dir="$HOME/.cache/sid-code/swebench-proxy"
  rm -rf "$cfg_dir" && mkdir -p "$cfg_dir"
  {
    echo "Port $PROXY_PORT"
    echo "Listen 0.0.0.0"
    echo "Timeout 600"
    echo "MaxClients 100"
    # 允许来自 docker 私有网段的客户端（agent 容器）
    echo "Allow 10.0.0.0/8"
    echo "Allow 172.16.0.0/12"
    echo "Allow 192.168.0.0/16"
    # ⚠️ allowlist 的关键三行：默认拒绝 + 只放名单 + 名单按域名匹配
    echo "Filter \"/etc/tinyproxy/filter\""
    echo "FilterDefaultDeny Yes"
    echo "FilterExtended On"
    # HTTPS 走 CONNECT，必须显式放行 443，否则模型 API 全不通
    echo "ConnectPort 443"
    echo "DisableViaHeader Yes"
  } >"$cfg_dir/tinyproxy.conf"

  # filter 文件：一行一个正则（FilterExtended On = ERE）。锚定到域名结尾，
  # 防 `evil-uniapi.ruijie.com.cn.attacker.com` 这类后缀欺骗。
  : >"$cfg_dir/filter"
  for h in $ALLOWLIST; do
    printf '(^|\\.)%s$\n' "$(echo "$h" | sed 's/\./\\./g')" >>"$cfg_dir/filter"
  done

  # ⚠️ 代理镜像**本地构建**，不用现成的第三方镜像。两条实测理由：
  #   1. `monokal/tinyproxy`（最常被引用的那个）**只有 amd64**，在 arm64 上跑要走模拟；
  #   2. 更硬的是它的镜像里**没有 `/etc/tinyproxy/` 目录**，挂配置文件直接失败：
  #      `error mounting ... create mountpoint ...: not a directory`。
  # 而 `apk add tinyproxy` 本地构建实测 **2 秒**、原生 arm64、且目录结构可控 ——
  # 一个 2 秒能自己搭好的东西，不值得为它引入一个不可控的外部依赖。
  # （这也顺带避免了「评测设施依赖一个无人维护的镜像」这种长期风险。）
  docker build -q -t "$PROXY_IMAGE" -f - "$cfg_dir" >/dev/null <<'DOCKERFILE'
FROM alpine:3.20
RUN apk add --no-cache tinyproxy
ENTRYPOINT ["tinyproxy", "-d", "-c", "/etc/tinyproxy/tinyproxy.conf"]
DOCKERFILE

  docker run -d --name "$PROXY_NAME" \
    --network "$BUILD_NET" \
    -v "$cfg_dir/tinyproxy.conf:/etc/tinyproxy/tinyproxy.conf:ro" \
    -v "$cfg_dir/filter:/etc/tinyproxy/filter:ro" \
    -p "127.0.0.1:$PROXY_PORT:$PROXY_PORT" \
    "$PROXY_IMAGE" >/dev/null

  # 把代理**同时**挂到 internal 网上 —— 这是整套设计的关键一步：
  # agent 在 internal 网里没有默认路由，唯一能到达的就是这个双挂载的代理。
  docker network connect "$RUN_NET" "$PROXY_NAME" >/dev/null
  sleep 3
  if proxy_running; then
    ok "代理已起，且双挂载（$BUILD_NET + ${RUN_NET}）"
  else
    bad "代理起不来：$(docker logs "$PROXY_NAME" 2>&1 | tail -3)"
    FAILED=1
  fi
fi

# ─────────────────────────────────────────────────────────────────────────────
# 3. 连通性实测（这一步才是真判据）
# ─────────────────────────────────────────────────────────────────────────────
echo "[3/3] 连通性实测"

if ! proxy_running; then
  bad "代理未运行，跳过连通性实测"
  FAILED=1
else
  proxy_ip="$(docker inspect -f "{{(index .NetworkSettings.Networks \"$RUN_NET\").IPAddress}}" "$PROXY_NAME" 2>/dev/null || echo "")"
  if [[ -z "$proxy_ip" ]]; then
    bad "取不到代理在 $RUN_NET 上的 IP"
    FAILED=1
  else
    ok "代理在 $RUN_NET 上的地址: $proxy_ip:$PROXY_PORT"

    # ⚠️ 探测镜像也**本地构建**，不用 `curlimages/curl`。两个实测理由：
    #   1. 拉外部镜像在本网络不稳（官方 per-instance 镜像连续两次 `unexpected EOF`）；
    #   2. 更关键的是**不能用 alpine 自带的 wget 代替 curl**：wget 走代理时发的是
    #      `GET https://... HTTP/1.1` 到 80 端口，而不是 HTTPS 该用的 CONNECT，
    #      于是**名单内的域名也会失败**。当时三个 URL 全 fail，看着像 allowlist 配错，
    #      实际是探测工具用错了 —— tinyproxy 日志才是真相：
    #        `Established connection to host "api.deepseek.com"`（名单内，通了）
    #        `Proxying refused on filtered domain "github.com"`（名单外，拦了）
    #      教训：**探测工具本身会撒谎，要拿被测方的日志交叉验证。**
    docker build -q -t "$PROBE_IMAGE" -f - . >/dev/null <<'DOCKERFILE'
FROM alpine:3.20
RUN apk add --no-cache curl
DOCKERFILE

    # ⚠️ 这三条实测是本脚本的核心产出。**「拓扑对」不等于「行为对」**：
    # preflight ① 只能验 network 是 internal、参数给了，验不到代理真的在按名单转发。
    probe() { # $1=描述 $2=期望(ok|deny) $3=url
      # ⚠️ `|| true` 是必须的：被拦的目标会让 curl 以非 0 退出，而脚本开了 `set -e` ——
      # 少了它，**第一个被成功拦截的目标就会让整个脚本静默退出**（实测 exit 56，
      # 输出停在上一条 ✅，看起来像「跑完了」）。也就是说：拦截生效反而中断了验证。
      local out
      out="$(docker run --rm --network "$RUN_NET" \
        -e "http_proxy=http://$proxy_ip:$PROXY_PORT" \
        -e "https_proxy=http://$proxy_ip:$PROXY_PORT" \
        "$PROBE_IMAGE" curl -s -o /dev/null -w '%{http_code}' \
        --max-time 20 "$3" 2>/dev/null | tail -c 3 || true)"
      # ⚠️ 不能写 `curl ... || echo "000"`：curl 失败时**自己已经打了 `000`**（-w 的结果）
      # 且退出码非 0，`||` 再补一个就得到 `000000` —— 那既不等于 "000" 也不等于任何码，
      # 于是「被拦」会被判成「没拦住」，一条**正确的拦截**被报成安全失效。
      [[ -z "$out" ]] && out="000"
      if [[ "$2" == "ok" ]]; then
        # 名单内：只要不是代理自己拒绝（403/000）就算通
        if [[ "$out" != "403" && "$out" != "000" ]]; then
          ok "$1（HTTP ${out}）"
        else
          bad "$1 —— 期望可达，实得 $out"
          FAILED=1
        fi
      else
        if [[ "$out" == "403" || "$out" == "000" ]]; then
          ok "$1（已拦，${out}）"
        else
          bad "$1 —— 期望被拦，实得 HTTP ${out}。**allowlist 没生效，分数不可信**"
          FAILED=1
        fi
      fi
    }

    # ⚠️ **遍历全部 allowlist host，不能只探第一个。**
    # 旧写法只探 `$allowed_host`（= 排序后的第一个），有两个失败形态：
    # ① 第一个恰好不可达 → 门禁红在一个本次用不到的网关上
    #    （实测 `api.deepseek.com` 经 tinyproxy 隧道超时，而本次真正用的
    #    `code.ppchat.vip` 是 200）；
    # ② 第一个可达但**本次要用的那个**不可达 → 门禁绿、run 起来才发现
    #    agent 连不上模型，而症状长得像模型问题。②比①危险得多，
    #    因为它是「绿了但没测到」。
    for h in $ALLOWLIST; do
      probe "名单内可达: $h" ok "https://$h/"
    done
    # github 是这套设施最要防的目标：放开它 = agent 能读上游修复
    probe "github.com 被拦" deny "https://github.com/"
    probe "pypi.org 被拦" deny "https://pypi.org/simple/"

    # 不走代理必须完全不通 —— 证明 agent 侧没有任何绕过路径
    direct="$(docker run --rm --network "$RUN_NET" "$PROBE_IMAGE" \
      curl -s -o /dev/null -w '%{http_code}' --max-time 10 "https://github.com/" 2>/dev/null | tail -c 3 || true)"
    [[ -z "$direct" ]] && direct="000"
    if [[ "$direct" == "000" ]]; then
      ok "不设代理时直连不通（internal 网无默认路由）"
    else
      bad "不设代理竟能直连（HTTP ${direct}）—— 隔离失效"
      FAILED=1
    fi
  fi
fi

echo
if [[ $FAILED == 0 ]]; then
  printf '\033[32m网络设施就绪。\033[0m preflight ①② 现在应为 pass：\n\n'
  echo "  bun run evals/external-benchmarks/swe-bench/preflight.ts \\"
  echo "    --run-network $RUN_NET --build-network $BUILD_NET \\"
  echo "    --proxy http://127.0.0.1:$PROXY_PORT"
  exit 0
else
  printf '\033[31m网络设施未就绪\033[0m（上面标 ❌ 的项）。\n'
  exit 1
fi
