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
# 环境变量：
#   SWE_REGISTRY   镜像站主机名，默认 docker.1ms.run
#   SWE_CACHE      层缓存目录，默认 ~/.cache/sid-code/swebench-layers
#     ⚠️ 缓存**不放在仓库里**：单条镜像近 1GB，10 条约 10GB。
#        放进仓库会被 git status 看见、可能被误 add，也会让 `du` 出来的
#        仓库体积失真。这与 .venv 那条「落点必须在仓内」不冲突 ——
#        .venv 是**依赖声明的一部分**（要能重建、要被 .gitignore 显式记住），
#        而这些层是**可再生的二进制缓存**，删了只是重下。

set -euo pipefail

SWE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REGISTRY="${SWE_REGISTRY:-docker.1ms.run}"
CACHE="${SWE_CACHE:-$HOME/.cache/sid-code/swebench-layers}"
# 官方镜像的 Docker Hub 组织名
ORG="swebench"

ok() { printf '  \033[32m✅\033[0m %s\n' "$1"; }
bad() { printf '  \033[31m❌\033[0m %s\n' "$1" >&2; }
info() { printf '  \033[36m→\033[0m %s\n' "$1"; }

# 镜像名规则抄 swebench/image_builder/image_spec.py:38-43：
# `sweb.eval.x86_64.<instance_id>:latest`，且带 namespace 时 `__` → `_1776_`
repo_path() {
  local iid="$1"
  local key="sweb.eval.x86_64.${iid}"
  key="${key//__/_1776_}"
  echo "${ORG}/${key}" | tr '[:upper:]' '[:lower:]'
}

local_tag() {
  # 本地 tag 保持与官方一致（含 registry 前缀），这样 swebench harness
  # 按 dataset 里的镜像名找的时候能命中。
  echo "${REGISTRY}/$(repo_path "$1"):latest"
}

get_token() {
  local repo="$1"
  # 镜像站的 token 端点与 Docker Hub 不同（`/openapi/v1/auth/token`），
  # 且返回字段是 `access_token` 而不是 `token`。写死会在换站时静默失效，
  # 所以从 401 的 WWW-Authenticate 头里读 realm。
  local hdr realm service
  hdr="$(curl -sI --max-time 20 "https://$REGISTRY/v2/$repo/manifests/latest" |
    tr -d '\r' | grep -i '^WWW-Authenticate:' || true)"
  realm="$(echo "$hdr" | sed -n 's/.*realm="\([^"]*\)".*/\1/p')"
  service="$(echo "$hdr" | sed -n 's/.*service="\([^"]*\)".*/\1/p')"
  [[ -n "$realm" ]] || {
    bad "取不到 auth realm（$REGISTRY 可能不需要鉴权或不可达）"
    return 1
  }
  curl -s --max-time 25 "${realm}?service=${service}&scope=repository:${repo}:pull" |
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
  loc="$(curl -s -o /dev/null -D - --max-time 30 \
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
        curl -sL --max-time 120 -H "Range: bytes=$s-$e" \
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
    ok "$iid 已在本地（$tag）"
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
  index="$(curl -s --max-time 40 -H "Authorization: Bearer $token" \
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
    manifest="$(curl -s --max-time 40 -H "Authorization: Bearer $token" \
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
  tar -cf - -C "$work" oci-layout index.json blobs | docker load 2>&1 | tail -3
  if docker image inspect "$tag" >/dev/null 2>&1; then
    ok "$iid 载入成功"
    return 0
  fi
  # docker load 对 OCI layout 的 tag 处理不总是保留 ref.name，按摘要补一个 tag
  local loaded
  loaded="$(docker images --format '{{.ID}} {{.Repository}}:{{.Tag}}' | grep '<none>' | head -1 | awk '{print $1}')"
  if [[ -n "$loaded" ]]; then
    docker tag "$loaded" "$tag"
    ok "$iid 载入成功（补 tag）"
    return 0
  fi
  bad "$iid: docker load 后找不到镜像"
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
  fail=0
  for iid in "$@"; do pull_one "$iid" || fail=1; done
  exit $fail
  ;;
esac
