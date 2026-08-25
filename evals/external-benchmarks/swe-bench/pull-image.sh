#!/usr/bin/env bash
#
# SWE-bench 阶段 A —— 断点续传拉取官方 per-instance 镜像
#
# 事实源：`接入计划.md` §5（arm64 / 镜像来源）
#
# ## 为什么需要这个脚本（不是「加个重试」那么简单）
#
# 官方 per-instance 镜像**只发布 amd64**（实测 manifest 里就一个
# `"architecture":"amd64"`，没有 arm64 变体），且只在 Docker Hub。
# 本网络下有三层障碍，一层一个坑：
#
# 1. **Docker Hub 直连不通** —— `registry-1.docker.io` 与 `auth.docker.io`
#    实测 curl 25s 全 `000`（连 huggingface.co 也不通，但 pypi/baidu 通）。
#
# 2. **配成 daemon 的 `registry-mirrors` 会静默挂死** —— 这是最阴的一层。
#    配了镜像站后 `docker pull` 挂 20+ 分钟、零字节、**stdout 一行都不输出**，
#    唯一线索在 daemon 日志里：
#        `level=warning msg="Host doesn't match" cfgHost=registry-1.docker.io host=docker.1ms.run`
#    docker 的 auth 流程不接受镜像站给出的 realm 重定向，于是卡在鉴权，
#    但**它不报错**。看起来像「网络慢」，实际是永远不会完成。
#    ✅ 解法：把镜像站**当普通 registry 直接引用**（`docker.1ms.run/swebench/...`），
#    不要放进 `registry-mirrors`。
#
# 3. **改对之后仍然会 `unexpected EOF`** —— 实测 29.5 分钟后失败：
#        `short read: expected 414927911 bytes but got 10141808: unexpected EOF`
#    这一层是本脚本存在的真正理由：docker 的 pull **不做断点续传**，
#    单个 415MB 层中途断流就整层重来，而镜像站的限速让「一次拉完」变成小概率事件
#    （实测：起初 7.2MB/s，几分钟后掉到 3.8KB/s，是限速不是网络故障 ——
#    同一时刻 curl 单独跑也一样慢，所以不是 docker 的问题）。
#
# ## 做法：curl 逐层断点续传 + 手工组装 OCI layout，再 docker load
#
# curl 的 `-C -` 支持续传，且实测 registry 认 `Range`（返 206）。
# 所以：逐层拉到本地（断了就续，不重来）→ 拼一个 OCI image layout →
# `docker load`。整个过程幂等，已完整的层直接跳过。
#
# ## 用法
#
#   ./pull-image.sh pytest-dev__pytest-7982            # 一条
#   ./pull-image.sh --all                              # subset 全部 10 条
#   ./pull-image.sh --check pytest-dev__pytest-7982    # 只看本地有没有
#
# ## 2026-08-25 更新：默认已切回官方源 registry-1.docker.io
#
# 上面 1./3. 描述的「Docker Hub 直连不通」「镜像站限速到 20KB/s」是**在没有代理的
# 网络条件下**量到的。开了全局代理（TUN）之后实测变化很大，**但只在宿主侧变了**：
#
# | 路径 | 实测 |
# | --- | --- |
# | 宿主 curl → registry-1.docker.io blob | **16 MB/s** |
# | 宿主 curl → 307 之后的 CDN（`production.cloudfront.docker.com`） | **43 MB/s** |
# | colima VM 内 curl → registry-1.docker.io | 6.9 MB/s（也通） |
# | **VM 里的 dockerd `docker pull`** | ❌ 仍 `TLS handshake timeout`，连 `hello-world` 都拉不下来 |
#
# 最后一行是这个脚本**继续存在的理由**（理由从「断点续传」变成了「绕过 dockerd」）：
# dockerd 走的是 Go 自带的 resolver，**既不读 VM 的 `/etc/hosts`**（实测把域名钉到
# 可用 IPv4 后 pull 照旧超时），也拿不到宿主 TUN 的 fake-ip；而 VM 的 DNS 返回的
# AAAA 是污染地址（`2a03:2880:…` Facebook 段，`curl -6` 立即失败）。
# 所以「让 dockerd 自己去拉」这条路在当前网络下不通，
# 必须**宿主 curl 拉层 → 组 OCI layout → `docker load` 灌进去**。
#
# ⚠️ 宿主侧也不能靠系统解析器：`registry-1.docker.io` / `auth.docker.io` 被 DNS 污染
# （实测解析到 `104.244.45.246` / `199.59.150.45`，都是 Twitter 段，TCP 握手成功但
# TLS 无响应 —— 这个失败形态最坑，因为 `nc -z` 会报 OPEN）。所以脚本对这两个域名
# 走 **fake-ip**（`dig @8.8.8.8` 拿到 `198.19.0.x`，由 TUN 接管），
# 而 307 之后的 CDN 域名**不需要**（未被污染，且系统解析走的路更快：43 vs 9.5 MB/s）。
#
# ## ⚠️⚠️ 必须 `curl -4`：IPv6 路径会被 `Connection reset by peer`
#
# 这是本轮最难归因的一层，**它的表现和「限速 / 配额用尽」一模一样**，
# 差点让人往错的方向修（去登录 Docker 账号提配额）。实测数据：
#
# - CDN `production.cloudfront.docker.com` 同时有 A 与 AAAA 记录，
#   **curl 默认优先连 IPv6**（`Trying [2600:9000:...]:443`）；
# - 而这条 IPv6 路径在 TUN 下必被重置：
#   `Recv failure: Connection reset by peer` / `curl: (35)`，
#   在 **TLS Client Hello 之后**、0.1 秒内失败；
# - 于是 `%{http_code}` 是 `000`、`speed_download` 是 0，
#   看起来就像「被限速到零」。而**成功与失败交替出现**（curl 每次挑的地址不同），
#   更强化了「按连接限速」这个错误解释；
# - 一样的 20 个块，**加 `-4` 之后 20/20 全成功**（此前 7/20）。
#
# 顺带排除了两个看似成立的解释，**别再重复验证**：
# 1. **不是 Docker Hub 配额**：查 `ratelimit-remaining` 头实测 `97;w=3600`
#    （100/6h 匿名额度几乎没动），且此时 manifest 请求照样返 200。
#    「blob 全挂但 manifest 正常」本身就该排除配额 —— 配额是按 manifest 计的。
# 2. **不是并发太高**：并发 1 也会失败（0.1s 就返回），
#    降并发只是降低了「恰好挑中 IPv6」的次数，不是治因。
#
# 同一根因也解释了 dockerd 为什么拉不下来（它也走 AAAA），
# 只是 dockerd 那边没法从外部给它加 `-4`。
#
# 环境变量：
#   SWE_REGISTRY   registry 主机名，默认 registry-1.docker.io（官方源）
#                  想回退到镜像站：SWE_REGISTRY=docker.1ms.run
#   SWE_NO_FAKEIP=1  关掉 fake-ip 解析（网络环境变了、或不想依赖 dig 时）
#   SWE_CACHE      层缓存目录，默认 ~/.cache/sid-code/swebench-layers
#     ⚠️ 缓存**不放在仓库里**：单条镜像近 1GB，10 条约 10GB。
#        放进仓库会被 git status 看见、可能被误 add，也会让 `du` 出来的
#        仓库体积失真。这与 .venv 那条「落点必须在仓内」不冲突 ——
#        .venv 是**依赖声明的一部分**（要能重建、要被 .gitignore 显式记住），
#        而这些层是**可再生的二进制缓存**，删了只是重下。

