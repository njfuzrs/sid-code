#!/usr/bin/env bash
#
# E1：把 verifier 的 uv tarball 下载从 github.com 换成宿主本地 HTTP
#
# ## 为什么必须有这个文件（2026-09-02 定位，$0）
#
# `runs/modelswitch-base` 里 **5/10 题的 reward=0 是假 0** —— verifier 根本没判分。
# 05 号文档把真因写成「QEMU 下 `/proc/self/exe` 坏 → uv 判不出位宽」，**这是错的**，
# 三条各自独立的证伪：
#
#   | 判据                  | 事实                                                              |
#   | `unknown platform bitness` 的分布 | 两个基线 **10/10 题全都出现**，含 verifier 正常判分的题 ⇒ 不预测失败 |
#   | 同夜同 QEMU 的对照    | `modelswitch-ds`（早 8h、无 Rosetta）**verifier 10/10 真判分、uv 失败 0 题** |
#   | stdout 里真正的致命行 | 一律是 curl：`Failed to connect to github.com port 443 after 75015 ms` |
#
# 位宽判定失败**不致命**：安装器里 `get_bitness` 的 `err()` 虽然 `exit 1`，但它跑在
# `$(...)` 子 shell 里，只杀子 shell —— 所以日志里紧跟着一行 `[: Illegal number:` 就继续走了，
# 且**目标三元组仍然选对**（下一行就是 `downloading uv 0.7.13 x86_64-unknown-linux-gnu`）。
#
# ⇒ 真凶是**下 17.8MB tarball 时的网络抖动**。它是概率性的：
# 「重跑一次就好」没有保障，随时复发。这个脚本把那次外网下载消灭掉。
#
# ## ⚠️ 为什么用 `UV_INSTALLER_GITHUB_BASE_URL` 而不是 `INSTALLER_DOWNLOAD_URL`
#
# 两个变量安装器都认（0.7.13 第 28-36 行、0.9.7 第 31-36 行核过），但语义不同：
#
#   INSTALLER_DOWNLOAD_URL      → 直接当成**版本目录**，把版本号锁死在 URL 里
#   UV_INSTALLER_GITHUB_BASE_URL→ 替换 github 根，安装器自己拼 /astral-sh/uv/releases/download/<版本>/
#
# 本地 11 个题目 test.sh 实测用了**两个版本**（10 个 0.7.13 + hello-world 用 0.9.7）。
# 用前者就得按题分别注入；用后者**一个镜像同时服务所有版本**，且将来题目换版本不用改这里。
#
# ## 只需要镜像一个文件
#
# checksum 是**内嵌在安装器里**的（不额外下载），而 linux 全部目标的
# `_updater_name=""`（第 180-264 行）⇒ 每个版本只有一个 `uv-<triple>.tar.gz` 要托。
#
# ## ⚠️ 宿主地址必须是 192.168.5.2，不是 host.docker.internal
#
# 实测：任务镜像里 `host.docker.internal` **无法解析**（`curl: (6) Could not resolve host`），
# 而 `192.168.5.2`（colima host-gateway）`http=200`。这与 gateway shim 用的是同一个地址
# —— 那条路径已被十几棒验证过。⚠️ 也**不是** 172.17.0.1。
#
# ## 用法
#
#   eval "$(bash lib/uv-mirror.sh start)"   # 起服务并导出 UV_MIRROR_BASE_URL / UV_MIRROR_PID
#   bash lib/uv-mirror.sh stop "$UV_MIRROR_PID"
#
set -uo pipefail
# ⚠️ 全角字符紧跟裸 `$var` 会被 bash 当成变量名的一部分（`$pid，` → 变量 `pid，`），
# 在 `set -u` 下当场 unbound variable 而死。本仓 release.sh 踩过同一个坑。
# ⇒ 中文文案里的变量**一律写 `${var}`**。

MIRROR_DIR="${SID_UV_MIRROR_DIR:-$HOME/.cache/sid-uv-mirror}"
MIRROR_PORT="${SID_UV_MIRROR_PORT:-18077}"
# colima host-gateway。⚠️ 见文件头：host.docker.internal 在任务镜像里不解析。
HOST_ADDR="${SID_UV_MIRROR_HOST:-192.168.5.2}"
# 题目 test.sh 实测在用的版本。多一个版本只是多一个 17.8MB 文件，宁可多备。
UV_VERSIONS="${SID_UV_MIRROR_VERSIONS:-0.7.13 0.9.7}"
# 容器是 linux/amd64（--platform 强制），所以只需要 x86_64 这一个三元组。
UV_TRIPLE="${SID_UV_MIRROR_TRIPLE:-x86_64-unknown-linux-gnu}"

log() { echo "    $*" >&2; }

