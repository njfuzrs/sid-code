#!/usr/bin/env bash
#
# D2：把 cc 臂每题现装（nodejs.org tarball + npm 平台包）换成宿主本地 HTTP
#
# ## 为什么必须有这个文件（2026-09-19 开跑，$0 定位）
#
# A3 开跑 25 分钟：6 容器都在，shim 调用 +0，job 目录零份 claude-code.txt。
# 每题都在 apt → curl Node 22（nodejs.org ~30MB）→ npm i -g @anthropic-ai/claude-code@2.1.252。
# `-n 6` 下带宽争抢，失败形态是：
#
#   curl: (18) HTTP/2 stream not closed / Transferred a partial file
#   curl: (56) OpenSSL SSL_read unexpected eof
#   npm added 1 package 之后 `claude native binary not installed`
#
# 全部发生在 agent_setup，模型零调用。harbor 记进 n_errored，token 空 ⇒
# w3-classify 会删后重跑，但第一轮墙钟被安装失败拉长。08a §3.7。
#
# `native binary not installed` 是**第二条独立失败**：2.1.113 起主包是 dispatcher，
# 真正的 214MB 二进制在 optionalDependencies `@anthropic-ai/claude-code-linux-x64`。
# optional dep 没下到时 npm rc=0（可选嘛），claude --version 才爆。
# ⇒ 镜像必须连平台包一起托，只托主包 = 换了一种假绿。
#
# ## ⚠️ 与 uv 镜像的差别
#
# uv 走 `UV_INSTALLER_GITHUB_BASE_URL`（安装器自己拼路径）+ harbor `--ve`
# （只进 verifier）。cc 的安装发生在 **agent 容器**，`--ve` 进不去。
# 必须 `--ae SID_CC_NODE_MIRROR=... --ae SID_CC_NPM_REGISTRY=...`，
# 由 `claude_code_agent.py` 读这两个变量。
#
# npm 拉包时先取 packument，再按下发的 `dist.tarball`。缓存的 packument 原文
# 指向 registry.npmjs.org —— **不改写 tarball URL，镜像等于没做**。
# 改写在 cc-install-mirror-server.py，start() 的探针会读包体确认。
#
# ## ⚠️ 宿主地址必须是 192.168.5.2，不是 host.docker.internal
#
# 与 uv-mirror.sh 同一条实测：任务镜像里 host.docker.internal 无法解析。
#
# ## 用法
#
#   eval "$(bash lib/cc-install-mirror.sh start)"
#   bash lib/cc-install-mirror.sh stop "$SID_CC_MIRROR_PID"
#
set -uo pipefail
# ⚠️ 全角字符紧跟裸 `$var` 会被 bash 当成变量名的一部分。中文文案里的变量一律 `${var}`。

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

MIRROR_DIR="${SID_CC_MIRROR_DIR:-$HOME/.cache/sid-cc-install-mirror}"
MIRROR_PORT="${SID_CC_MIRROR_PORT:-18078}"
HOST_ADDR="${SID_CC_MIRROR_HOST:-192.168.5.2}"
NODE_VERSION="${SID_CC_NODE_VERSION:-22.20.0}"
CC_VERSION="${SID_CC_VERSION:-2.1.252}"
# 容器是 linux/amd64。darwin/win32 不托（用不上，还各 200MB+）。
# musl 是 alpine 镜像的 optional dep；sample 里有过 qemu-alpine-ssh，缺了就是
# 另一道 `native binary not installed`。多托一份，别再按题集猜。
CC_PACKAGES="${SID_CC_MIRROR_PACKAGES:-@anthropic-ai/claude-code @anthropic-ai/claude-code-linux-x64 @anthropic-ai/claude-code-linux-x64-musl}"

log() { echo "    $*" >&2; }

node_file() {
  echo "node-v${NODE_VERSION}-linux-x64.tar.xz"
}