set -euo pipefail

SWE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REGISTRY="${SWE_REGISTRY:-registry-1.docker.io}"
CACHE="${SWE_CACHE:-$HOME/.cache/sid-code/swebench-layers}"
# 官方镜像的 Docker Hub 组织名
ORG="swebench"

ok() { printf '  \033[32m✅\033[0m %s\n' "$1"; }
bad() { printf '  \033[31m❌\033[0m %s\n' "$1" >&2; }
info() { printf '  \033[36m→\033[0m %s\n' "$1"; }

# ## fake-ip 解析：只对被污染的域名用，且**只作为 --resolve 参数**
#
# 为什么不设 /etc/hosts 或换系统 DNS：那会影响这台机器上所有程序，而这里只需要
# 本脚本的 curl 走对路。为什么不用 `--dns-servers`：curl 的 DNS 覆盖需要
# libcurl 编译时带 c-ares，macOS 自带的没有（`curl --version` 无 `AsynchDNS` 也可能有，
# 但不能赌），`--resolve` 是唯一无依赖的手段。
#
# ⚠️ 缓存住结果：fake-ip 是 TUN 分配的，同一会话内稳定（实测 3 次查询全一致），
# 但每次 dig 都要 ~30ms，逐块下载时会调很多次。
declare -a RESOLVE_ARGS=()
_fakeip_cache=""
fakeip_of() {
  local host="$1"
  # 命中缓存
  local hit
  hit="$(printf '%s' "$_fakeip_cache" | awk -v h="$host" -F= '$1==h {print $2}')"
  [[ -n "$hit" ]] && {
    echo "$hit"
    return 0
  }
  local ip
  ip="$(dig +short +time=3 +tries=1 "$host" @8.8.8.8 2>/dev/null | grep -E '^[0-9.]+$' | head -1)"
  [[ -n "$ip" ]] || return 1
  _fakeip_cache="${_fakeip_cache}${host}=${ip}"$'\n'
  echo "$ip"
}