# 按 github release 的目录结构落盘，这样 UV_INSTALLER_GITHUB_BASE_URL 拼出的路径直接命中。
artifact_rel_path() {
  echo "astral-sh/uv/releases/download/$1/uv-${UV_TRIPLE}.tar.gz"
}

# 预热：把每个版本的 tarball 下到本地。已存在且非空就跳过（幂等，可重复调用）。
warm() {
  local ok=1 v rel dest
  mkdir -p "$MIRROR_DIR"
  for v in $UV_VERSIONS; do
    rel="$(artifact_rel_path "$v")"
    dest="$MIRROR_DIR/$rel"
    if [ -s "$dest" ]; then
      log "✅ 已缓存 uv ${v}（$(wc -c < "$dest" | tr -d ' ') B）"
      continue
    fi
    mkdir -p "$(dirname "$dest")"
    log "→ 下载 uv $v ..."
    # ⚠️ 下到 .part 再改名：半个文件比没有文件更坏 —— 它会让 verifier 拿到
    # 一个能 200 但解不开的 tarball，报错指向"uv 损坏"而不是"镜像没备好"。
    if curl -fsSL -m 180 -o "$dest.part" \
        "https://github.com/$rel" 2>/dev/null && [ -s "$dest.part" ]; then
      mv "$dest.part" "$dest"
      log "  ✅ uv $v → $(wc -c < "$dest" | tr -d ' ') B"
    else
      rm -f "$dest.part"
      log "  ⛔ uv $v 下载失败"
      ok=0
    fi
  done
  [ "$ok" = "1" ]
}

start() {
  if ! warm; then
    log "⛔ 预热失败 —— **不要**带着半套镜像去跑评测：verifier 会在缺的那个版本上"
    log "   回到 github 下载，于是这一层白做，而失败形态与原来一模一样（假 0 分）。"
    return 1
  fi
  # 端口占用检查。占了就直接用现成的（幂等），但要实证它真的托着我们的文件。
  local probe_rel probe_url first_v
  first_v="$(echo "$UV_VERSIONS" | awk '{print $1}')"
  probe_rel="$(artifact_rel_path "$first_v")"
  probe_url="http://127.0.0.1:${MIRROR_PORT}/${probe_rel}"
  local pid=""
  if curl -fsS -o /dev/null -m 3 "$probe_url" 2>/dev/null; then
    log "✅ 端口 ${MIRROR_PORT} 上已有可用镜像服务，复用"
  else
    python3 -m http.server "$MIRROR_PORT" --bind 0.0.0.0 --directory "$MIRROR_DIR" \
      >"$MIRROR_DIR/http.log" 2>&1 &
    pid=$!
    sleep 1.5
    # ⚠️ 判据是**真取到文件**，不是"进程还活着"：目录挂错时进程照样活着、照样 200 于目录列表，
    # 而 verifier 要的那个路径是 404 —— 那正是「起来了但没用」的形态。
    if ! curl -fsS -o /dev/null -m 5 "$probe_url" 2>/dev/null; then
      log "⛔ 服务起了但取不到 $probe_rel —— 不放绿"
      kill "$pid" 2>/dev/null || true
      return 1
    fi
    log "✅ 镜像服务已起（pid=${pid}，目录 ${MIRROR_DIR}）"
  fi
  # 容器侧可达性实证。宿主能取 ≠ 容器能取（host.docker.internal 就是这么栽的）。
  if command -v docker >/dev/null 2>&1; then
    local code
    code=$(docker run --rm --platform linux/amd64 alpine:3 sh -c \
      "apk add -q curl >/dev/null 2>&1; curl -s -o /dev/null -w '%{http_code}' -m 10 \
       'http://${HOST_ADDR}:${MIRROR_PORT}/${probe_rel}'" 2>/dev/null | tr -d '\n')
    code="${code:-000}"; code="${code: -3}"
    if [ "$code" != "200" ]; then
      log "⛔ 容器内取不到镜像（http=${code}）—— 宿主可达不代表容器可达，不放绿"
      [ -n "$pid" ] && kill "$pid" 2>/dev/null
      return 1
    fi
    log "✅ 容器内实测可达（http=200 @ ${HOST_ADDR}:${MIRROR_PORT}）"
  fi
  echo "export UV_MIRROR_BASE_URL='http://${HOST_ADDR}:${MIRROR_PORT}'"
  echo "export UV_MIRROR_PID='${pid}'"
}

stop() {
  local pid="${1:-}"
  [ -n "$pid" ] && kill "$pid" 2>/dev/null && log "镜像服务已停（pid=${pid}）"
  return 0
}

case "${1:-start}" in
  start) start ;;
  warm)  warm ;;
  stop)  stop "${2:-}" ;;
  *) echo "用法: $0 {start|warm|stop <pid>}" >&2; exit 2 ;;
esac