# 预热：Node tarball + 每个 npm 包的 version document + tarball。已存在且非空就跳过。
warm() {
  local ok=1 dest rel pkg safe tarball_url tarball_name meta
  mkdir -p "$MIRROR_DIR/meta" "$MIRROR_DIR/tarballs"

  dest="$MIRROR_DIR/$(node_file)"
  if [ -s "$dest" ]; then
    log "✅ 已缓存 Node ${NODE_VERSION}（$(wc -c < "$dest" | tr -d ' ') B）"
  else
    log "→ 下载 Node ${NODE_VERSION} linux-x64 ..."
    if curl -fsSL -m 180 -o "$dest.part" \
        "https://nodejs.org/dist/v${NODE_VERSION}/$(node_file)" \
        && [ -s "$dest.part" ]; then
      mv "$dest.part" "$dest"
      log "  ✅ Node ${NODE_VERSION} → $(wc -c < "$dest" | tr -d ' ') B"
    else
      rm -f "$dest.part"
      log "  ⛔ Node ${NODE_VERSION} 下载失败"
      ok=0
    fi
  fi
  # 半个 tarball 比没有更坏：curl 200 但 tar -xJf 失败，报错指向"包损坏"。
  if [ -s "$dest" ]; then
    local nbytes
    nbytes="$(wc -c < "$dest" | tr -d ' ')"
    if [ "$nbytes" -lt 10000000 ]; then
      log "  ⛔ Node tarball 只有 ${nbytes} B（<10MB）—— 当半截，删掉重下"
      rm -f "$dest"
      ok=0
    fi
  fi

  for pkg in $CC_PACKAGES; do
    safe="$(printf '%s' "$pkg" | sed 's/\//_/g')"
    meta="$MIRROR_DIR/meta/${pkg}.json"
    mkdir -p "$(dirname "$meta")"
    if [ ! -s "$meta" ]; then
      log "→ 取 ${pkg}@${CC_VERSION} packument ..."
      # 只要 version document，不要全量 packument（521 个版本）。
      if ! curl -fsSL -m 60 -o "$meta.part" \
          "https://registry.npmjs.org/${pkg}/${CC_VERSION}" \
          || ! [ -s "$meta.part" ]; then
        rm -f "$meta.part"
        log "  ⛔ ${pkg}@${CC_VERSION} packument 下载失败"
        ok=0
        continue
      fi
      mv "$meta.part" "$meta"
    fi
    tarball_url="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["dist"]["tarball"])' "$meta")"
    tarball_name="$(basename "$tarball_url")"
    dest="$MIRROR_DIR/tarballs/$tarball_name"
    if [ -s "$dest" ]; then
      log "✅ 已缓存 ${pkg} tarball（$(wc -c < "$dest" | tr -d ' ') B）"
      continue
    fi
    log "→ 下载 ${pkg} tarball ..."
    if curl -fsSL -m 300 -o "$dest.part" "$tarball_url" && [ -s "$dest.part" ]; then
      mv "$dest.part" "$dest"
      log "  ✅ ${pkg} → $(wc -c < "$dest" | tr -d ' ') B"
    else
      rm -f "$dest.part"
      log "  ⛔ ${pkg} tarball 下载失败"
      ok=0
      continue
    fi
    local tb
    tb="$(wc -c < "$dest" | tr -d ' ')"
    # 主包 ~几十 KB；平台包是 214MB 解压的原生二进制，压缩后也远大于 1MB。
    # 主包文件名不含 linux-，平台包含。
    if printf '%s' "$tarball_name" | grep -q 'linux-'; then
      if [ "$tb" -lt 1000000 ]; then
        log "  ⛔ 平台包 ${tarball_name} 只有 ${tb} B（<1MB）—— 当半截"
        rm -f "$dest"
        ok=0
      fi
    fi
  done
  [ "$ok" = "1" ]
}