# 组装 curl 的 --resolve 参数。空数组时 curl 走系统解析（CDN 域名就该这样）。
build_resolve() {
  RESOLVE_ARGS=()
  [[ -n "${SWE_NO_FAKEIP:-}" ]] && return 0
  local h ip
  for h in "$REGISTRY" auth.docker.io; do
    ip="$(fakeip_of "$h")" || continue
    RESOLVE_ARGS+=(--resolve "$h:443:$ip")
  done
}

# 镜像名规则抄 swebench/image_builder/image_spec.py:38-43：
# `sweb.eval.x86_64.<instance_id>:latest`，且带 namespace 时 `__` → `_1776_`
repo_path() {
  local iid="$1"
  local key="sweb.eval.x86_64.${iid}"
  key="${key//__/_1776_}"
  echo "${ORG}/${key}" | tr '[:upper:]' '[:lower:]'
}

local_tag() {
  # ⚠️ 本地 tag **必须是 dataset 里那个名字，不带 registry 前缀**。
  # 实测（2026-08-25）：
  #   .venv/bin/python -c 'from swebench.harness.utils import make_test_spec; ...'
  #   → image = swebench/sweb.eval.x86_64.pytest-dev_1776_pytest-7982:latest
  # harness 就是拿这个字符串去 `docker image inspect` 的（run_evaluation.py:656
  # 的 `wanted = {... make_test_spec(d).image ...}`），
  # 打成 `docker.1ms.run/swebench/...` 它一个都认不出来，
  # 于是回落到「registry 里拉」→ 又撞上 dockerd 出网不通 → 报的是拉取失败，
  # **看不出根因是 tag 名不对**。
  echo "$(repo_path "$1"):latest"
}

