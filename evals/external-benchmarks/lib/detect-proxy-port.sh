#!/usr/bin/env bash
#
# 宿主 HTTP 代理端口探测 —— **端口一律探测，不许写死**（2026-08-31 教训）
#
# ## 为什么必须有这个文件
#
# 飞鸟云（FlClash）重启/升级会换本地监听端口。写死的端口必然过期，而三处独立的
# 写死点当天同时失效，形态各不相同、没有一处会说"代理端口变了"：
#
#   | 写死点                                   | 症状                                                      |
#   | `~/.gitconfig` 的 github proxy           | `Failed to connect to 127.0.0.1 port 7881 after 0 ms`     |
#   | `~/.local/bin/gh` wrapper                | `gh auth status` 报 **The token in keyring is invalid** —— |
#   |                                          | **假告警**，token 是好的，照提示 refresh 是白折腾          |
#   | VM 内 dockerd 的 systemd drop-in         | `proxyconnect tcp: dial tcp 192.168.5.2:7881: refused`    |
#
# 第二个最坑：它把基础设施故障翻译成了凭据故障，把人引向完全错误的方向。
#
# ## 判据顺序（前一条不成立才落到后一条）
#
#   1. `SID_PROXY_PORT` 显式指定 → 直接用（不探活，人说了算）
#   2. `scutil --proxy` 的 HTTPPort，且该端口**实证可用** → 用它
#   3. 常见备选口逐个实证 → 用第一个可用的
#   4. 都不可用 → 输出空并返回 1，由调用方决定是直连还是报错
#
# ## ⚠️ 判活必须用 CONNECT 实证，不能用 `nc -z`
#
# 本机实测：`nc -z 192.168.5.2 7890` 从 VM 内报 **DEAD**，而同一时刻
# `curl -x http://192.168.5.2:7890 https://registry-1.docker.io/v2/` 得 **401**（隧道建成）。
# `nc -z` 是假阴性。反向的坑也有记录（记忆 `harbor-proxy-*`）：
# `registry-1.docker.io` DNS 被污染后 **TCP 握手成功但 TLS 无响应**，
# 此时 `nc -z` 反而报 OPEN。**两个方向都会骗人，所以一律用 CONNECT 实证。**
#
# 401 也算通：它是上游对"未带凭据"的正常应答，证明请求已经穿过代理到达上游。
# 只有 000（连不上/超时）才算不通。
#
# ## 用法
#
#   . "$(dirname "$0")/../lib/detect-proxy-port.sh"
#   port=$(detect_proxy_port)            # 宿主侧探测（127.0.0.1）
#   port=$(detect_proxy_port 192.168.5.2) # 从别的视角探测（VM/容器看宿主）
#
# 单独跑可自查：bash lib/detect-proxy-port.sh [host]

#: 探测用的目标 URL。选 docker registry 是因为三处写死点里最要紧的那个
#: （dockerd）就是拉镜像用的，探它等于探真实用途。
DETECT_PROBE_URL="${SID_PROXY_PROBE_URL:-https://registry-1.docker.io/v2/}"

#: 常见备选口。7890 是 Clash 系默认 mixed-port；7881 是本机历史值，
#: 留着是为了回滚期间仍能命中，**不是**为了给它特殊地位。
DETECT_FALLBACK_PORTS="${SID_PROXY_FALLBACK_PORTS:-7890 7891 7881 1087 8888 10808}"

# 单个端口的 CONNECT 实证。通返回 0。
proxy_port_usable() {
  local host="$1" port="$2" code
  code=$(curl -s -o /dev/null -w '%{http_code}' -m 8 \
    -x "http://${host}:${port}" "$DETECT_PROBE_URL" 2>/dev/null || echo 000)
  # 任何真实 HTTP 状态码都算通（含 401/403）；000 = 连不上。
  [ -n "$code" ] && [ "$code" != "000" ] && [ "${#code}" -le 3 ]
}

# 探测并在 stdout 打印端口号。找不到则打印空、返回 1。
# 诊断信息一律走 stderr，便于 `port=$(detect_proxy_port)` 直接取值。
detect_proxy_port() {
  local host="${1:-127.0.0.1}" p

  # 判据 1：显式指定，人说了算
  if [ -n "${SID_PROXY_PORT:-}" ]; then
    printf '%s\n' "$SID_PROXY_PORT"
    echo "  [detect-proxy] 用 SID_PROXY_PORT=${SID_PROXY_PORT}（显式指定，未探活）" >&2
    return 0
  fi

  # 判据 2：系统代理设置里的端口（只在 macOS 宿主上有 scutil）
  if command -v scutil >/dev/null 2>&1; then
    local sys_port
    sys_port=$(scutil --proxy 2>/dev/null | awk '/HTTPPort/ {print $3}')
    if [ -n "$sys_port" ] && proxy_port_usable "$host" "$sys_port"; then
      printf '%s\n' "$sys_port"
      echo "  [detect-proxy] ${host}:${sys_port}（来自 scutil，已实证）" >&2
      return 0
    fi
  fi

  # 判据 3：备选口逐个实证
  for p in $DETECT_FALLBACK_PORTS; do
    if proxy_port_usable "$host" "$p"; then
      printf '%s\n' "$p"
      echo "  [detect-proxy] ${host}:${p}（来自备选表，已实证）" >&2
      return 0
    fi
  done

  # 判据 4：没有可用代理。**不猜一个端口回去** ——
  # 猜错的形态是调用方拿到一个死端口，报错却指向业务层。
  echo "  [detect-proxy] ${host} 上未找到可用 HTTP 代理（探了 scutil + ${DETECT_FALLBACK_PORTS} ）" >&2
  return 1
}

# 直接执行时自查
if [ "${BASH_SOURCE[0]}" = "${0}" ]; then
  target="${1:-127.0.0.1}"
  echo "探测目标: ${target}  探测 URL: ${DETECT_PROBE_URL}"
  if port=$(detect_proxy_port "$target"); then
    echo "→ 结果: ${target}:${port}"
  else
    echo "→ 结果: 无可用代理（返回码 1）"
    exit 1
  fi
fi