# 探针：packument 必须 200，且 tarball URL 指向我们，不是 registry.npmjs.org。
# 只判 http_code 会绿着失效（packument 原样 200，npm 仍打外网）。
packument_is_rewritten() {
  local url="$1"
  python3 - "$url" <<'PY'
import json, sys, urllib.request
url = sys.argv[1]
try:
    with urllib.request.urlopen(url, timeout=5) as r:
        body = r.read()
        code = r.status
except Exception as e:
    print(f"fetch_fail {e}", file=sys.stderr)
    sys.exit(1)
if code != 200:
    sys.exit(1)
doc = json.loads(body)
# 可能是 packument（versions）或 version document（dist）
if "versions" in doc:
    versions = doc["versions"]
    if not versions:
        sys.exit(1)
    dist = next(iter(versions.values())).get("dist") or {}
else:
    dist = doc.get("dist") or {}
tarball = dist.get("tarball") or ""
if "registry.npmjs.org" in tarball:
    print("tarball still points at registry.npmjs.org", file=sys.stderr)
    sys.exit(1)
if "/npm/" not in tarball:
    print(f"tarball not rewritten: {tarball}", file=sys.stderr)
    sys.exit(1)
sys.exit(0)
PY
}

start() {
  if ! warm; then
    log "⛔ 预热失败 —— **不要**带着半套镜像去跑 A3：缺的那个 optional dep"
    log "   会让 npm rc=0 + claude native binary not installed，与 08a §3.7 逐字节同形。"
    return 1
  fi
  local public_base="http://${HOST_ADDR}:${MIRROR_PORT}"
  local node_url="http://127.0.0.1:${MIRROR_PORT}/$(node_file)"
  local pack_url="http://127.0.0.1:${MIRROR_PORT}/npm/@anthropic-ai%2fclaude-code"
  local pid=""
  if curl -fsS -o /dev/null -m 3 "$node_url" 2>/dev/null \
      && packument_is_rewritten "$pack_url"; then
    log "✅ 端口 ${MIRROR_PORT} 上已有可用 cc 安装镜像，复用"
  else
    python3 "$SCRIPT_DIR/cc-install-mirror-server.py" \
      "$MIRROR_PORT" "$MIRROR_DIR" "$public_base" \
      >"$MIRROR_DIR/http.log" 2>&1 &
    pid=$!
    sleep 1.5
    if ! curl -fsS -o /dev/null -m 5 "$node_url" 2>/dev/null; then
      log "⛔ 服务起了但取不到 $(node_file) —— 不放绿"
      kill "$pid" 2>/dev/null || true
      return 1
    fi
    if ! packument_is_rewritten "$pack_url"; then
      log "⛔ packument 的 dist.tarball 仍指向 registry.npmjs.org（或取不到）—— 不放绿"
      kill "$pid" 2>/dev/null || true
      return 1
    fi
    log "✅ cc 安装镜像已起（pid=${pid}，目录 ${MIRROR_DIR}）"
  fi
  if command -v docker >/dev/null 2>&1; then
    local code
    code=$(docker run --rm --platform linux/amd64 alpine:3 sh -c \
      "apk add -q curl >/dev/null 2>&1; curl -s -o /dev/null -w '%{http_code}' -m 10 \
       'http://${HOST_ADDR}:${MIRROR_PORT}/$(node_file)'" 2>/dev/null | tr -d '\n')
    code="${code:-000}"; code="${code: -3}"
    if [ "$code" != "200" ]; then
      log "⛔ 容器内取不到 Node tarball（http=${code}）—— 宿主可达不代表容器可达，不放绿"
      [ -n "$pid" ] && kill "$pid" 2>/dev/null
      return 1
    fi
    log "✅ 容器内实测可达（http=200 @ ${HOST_ADDR}:${MIRROR_PORT}）"
  fi
  echo "export SID_CC_NODE_MIRROR='${public_base}'"
  echo "export SID_CC_NPM_REGISTRY='${public_base}/npm'"
  echo "export SID_CC_MIRROR_PID='${pid}'"
}

stop() {
  local pid="${1:-}"
  [ -n "$pid" ] && kill "$pid" 2>/dev/null && log "cc 安装镜像已停（pid=${pid}）"
  return 0
}

case "${1:-start}" in
  start) start ;;
  warm)  warm ;;
  stop)  stop "${2:-}" ;;
  *) echo "用法: $0 {start|warm|stop <pid>}" >&2; exit 2 ;;
esac