get_token() {
  local repo="$1"
  # 镜像站的 token 端点与 Docker Hub 不同（`/openapi/v1/auth/token`），
  # 且返回字段是 `access_token` 而不是 `token`。写死会在换站时静默失效，
  # 所以从 401 的 WWW-Authenticate 头里读 realm。
  local hdr realm service
  hdr="$(curl -4 -sI --max-time 20 "${RESOLVE_ARGS[@]:+${RESOLVE_ARGS[@]}}" \
    "https://$REGISTRY/v2/$repo/manifests/latest" |
    tr -d '\r' | grep -i '^WWW-Authenticate:' || true)"
  realm="$(echo "$hdr" | sed -n 's/.*realm="\([^"]*\)".*/\1/p')"
  service="$(echo "$hdr" | sed -n 's/.*service="\([^"]*\)".*/\1/p')"
  [[ -n "$realm" ]] || {
    bad "取不到 auth realm（$REGISTRY 可能不需要鉴权或不可达）"
    return 1
  }
  curl -4 -s --max-time 25 "${RESOLVE_ARGS[@]:+${RESOLVE_ARGS[@]}}" \
    "${realm}?service=${service}&scope=repository:${repo}:pull" |
    python3 -c 'import json,sys; d=json.load(sys.stdin); print(d.get("access_token") or d.get("token") or "")'
}

# 分块并发下载一个 blob，并**校验 sha256** 才算完成。
#
# ## 为什么是「分块并发」而不是「单流续传」
#
# 实测（2026-08-24，415MB 层）：
#   - 单流续传 15 分钟只前进 ~17MB（约 20KB/s），415MB 需数小时；
#   - registry 的 blob 端点返 **307** 重定向到 CloudFront CDN
#     （`cloudfront-docker-cf.mrs.1ms.run`，URL 带 `Expires` 签名）；
#   - 对同一 CDN URL 开 4 条并发 Range：**一条跑到 2.1MB/s，另几条 0B/s**。
#
# 也就是说限速/丢流是**按连接**的，而不是按 IP 总带宽 ——
# 所以「加重试」和「单流续传」都治不了，能治的是**多开几条、各自负责一段**。
# 一条卡住不影响别的段，重试只重那一小段而不是整层。
#
# ⚠️ 两个必须做的事：
# 1. **每块单独校验大小**，且**最后校验整层 sha256**。CDN 在出错时会返回
#    HTML 错误页/重定向体，文件会「长大」但内容是垃圾，
#    而 docker load 报的错和层损坏长得一模一样，排查会往错的方向走。
# 2. **签名 URL 会过期**（`Expires` 约 1 小时），所以每轮重取重定向目标。
CHUNK_SIZE="${SWE_CHUNK_SIZE:-8388608}" # 8MB
PARALLEL="${SWE_PARALLEL:-8}"

# 取 blob 的真实下载地址（跟随 307 到 CDN）。返回空则视为失败。
blob_url() {
  local repo="$1" token="$2" digest="$3"
  local loc
  loc="$(curl -4 -s -o /dev/null -D - --max-time 30 "${RESOLVE_ARGS[@]:+${RESOLVE_ARGS[@]}}" \
    -H "Authorization: Bearer $token" \
    "https://$REGISTRY/v2/$repo/blobs/$digest" |
    tr -d '\r' | sed -n 's/^[Ll]ocation: //p' | tail -1)"
  # 没有重定向说明 registry 直接给数据，那就用原 URL
  if [[ -z "$loc" ]]; then
    echo "https://$REGISTRY/v2/$repo/blobs/$digest"
  else
    echo "$loc"
  fi
}

fetch_blob() {
  local repo="$1" token="$2" digest="$3" size="$4" dest="$5"
  local want="${digest#sha256:}"

  if [[ -f "$dest" ]]; then
    local have
    have="$(shasum -a 256 "$dest" | awk '{print $1}')"
    [[ "$have" == "$want" ]] && return 0
    rm -f "$dest" # 坏文件不留，避免「续传一个垃圾」
  fi

  local parts="$dest.parts"
  mkdir -p "$parts"
  local nchunks=$(((size + CHUNK_SIZE - 1) / CHUNK_SIZE))
  local round=0

  while ((round < 40)); do
    round=$((round + 1))
    local url
    url="$(blob_url "$repo" "$token" "$digest")"

    # 找出还没下完的块
    local todo=()
    for ((c = 0; c < nchunks; c++)); do
      local s=$((c * CHUNK_SIZE))
      local e=$((s + CHUNK_SIZE - 1))
      ((e >= size)) && e=$((size - 1))
      local want_len=$((e - s + 1))
      local pf="$parts/$c"
      local have_len=0
      [[ -f "$pf" ]] && have_len="$(wc -c <"$pf" | tr -d ' ')"
      ((have_len == want_len)) || todo+=("$c")
    done

    if ((${#todo[@]} == 0)); then
      # ⚠️ **按数字序拼接，不能用 `cat "$parts"/*`** —— glob 是字典序，
      # 块 10 会排在块 2 前面，拼出来的层是乱的。而它的表现是
      # 「sha256 不符」，看起来像下载损坏，排查会一直往网络那边找。
      : >"$dest"
      for ((c = 0; c < nchunks; c++)); do cat "$parts/$c" >>"$dest"; done
      local have
      have="$(shasum -a 256 "$dest" | awk '{print $1}')"
      if [[ "$have" == "$want" ]]; then
        rm -rf "$parts"
        printf '\r'
        return 0
      fi
      bad "整层摘要不符（期望 ${want:0:12} 实得 ${have:0:12}）—— 丢弃全部块重下"
      rm -rf "$parts" "$dest"
      mkdir -p "$parts"
      continue
    fi

    local done_n=$((nchunks - ${#todo[@]}))
    printf '\r      块 %d/%d（第 %d 轮，并发 %d）      ' "$done_n" "$nchunks" "$round" "$PARALLEL"

    # 并发拉这一轮的块。**一条卡住不拖累别的** —— 这是本函数的核心。
    local running=0
    for c in "${todo[@]}"; do
      local s=$((c * CHUNK_SIZE))
      local e=$((s + CHUNK_SIZE - 1))
      ((e >= size)) && e=$((size - 1))
      (
        # RESOLVE_ARGS 里只有 registry / auth 两个主机，而 $url 在 307 之后是 CDN
        # 主机名 —— 传了也不会命中，是无害的。不针对 CDN 做 fake-ip 是**刻意的**：
        # 实测 CDN 走系统解析 43MB/s、走 fake-ip 只有 9.5MB/s（多绕一跳代理）。
        curl -4 -sL --max-time 120 "${RESOLVE_ARGS[@]:+${RESOLVE_ARGS[@]}}" \
          -H "Range: bytes=$s-$e" \
          -o "$parts/$c.tmp" "$url" 2>/dev/null || true
        # 只有长度正确才落成正式块 —— 错误页/半截数据一律丢弃
        if [[ -f "$parts/$c.tmp" ]] &&
          [[ "$(wc -c <"$parts/$c.tmp" | tr -d ' ')" == "$((e - s + 1))" ]]; then
          mv "$parts/$c.tmp" "$parts/$c"
        else
          rm -f "$parts/$c.tmp"
        fi
      ) &
      running=$((running + 1))
      if ((running >= PARALLEL)); then
        wait -n 2>/dev/null || wait
        running=$((running - 1))
      fi
    done
    wait
    token="$(get_token "$repo")" # 签名与 token 都会过期，每轮重取
  done

  echo
  bad "超过 40 轮仍未拉完 $digest"
  return 1
}

pull_one() {
  local iid="$1"
  local repo tag
  repo="$(repo_path "$iid")"
  tag="$(local_tag "$iid")"

  if docker image inspect "$tag" >/dev/null 2>&1; then
    ok "${iid} 已在本地（${tag}）"
    return 0
  fi

  info "$iid → $tag"
  local token
  token="$(get_token "$repo")" || return 1
  [[ -n "$token" ]] || {
    bad "$iid: token 为空"
    return 1
  }

  local work="$CACHE/$iid"
  mkdir -p "$work/blobs/sha256"

  # ① index → 取 amd64 的 manifest digest
  local index man_digest
  index="$(curl -4 -s --max-time 40 "${RESOLVE_ARGS[@]:+${RESOLVE_ARGS[@]}}" \
    -H "Authorization: Bearer $token" \
    -H "Accept: application/vnd.oci.image.index.v1+json,application/vnd.docker.distribution.manifest.list.v2+json,application/vnd.oci.image.manifest.v1+json,application/vnd.docker.distribution.manifest.v2+json" \
    "https://$REGISTRY/v2/$repo/manifests/latest")"
  man_digest="$(echo "$index" | python3 -c '
import json,sys
d = json.load(sys.stdin)
if "manifests" in d:
    for m in d["manifests"]:
        p = m.get("platform", {})
        if p.get("architecture") == "amd64" and p.get("os") == "linux":
            print(m["digest"]); break
else:
    print("")   # 已经是单 manifest
' 2>/dev/null || true)"

  local manifest
  if [[ -n "$man_digest" ]]; then
    manifest="$(curl -4 -s --max-time 40 "${RESOLVE_ARGS[@]:+${RESOLVE_ARGS[@]}}" \
      -H "Authorization: Bearer $token" \
      -H "Accept: application/vnd.oci.image.manifest.v1+json,application/vnd.docker.distribution.manifest.v2+json" \
      "https://$REGISTRY/v2/$repo/manifests/$man_digest")"
  else
    manifest="$index"
  fi
  echo "$manifest" | python3 -c 'import json,sys; json.load(sys.stdin)["config"]' >/dev/null 2>&1 || {
    bad "$iid: 取不到 amd64 manifest。响应开头：$(echo "$manifest" | head -c 200)"
    return 1
  }

  # ② 逐层断点续传
  local total
  total="$(echo "$manifest" | python3 -c 'import json,sys; m=json.load(sys.stdin); print(len(m["layers"]))')"
  info "$iid: $total 层"
  local i=0
  while read -r digest size; do
    [[ -n "$digest" ]] || continue
    i=$((i + 1))
    local dest="$work/blobs/sha256/${digest#sha256:}"
    printf '    [%d/%d] %s (%s bytes)\n' "$i" "$total" "${digest:7:12}" "$size"
    fetch_blob "$repo" "$token" "$digest" "$size" "$dest" || return 1
    token="$(get_token "$repo")"
  done < <(echo "$manifest" | python3 -c '
import json,sys
m = json.load(sys.stdin)
print(m["config"]["digest"], m["config"]["size"])
for l in m["layers"]:
    print(l["digest"], l["size"])
')

  # ③ 拼 OCI layout 并 docker load
  echo "$manifest" >"$work/manifest.json"
  local man_sha
  man_sha="$(shasum -a 256 "$work/manifest.json" | awk '{print $1}')"
  cp "$work/manifest.json" "$work/blobs/sha256/$man_sha"
  printf '{"imageLayoutVersion":"1.0.0"}\n' >"$work/oci-layout"
  python3 - "$work" "$man_sha" "$tag" <<'PY'
import json, os, sys
work, man_sha, tag = sys.argv[1], sys.argv[2], sys.argv[3]
size = os.path.getsize(os.path.join(work, "manifest.json"))
index = {
    "schemaVersion": 2,
    "mediaType": "application/vnd.oci.image.index.v1+json",
    "manifests": [{
        "mediaType": "application/vnd.oci.image.manifest.v1+json",
        "digest": "sha256:" + man_sha,
        "size": size,
        "annotations": {"org.opencontainers.image.ref.name": tag},
        "platform": {"architecture": "amd64", "os": "linux"},
    }],
}
json.dump(index, open(os.path.join(work, "index.json"), "w"))
PY

  info "$iid: docker load..."
  local load_out
  load_out="$(tar -cf - -C "$work" oci-layout index.json blobs | docker load 2>&1)"
  echo "$load_out" | tail -3

  # ## ⚠️ 为什么这里必须无条件补一次 `docker tag`
  #
  # 实测（2026-08-25，colima + `containerd-snapshotter: true`）：`docker load` 明确
  # 打印 `Loaded image: swebench/sweb.eval.x86_64.…:latest`，
  # `docker images` 里**也看得到**这个 tag（1.03GB，甚至重复出现两行），
  # 但 `docker image inspect <tag>` 报 **`No such image`** ——
  # 而 `docker image inspect <镜像ID>` 完全正常，且它的 `.RepoTags` 里就有那个 tag。
  #
  # 也就是说 OCI layout 的 `org.opencontainers.image.ref.name` 注解建出来的 tag
  # 在 containerd 存储后端下**只进了 list 视图，没进 name 解析表**。
  # `docker tag <id> <tag>` 一跑就好了。
  #
  # 这个失败形态特别坑，两层原因：
  # 1. **它长得像成功** —— load 说 Loaded、images 里看得见，
  #    只有真去 inspect 才发现引用不到。而 swebench harness 正是用
  #    `docker image inspect` 那条路（`run_evaluation.py` 的 `wanted` 映射），
  #    所以镜像明明在本地，harness 仍会判定「缺镜像」→ 回落去 registry 拉
  #    → 撞上 dockerd 出网不通 → 报的是**拉取失败**，根因被埋两层。
  # 2. 旧版兜底按 `grep '<none>'` 找无标签镜像，**在这个形态下匹配不到**
  #    （tag 是有的，只是解析不到），于是兜底空转、直接报「找不到镜像」。
  #
  # 所以判据不是「tag 在不在 list 里」，而是「inspect 能不能解析」。
  local iid_sha
  iid_sha="$(printf '%s' "$load_out" | sed -n 's/^Loaded image ID: //p' | tail -1)"
  if [[ -z "$iid_sha" ]]; then
    # `Loaded image: <tag>` 形态：用 tag 反查 ID（这条路 docker images 是通的）
    iid_sha="$(docker images --no-trunc --format '{{.ID}} {{.Repository}}:{{.Tag}}' |
      awk -v t="$tag" '$2==t {print $1; exit}')"
  fi
  if [[ -n "$iid_sha" ]]; then
    docker tag "$iid_sha" "$tag" 2>/dev/null || true
  fi

  if docker image inspect "$tag" >/dev/null 2>&1; then
    ok "${iid} 载入成功（${tag}）"
    return 0
  fi
  bad "${iid}: docker load 后 inspect 不到 $tag"
  bad "  load 输出：$(printf '%s' "$load_out" | tail -1)"
  bad "  排查：docker images | grep sweb 看看它在不在 list 里；在的话是 tag 解析问题，"
  bad "  手动 docker tag <ID> $tag 即可"
  return 1
}

subset_ids() {
  awk '
    /^instances:[[:space:]]*$/ { inb=1; next }
    inb && /^[a-zA-Z_]+:/ { inb=0 }
    inb && /^[[:space:]]*-[[:space:]]+instance_id:/ {
      gsub(/.*instance_id:[[:space:]]*"?/, ""); gsub(/"[[:space:]]*$/, ""); print
    }
  ' "$SWE_DIR/verified-subset.yaml"
}

docker info >/dev/null 2>&1 || {
  bad "docker daemon 不可达。先 export DOCKER_HOST"
  exit 1
}

# 预检：registry 必须能返 401（**401 才是正常**，见文件头「镜像站差别」那段；
# 200 也接受，某些站不要鉴权）。这里刻意在拉之前先探一次 ——
# 不探的话，DNS 污染的表现是 curl 挂到 --max-time 才失败，
# 而外层看到的只是「某一块没下下来」，会一路重试 40 轮才报错。
preflight_registry() {
  build_resolve
  local code
  code="$(curl -4 -s -o /dev/null -w '%{http_code}' --max-time 15 \
    "${RESOLVE_ARGS[@]:+${RESOLVE_ARGS[@]}}" "https://$REGISTRY/v2/" || true)"
  # ⚠️ 变量一律写 `${VAR}` 而不是 `$VAR` —— 后面紧跟全角逗号「，」时，
  # bash 会把它当作变量名的一部分，报 `code，: unbound variable`
  # （`set -u` 下直接退出）。这个坑 release.sh 踩过一次，这里又踩了一次。
  case "${code}" in
  401 | 200)
    if ((${#RESOLVE_ARGS[@]} > 0)); then
      info "registry ${REGISTRY} 可达（HTTP ${code}，fake-ip: ${RESOLVE_ARGS[1]#*:443:}）"
    else
      info "registry ${REGISTRY} 可达（HTTP ${code}，系统解析）"
    fi
    ;;
  *)
    bad "registry ${REGISTRY} 不可达（HTTP ${code}）"
    bad "  排查顺序：① 代理是否开着 ② dig +short ${REGISTRY} @8.8.8.8 是否返 198.19.x（fake-ip）"
    bad "  ③ 若网络环境变了，可试 SWE_NO_FAKEIP=1 或 SWE_REGISTRY=docker.1ms.run"
    return 1
    ;;
  esac
}

case "${1:-}" in
--check)
  shift
  fail=0
  for iid in "$@"; do
    t="$(local_tag "$iid")"
    if docker image inspect "$t" >/dev/null 2>&1; then ok "$iid 在本地"; else
      bad "$iid 不在本地"
      fail=1
    fi
  done
  exit $fail
  ;;
--all)
  preflight_registry || exit 1
  fail=0
  while read -r iid; do
    [[ -n "$iid" ]] || continue
    pull_one "$iid" || fail=1
  done < <(subset_ids)
  exit $fail
  ;;
"")
  sed -n '1,45p' "${BASH_SOURCE[0]}" | grep -E '^#' | sed 's/^# \{0,1\}//'
  exit 2
  ;;
*)
  preflight_registry || exit 1
  fail=0
  for iid in "$@"; do pull_one "$iid" || fail=1; done
  exit $fail
  ;;
esac
