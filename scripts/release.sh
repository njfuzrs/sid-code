#!/bin/bash
# scripts/release.sh — sid-code 跨平台构建 + 打包 + 发布
#
# 用法：
#   ./scripts/release.sh                        # 门禁(bun test)+bump 版本号+构建 4 目标并打包到 dist/release/
#   ./scripts/release.sh --upload                # 打包后上传到服务器
#   ./scripts/release.sh --no-bump               # 复用当前版本号，不再 bump（上次已 bump 过、重跑时用）
#   ./scripts/release.sh --skip-test             # 跳过发布前 bun test 门禁（不推荐，仅救急）
#   ./scripts/release.sh --allow-dirty           # 允许工作区有未提交改动（默认拒绝，见下方门禁说明）
#   ./scripts/release.sh --no-commit             # 不自动提交 bump（tag 会与版本号错位，仅特殊情况）
#   ./scripts/release.sh --upload-team-defaults <file>  # 单独上传团队默认配置（不打版本号）
#   ./scripts/release.sh --upload-ripgrep <dir> <version>  # 单独上传预编译 ripgrep 二进制（不打版本号）
#
# 发布前门禁：默认先跑 `bun test` 全量单测，失败即中止（坏版本不会推到 latest.txt）。
#   构建完成后还会对「当前平台」的产物做一次 --version 冒烟，挡住产物损坏/无法执行的情况。
#   加 --skip-test 可跳过单测（救急用），冒烟测试始终执行、不可跳过。
#
# 内嵌 ripgrep（仓库本地优先，联网仅作缺失时回退，best-effort 不阻断发布）：
#   packages/core/vendor/ripgrep/<version>/rg-<platform> 已 git 提交入库，`fetch-ripgrep.ts --all`
#   优先直接复用（全程不联网）；仓库内缺失（如刚 bump 版本号还没提交）才回退联网下载。
#   每个 target 编译前把对应平台的二进制放到 packages/core/vendor/rg-embed（bun --compile 的固定嵌入
#   import 路径，见 packages/core/src/tool/rg-embedded.ts）。仓库内和服务器都没有对应二进制/版本时不
#   阻断发布，仅让该 target 的产物不含内嵌 rg（运行时透明回退系统 rg，与本功能上线前行为一致）。
#   升级 rg 版本：改 fetch-ripgrep.ts 的 DEFAULT_RG_VERSION → 跑 --all 下载新版本
#   → git add packages/core/vendor/ripgrep/<新版本>/ 提交入库（可选再用 --upload-ripgrep 同步一份到服务器作为团队备用源）。
#
# Changelog + Git Commit + Git Tag（顺序在 2026-08-01 调整，见下方 ★）：
#   ⓪ bump 之后先检查 changelog/curated/v<version>.json 是否存在（用户视角文案，
#      LLM 起草 + 人工过目 + 已入库）。缺了会**交互确认**一次 —— 刻意放在构建之前，
#      因为此刻跑一次 `bun run changelog:curate <version>` 就能补上；等到发布结束才
#      发现，补救就得重新发一版。本脚本从不调 LLM，只读这份缓存
#      （发布路径必须确定性 + 离线 + 幂等）。
#   ① bump 版本号之后，跑 scripts/generate-changelog.ts 从 git 历史生成两份产物：
#      · CHANGELOG.md                          文本事实源（仓库根，累积追踪）
#      · website/.vitepress/data/changelog.json 官网 /changelog 页的数据源
#   ② 4 平台构建 + 本机冒烟 + --self-check 全部通过后，脚本**自己提交** `bump vX.Y.Z`
#      （只 add package.json / changelog 产物 / builtin-embedded.generated.ts）
#   ③ 把 annotated tag vX.Y.Z 打在**这个 bump 提交**上，并当场校验
#      `git show <tag>:package.json` 的版本号与 tag 一致
#   ④ --upload 时额外把 CHANGELOG.md 传到服务器顶层、上传成功后 push tag，
#      再调 scripts/github-release.ts 建 GitHub Release（正文取自同一份 curated 文案）。
#      Release 这一步 2026-08-21 才补上 —— 在此之前流程里根本没有它，仓库现有的
#      v0.1.591…v0.1.600 那 10 个 Release 全是开源首发时一次性人工回填的，
#      而 GitHub 仓库首页把最新 Release 当"当前版本"展示，于是页面长期停在旧版本。
#      未装 gh CLI 或建失败都只 warn：制品此刻已上线且校验过，不该因此判定发布失败。
#   changelog 失败不阻断发布（非致命 warn）；tag/changelog/Release 幂等，--no-bump 复用版本安全。
#
#   ★ 为什么②③要这么排：旧流程把 tag 打在 bump **之前**的 HEAD 上，bump 提交留给用户
#   事后手工补。结果 tag 指向的 commit 里 package.json 比 tag 低一位——实测 v0.1.591…
#   v0.1.596 六个 tag 全部错位，`git checkout <tag>` 重建不出对应二进制，把 CLAUDE.md §1
#   "产物必须能对应确切 commit"这条铁律架空了。现在由脚本负责提交，对齐不再依赖人的记性。
#   特殊情况可用 --no-commit 跳过（届时会 warn 提示 tag 将错位）。
#
#   ⚠ 用户可见的更新日志现在是**官网 /changelog 页**，它是站点构建期快照 ——
#   本脚本只生成数据，不发布站点。发完版必须按 CLAUDE.md 铁律第 5.5 步跑
#   ./scripts/website-deploy.sh，否则线上 /changelog 还停在上一个版本。
#   website-deploy.sh 开头有版本一致性检查会 warn 提醒这件事。
#
# 版本号 bump 规则：release.sh 默认自增 patch 版本号一次。
#   推荐做法：直接 ./scripts/release.sh --upload（一次 bump 到位）。日常的 `make build`
#   不动版本号，先跑它验证构建是安全的；但若你显式跑过 `make build-bump`（它会 bump），
#   再直接 release 会导致版本号 +2 —— 此时加 --no-bump 复用现有版本号。
#
# 中途失败怎么办：直接重跑，**不需要** --no-bump。
#   脚本装了 EXIT trap，非正常退出时会把 package.json 与 changelog 产物回滚到运行前的
#   状态（仅回滚运行前本就 clean 的文件，绝不吃掉你自己的改动），并在 stderr 打印回滚结果。
#   所以失败不再消耗版本号。已成功创建的本地 tag 刻意不删（创建是幂等的），重跑会复用。
#
# 环境变量（--upload 时使用）：
#   DEPLOY_SSH_HOST         SSH 上传目标（必填，无默认值；IP 或域名均可，只用于 scp/ssh，
#                           不进任何对外 URL）。刻意不内置默认值 —— 早期硬编码了发布机地址，
#                           等于把自建基建拓扑写进公开仓库，且任何人 clone 后误跑 --upload
#                           都会打到那台机器。缺失时与 DEPLOY_SSH_USER 一同报错提示配置。
#   PUBLIC_BASE_URL         对外访问地址（默认 https://www.sid-code.cc，install.sh 的下载
#                           地址与冒烟校验都由它派生）。⚠️ 与 DEPLOY_SSH_HOST 是两件事，
#                           不要合并：SSH 走 IP 没问题，但对外 URL 必须是带证书的域名 ——
#                           服务器 80 端口整段 301 → https，证书只签 sid-code.cc，
#                           用 IP 走 https 会 TLS 校验失败（curl exit 60）。
#   DEPLOY_SSH_USER         SSH 用户（必填，无默认值）
#   DEPLOY_SSH_PASSWORD     SSH 密码（可选，配置后用 sshpass 免交互上传；留空则交互式输入）
#   DEPLOY_PATH             服务器上的发布目录（默认 /var/www/html/releases/sid-code，
#                           对齐 nginx sites-enabled/default 的 root /var/www/html;）
#   DEPLOY_RG_PATH          服务器上预编译 ripgrep 二进制目录
#                           （默认 /var/www/html/vendor-bin/ripgrep，与 releases 版本目录隔离，
#                           不受旧版本清理逻辑影响；对应 fetch-ripgrep.ts 的下载根）
#   RELEASE_KEEP_VERSIONS   服务器端保留的历史版本数（默认 5，上传后清理更旧的版本目录）
#
#   凭据来源：脚本启动时自动 source scripts/deploy.env（不入库，见 deploy.env.example 模板）。
#   环境变量优先级高于 deploy.env 文件（已导出的同名变量不会被文件覆盖）。
#
# 设计要点（见 docs/install-guide.md 与 plan）：
#   - bump-version.ts / embed-builtin-skills.ts 全程只各跑一次，4 个目标复用同一份
#     版本号与内嵌 skill 产物，避免 4 个二进制的 --version 互不一致
#   - 每个目标独立输出路径（bun build --outfile 不会自动按 target 加后缀）
#   - install.sh 的 RELEASE_BASE 由 PUBLIC_BASE_URL 在拷贝时注入，对外地址只需改一处
#   - team-defaults.json 不随常规发布上传，避免用仓库里的占位模板覆盖服务器上的真实配置；
#     只能通过 --upload-team-defaults 显式单独推送
#   - packages/core/vendor/ripgrep/<version>/rg-<platform> 已 git 提交入库随仓库版本化，常规发布无需联网；
#     升级 rg 版本才需要 --upload-ripgrep 把新版本同步一份到服务器，供他人 fetch-ripgrep.ts
#     首次下载填充本地仓库副本时使用

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
# vendor 根目录 —— P2-3（2026-08-12）从仓库根下沉到 packages/core/（谁用谁带，rg 只有
# core 包在用）。这里抽成变量而不是把新路径散在 7 处：下次再动位置只需改这一行，
# 而散着写就必然漏一处，且漏掉的那处是**静默**的（cp 到不存在的目录会失败，
# 但 restore_rg_embed 里全是 `|| return 0` / `|| true` 的容错兜底，不会报错，
# 只会让本机产物悄悄嵌错平台的 rg —— 正是第 280 行那段注释在防的事）。
# 同源改动点见 scripts/fetch-ripgrep.ts 的 VENDOR_DIR 注释。
VENDOR_DIR="$ROOT/packages/core/vendor"
DIST_DIR="$ROOT/dist"
BUILD_DIR="$DIST_DIR/build"
RELEASE_DIR="$DIST_DIR/release"

# 加载本地凭据文件（不入库）。已在环境中导出的同名变量优先于文件值，
# 因此这里只对「未设置」的变量生效——用 : "${VAR:=...}" 的 source 无法实现，
# 故先记录已存在的值，source 后再恢复。
ENV_FILE="$SCRIPT_DIR/deploy.env"
if [ -f "$ENV_FILE" ]; then
    _pre_host="${DEPLOY_SSH_HOST:-}"
    _pre_user="${DEPLOY_SSH_USER:-}"
    _pre_pass="${DEPLOY_SSH_PASSWORD:-}"
    _pre_path="${DEPLOY_PATH:-}"
    _pre_rg_path="${DEPLOY_RG_PATH:-}"
    _pre_public="${PUBLIC_BASE_URL:-}"
    # shellcheck disable=SC1090
    set -a; . "$ENV_FILE"; set +a
    # 恢复调用方显式导出的值（环境变量优先级更高）
    [ -n "$_pre_host" ] && DEPLOY_SSH_HOST="$_pre_host"
    [ -n "$_pre_user" ] && DEPLOY_SSH_USER="$_pre_user"
    [ -n "$_pre_pass" ] && DEPLOY_SSH_PASSWORD="$_pre_pass"
    [ -n "$_pre_path" ] && DEPLOY_PATH="$_pre_path"
    [ -n "$_pre_rg_path" ] && DEPLOY_RG_PATH="$_pre_rg_path"
    [ -n "$_pre_public" ] && PUBLIC_BASE_URL="$_pre_public"
fi

DEPLOY_SSH_HOST="${DEPLOY_SSH_HOST:-}"
# 对外访问地址（唯一权威）。与 DEPLOY_SSH_HOST 分离：SSH 可以走 IP，对外 URL 必须是域名。
PUBLIC_BASE_URL="${PUBLIC_BASE_URL:-https://www.sid-code.cc}"
PUBLIC_BASE_URL="${PUBLIC_BASE_URL%/}"
DEPLOY_SSH_USER="${DEPLOY_SSH_USER:-}"
DEPLOY_SSH_PASSWORD="${DEPLOY_SSH_PASSWORD:-}"
DEPLOY_PATH="${DEPLOY_PATH:-/var/www/html/releases/sid-code}"
DEPLOY_RG_PATH="${DEPLOY_RG_PATH:-/var/www/html/vendor-bin/ripgrep}"
RELEASE_KEEP_VERSIONS="${RELEASE_KEEP_VERSIONS:-5}"

# ripgrep 版本号从 fetch-ripgrep.ts 的 DEFAULT_RG_VERSION 读取（唯一事实源，避免两处硬编码漂移）
RG_VERSION="$(bun run "$SCRIPT_DIR/fetch-ripgrep.ts" --print-version)"

# bun-<os>-<arch> target → 打包命名用的 <os>-<arch>
TARGETS=(
    "bun-darwin-arm64:darwin-arm64"
    "bun-darwin-x64:darwin-x64"
    "bun-linux-x64:linux-x64"
    "bun-linux-arm64:linux-arm64"
)

DO_UPLOAD=false
DO_UPLOAD_TEAM_DEFAULTS=false
TEAM_DEFAULTS_FILE=""
DO_UPLOAD_RIPGREP=false
RIPGREP_DIR=""
RIPGREP_VERSION=""
DO_BUMP=true
DO_TEST=true
ALLOW_DIRTY=false
NO_COMMIT=false

while [ $# -gt 0 ]; do
    case "$1" in
        --upload) DO_UPLOAD=true; shift ;;
        --no-bump) DO_BUMP=false; shift ;;
        --skip-test) DO_TEST=false; shift ;;
        --allow-dirty) ALLOW_DIRTY=true; shift ;;
        --no-commit) NO_COMMIT=true; shift ;;
        --upload-team-defaults)
            DO_UPLOAD_TEAM_DEFAULTS=true
            TEAM_DEFAULTS_FILE="${2:-}"
            [ -n "$TEAM_DEFAULTS_FILE" ] || { echo "错误: --upload-team-defaults 需要传入文件路径"; exit 1; }
            shift 2
            ;;
        --upload-ripgrep)
            DO_UPLOAD_RIPGREP=true
            RIPGREP_DIR="${2:-}"
            RIPGREP_VERSION="${3:-}"
            [ -n "$RIPGREP_DIR" ] && [ -n "$RIPGREP_VERSION" ] \
                || { echo "错误: --upload-ripgrep 需要传入目录路径和版本号: --upload-ripgrep <dir> <version>"; exit 1; }
            shift 3
            ;;
        *) echo "未知参数: $1"; exit 1 ;;
    esac
done

info()  { echo "  $*"; }
ok()    { echo "  ✅ $*"; }
warn()  { echo "  ⚠️  $*" >&2; }
fail()  { echo "  ❌ $*" >&2; exit 1; }

sha256_of() {
    if command -v sha256sum >/dev/null 2>&1; then
        sha256sum "$1" | awk '{print $1}'
    elif command -v shasum >/dev/null 2>&1; then
        shasum -a 256 "$1" | awk '{print $1}'
    else
        fail "找不到 sha256sum 或 shasum"
    fi
}

# 当前机器对应的打包平台标识（darwin-arm64 等），用于对本平台产物做冒烟测试
self_platform() {
    local os arch
    case "$(uname -s)" in
        Darwin) os="darwin" ;;
        Linux)  os="linux" ;;
        *)      echo ""; return ;;
    esac
    case "$(uname -m)" in
        arm64|aarch64) arch="arm64" ;;
        x86_64|amd64)  arch="x64" ;;
        *)             echo ""; return ;;
    esac
    echo "${os}-${arch}"
}

require_ssh_user() {
    # 先校验 host：它没有内置默认值（不把自建基建地址写进公开仓库），
    # 缺失时如果不显式拦住，scp 目标会拼成 "user@:/path" 这种残缺形态，报错很难懂。
    [ -n "$DEPLOY_SSH_HOST" ] || fail "需要设置 DEPLOY_SSH_HOST（在 scripts/deploy.env 或环境变量中，上传到哪台服务器）"
    [ -n "$DEPLOY_SSH_USER" ] || fail "需要设置 DEPLOY_SSH_USER（在 scripts/deploy.env 或环境变量中，SSH 到 $DEPLOY_SSH_HOST 用哪个账号）"
}

# ssh/scp 包装：配置了 DEPLOY_SSH_PASSWORD 时用 sshpass 免交互，否则回退为普通调用（交互式输密码）。
_SSH_OPTS=(-o StrictHostKeyChecking=no)
if [ -n "$DEPLOY_SSH_PASSWORD" ]; then
    command -v sshpass >/dev/null 2>&1 || fail "已配置 DEPLOY_SSH_PASSWORD 但未安装 sshpass（macOS: brew install sshpass）"
fi

run_ssh() {
    if [ -n "$DEPLOY_SSH_PASSWORD" ]; then
        sshpass -p "$DEPLOY_SSH_PASSWORD" ssh "${_SSH_OPTS[@]}" "$@"
    else
        ssh "${_SSH_OPTS[@]}" "$@"
    fi
}

run_scp() {
    if [ -n "$DEPLOY_SSH_PASSWORD" ]; then
        sshpass -p "$DEPLOY_SSH_PASSWORD" scp "${_SSH_OPTS[@]}" "$@"
    else
        scp "${_SSH_OPTS[@]}" "$@"
    fi
}

# ─── 失败回滚（EXIT trap）───────────────────────────────────────────────────
#
# 为什么必须有：本脚本 `set -euo pipefail`，任何一步失败都是**立即裸退出**。而 bump-version
# 跑在整条链的最前面（版本号 +1 写回 package.json），失败概率最高的几步——4 次交叉编译、
# 本机冒烟、--self-check、以及全部 scp——都在它之后。没有 trap 的话，中途失败会留下一个
# 已 +1 的 package.json，用户直接重跑就再 +1：一次失败烧掉一个版本号，且那个号已经带着
# tag 和 changelog 条目留在本地。
#
# 更隐蔽的连带风险：被烧掉的版本号会留下一个指向 HEAD 的 tag，而 changelog 的版本区间是
# `最新tag..HEAD`（generate-changelog.ts）。默认重跑时这个区间算出来是空的，于是新版本的
# changelog 是空的，本次真实提交全被记在那个从未发布的版本名下。
#
# 回滚策略：只恢复**本脚本自己改过的、且能安全恢复的**本地文件，绝不碰用户的其它改动。
#   - package.json / changelog 产物：仅当本次运行前它们是 clean 的才 git checkout 恢复。
#     若运行前就已脏（用户自己在改），保持原样并提示——宁可不回滚，也不能吃掉用户的改动。
#   - packages/core/vendor/rg-embed：不入库，直接重新落成本机平台（见 restore_rg_embed）。
#   - 本地 tag：**刻意不删**。tag 创建是幂等的（同名跳过），删了反而可能删掉用户手工打的。
#     只在回滚提示里告诉用户它还在。
#
# 成功路径也会走这个 trap（EXIT 无条件触发），靠 RELEASE_OK 标记区分，成功时只做
# rg-embed 的平台还原、不碰 git。

RELEASE_OK=false
ROLLBACK_FILES=()      # 本次运行前是 clean、因此可安全 git checkout 恢复的文件
BUMP_APPLIED=false

# 记录某个文件在"被本脚本修改之前"是否干净；只有干净的才登记进回滚清单。
track_for_rollback() {
    local f="$1"
    if [ -z "$(git status --porcelain -- "$f" 2>/dev/null)" ]; then
        ROLLBACK_FILES+=("$f")
    else
        warn "$f 在本次运行前已有未提交改动 —— 失败时不会自动回滚它（避免吃掉你的改动）"
    fi
}

# 把 packages/core/vendor/rg-embed 还原成**本机平台**的二进制。
# 4 平台循环会把这个固定嵌入路径依次覆盖，跑完残留的是最后一个 target（linux-arm64）。
# 不还原的话，接下来在本机跑 make build 若 --as-embed 恰好失败（Makefile 那行前导 `-`
# 忽略错误），就会把 Linux rg 嵌进本机产物 —— 静默降级，极难发现。
restore_rg_embed() {
    local self_p rg_file embed_path
    self_p="$(self_platform)"
    [ -n "$self_p" ] || return 0
    # vendor/ 不存在就没什么可还原的（也别让重定向失败往 stderr 吐裸错误）
    [ -d "$VENDOR_DIR" ] || return 0
    embed_path="$VENDOR_DIR/rg-embed"
    # 嵌入文件本来就不存在时无需处理：下次 make build 的 --as-embed 会重新落成
    [ -e "$embed_path" ] || return 0
    rg_file="$VENDOR_DIR/ripgrep/${RG_VERSION}/rg-${self_p}"
    if [ -f "$rg_file" ]; then
        cp "$rg_file" "$embed_path" 2>/dev/null || return 0
        chmod +x "$embed_path" 2>/dev/null || true
        info "已把 packages/core/vendor/rg-embed 还原为本机平台（${self_p}）"
    else
        # 本机平台的 rg 都没有，那就置空：宁可"无内嵌 rg"（设计内降级），
        # 也不能留一个其它平台的二进制在那儿等着被嵌错。
        : > "$embed_path" 2>/dev/null || true
        info "已清空 packages/core/vendor/rg-embed（缺本机平台 rg，避免残留其它平台二进制）"
    fi
}

on_exit() {
    local code=$?

    # rg-embed 无论成败都要还原成本机平台（它是跨命令共享的可变状态）
    restore_rg_embed

    if [ "$RELEASE_OK" = true ] || [ "$code" -eq 0 ]; then
        return
    fi

    echo "" >&2
    # ⚠ 变量必须用 ${} 包裹：macOS 自带 bash 3.2 会把紧随其后的**全角字符**字节
    # 当成变量名的一部分（`$code）` → 变量名 "code）"），`set -u` 下直接
    # "unbound variable" 致命退出 —— 那会让回滚逻辑恰好在最需要它的时候崩掉。
    echo "  ══ 发布中断（退出码 ${code}），正在回滚本地状态 ══" >&2

    if [ ${#ROLLBACK_FILES[@]} -gt 0 ]; then
        # git checkout -- 只作用于登记过的、运行前 clean 的文件，不会波及其它改动
        if git checkout -- "${ROLLBACK_FILES[@]}" 2>/dev/null; then
            for f in "${ROLLBACK_FILES[@]}"; do
                info "已回滚 $f"
            done
        else
            warn "自动回滚失败，请手动检查：${ROLLBACK_FILES[*]}"
        fi
    fi

    if [ "$BUMP_APPLIED" = true ]; then
        local now_ver
        now_ver="$(bun -e "console.log(require('./package.json').version)" 2>/dev/null || echo "?")"
        echo "  版本号已恢复为 v${now_ver}（本次未发布成功，版本号不该被消耗）" >&2
    fi

    if [ -n "${TAG:-}" ] && git rev-parse -q --verify "refs/tags/$TAG" >/dev/null 2>&1; then
        echo "  ⓘ 本地 tag $TAG 仍存在（未自动删除，创建是幂等的）。" >&2
        echo "    重跑本脚本会复用它；确认不需要可手动 git tag -d $TAG" >&2
    fi

    echo "  修复问题后直接重跑即可（版本号已回滚，无需 --no-bump）。" >&2
}

trap on_exit EXIT

# ─── 单独上传团队默认配置（不涉及版本构建）───

if [ "$DO_UPLOAD_TEAM_DEFAULTS" = true ]; then
    [ -f "$TEAM_DEFAULTS_FILE" ] || fail "文件不存在: $TEAM_DEFAULTS_FILE"
    require_ssh_user
    echo ">>> 上传团队默认配置 $TEAM_DEFAULTS_FILE ..."
    run_scp "$TEAM_DEFAULTS_FILE" "${DEPLOY_SSH_USER}@${DEPLOY_SSH_HOST}:${DEPLOY_PATH}/team-defaults.json"
    ok "team-defaults.json 已更新"
    exit 0
fi

# ─── 单独上传预编译 ripgrep 二进制（不涉及版本构建）───
# 目录内按平台命名：rg-darwin-arm64 / rg-darwin-x64 / rg-linux-x64 / rg-linux-arm64。
# 上传到 ${DEPLOY_RG_PATH}/<version>/，与 fetch-ripgrep.ts 的下载路径约定一致；
# 同时生成 .sha256 供下载时完整性校验。目录内缺某个平台文件时跳过该平台（非致命）。

if [ "$DO_UPLOAD_RIPGREP" = true ]; then
    [ -d "$RIPGREP_DIR" ] || fail "目录不存在: $RIPGREP_DIR"
    require_ssh_user
    echo ">>> 上传 ripgrep 二进制 v${RIPGREP_VERSION}（来自 ${RIPGREP_DIR}）..."
    RG_REMOTE_DIR="${DEPLOY_RG_PATH}/${RIPGREP_VERSION}"
    run_ssh "${DEPLOY_SSH_USER}@${DEPLOY_SSH_HOST}" "mkdir -p '${RG_REMOTE_DIR}'"

    _rg_uploaded=0
    for plat in darwin-arm64 darwin-x64 linux-x64 linux-arm64; do
        f="$RIPGREP_DIR/rg-${plat}"
        if [ ! -f "$f" ]; then
            warn "跳过缺失: rg-${plat}（目录内未找到）"
            continue
        fi
        SHA="$(sha256_of "$f")"
        echo "$SHA" > "${f}.sha256"
        info "上传 rg-${plat} ..."
        run_scp "$f" "${DEPLOY_SSH_USER}@${DEPLOY_SSH_HOST}:${RG_REMOTE_DIR}/rg-${plat}"
        run_scp "${f}.sha256" "${DEPLOY_SSH_USER}@${DEPLOY_SSH_HOST}:${RG_REMOTE_DIR}/rg-${plat}.sha256"
        _rg_uploaded=$((_rg_uploaded + 1))
    done

    [ "$_rg_uploaded" -gt 0 ] || fail "目录内没有找到任何 rg-<platform> 文件（期望文件名如 rg-darwin-arm64）"
    ok "ripgrep v${RIPGREP_VERSION} 已上传（${_rg_uploaded}/4 平台）"
    echo "  下次 release.sh / make build 会自动通过 fetch-ripgrep.ts 拉取并嵌入"
    exit 0
fi

echo "=== sid-code 发布构建 ==="
echo ""

cd "$ROOT"

# ─── 发布前门禁：全量单测（可 --skip-test 跳过）───

if [ "$DO_TEST" = true ]; then
    echo ">>> 发布前门禁：bun test ..."
    bun test || fail "单测未通过，发布中止（如需救急跳过：--skip-test）"
    ok "单测通过"
    echo ""
else
    warn "已跳过发布前 bun test 门禁（--skip-test）"
    echo ""
fi

# ─── 工作区洁净门禁（机械化执行 CLAUDE.md §1 的"产物必须对应确切 commit"铁律）───
#
# 这条铁律以前只写在文档里，靠人记。但发布产物是从**工作区**编译的：工作区脏就意味着
# 产物包含未提交代码，出线上问题时无法定位到确切源码版本——正是铁律要防的事。
# 姊妹脚本 website-deploy.sh 早就有同款门禁（--allow-dirty），这里补齐，保持一致。
#
# 注意必须放在 bump 之前：bump 自己就会让工作区变脏。

if [ "$ALLOW_DIRTY" = false ]; then
    _dirty="$(git status --porcelain 2>/dev/null || true)"
    if [ -n "$_dirty" ]; then
        echo "  ❌ git 工作区有未提交改动 —— 发布产物须能对应确切 commit（CLAUDE.md §1 铁律）。" >&2
        echo "" >&2
        printf '%s\n' "$_dirty" | head -20 >&2
        echo "" >&2
        echo "  正确做法：先提交功能代码，再发布（禁止先发布后提交）。" >&2
        fail "确认无碍可加 --allow-dirty 跳过本门禁"
    fi
    ok "工作区干净"
else
    warn "已跳过工作区洁净门禁（--allow-dirty）：产物可能包含未提交代码"
fi
echo ""

# ─── 版本号（只 bump 一次，4 个目标复用）───

if [ "$DO_BUMP" = true ]; then
    track_for_rollback "package.json"
    bun run scripts/bump-version.ts
    BUMP_APPLIED=true
else
    echo "  跳过 bump-version（--no-bump）：复用 package.json 当前版本号"
fi
VERSION="$(bun -e "console.log(require('./package.json').version)")"
echo "  版本: v$VERSION"
echo ""

# ─── 生成 changelog（bump 之后；tag 推迟到构建通过之后，见下方"提交 bump + 打 tag"）───
TAG="v$VERSION"

# ─── curated 文案前置检查（在生成 changelog 之前，此刻改还来得及）───
#
# 官网 /changelog 的正文来自 changelog/curated/v<version>.json（LLM 起草 + 人工过目、
# 已入库）。本脚本**只读**它，绝不调 LLM —— 发布路径必须确定性 + 离线 + 幂等。
#
# 为什么提示放在这里而不是靠 generate-changelog.ts 的 warn：那条 warn 出现在
# 构建、冒烟、提交、打 tag **全都跑完之后**的日志里，人看到时版本已经发出去了，
# 补救要重新发一版。放在 bump 之后、构建之前，此刻只花了几秒钟，跑一次 curate 就能补上。
#
# 刻意**只提示不阻断**：curate 要跑一次 LLM（分钟级）+ 人工过目，把它做成硬门禁
# 等于「想发个紧急修复必须先等模型写文案」。缺文案的后果是官网那一版显示
# 「本版没有用户可见的变更」—— 不好，但不该拦住发布。
_CURATED_FILE="changelog/curated/v${VERSION}.json"
if [ ! -f "$ROOT/$_CURATED_FILE" ]; then
    warn "缺少用户视角文案：$_CURATED_FILE"
    warn "官网 /changelog 的 v$VERSION 将显示「本版没有用户可见的变更」。"
    info "现在补（推荐，几分钟）："
    info "    bun run changelog:curate $VERSION   # 生成后过目，需要就直接改 JSON"
    info "    git add $_CURATED_FILE && git commit"
    info "然后重跑本脚本（加 --no-bump 复用已 bump 的 v${VERSION}）。"
    if [ -t 0 ] && [ -e /dev/tty ]; then
        printf "  不写文案，继续发布？(y/N) "
        read -r _ans </dev/tty || _ans=""
        case "$_ans" in
            y|Y|yes|YES) info "已确认，继续（v$VERSION 在官网无变更说明）" ;;
            *) fail "已取消。补完 curated 文案后重跑（--no-bump 复用 v${VERSION}）。" ;;
        esac
    else
        # 非交互（CI / 管道）下不能卡住等输入，降级为 warn 继续
        warn "非交互环境，跳过确认，继续发布"
    fi
    echo ""
else
    ok "已有用户视角文案：$_CURATED_FILE"
fi

echo ">>> 生成 changelog (v$VERSION) ..."
for _f in CHANGELOG.md website/.vitepress/data/changelog.json; do
    track_for_rollback "$_f"
done
bun run scripts/generate-changelog.ts "$VERSION" || warn "changelog 生成失败（不阻断发布）"
echo ""

# ─── --no-bump 覆盖同版本告警：上传前先探测服务器是否已存在该版本 ───

if [ "$DO_UPLOAD" = true ] && [ "$DO_BUMP" = false ]; then
    require_ssh_user
    if run_ssh "${DEPLOY_SSH_USER}@${DEPLOY_SSH_HOST}" "test -d '${DEPLOY_PATH}/${VERSION}'" 2>/dev/null; then
        warn "服务器上已存在版本 v${VERSION}，继续将【覆盖】该版本的现有产物。"
        printf "  确认覆盖？(y/N) "
        read -r _ans </dev/tty || _ans=""
        case "$_ans" in
            y|Y|yes|YES) info "已确认，继续覆盖 v$VERSION" ;;
            *) fail "已取消（避免误覆盖 v${VERSION}）。如需新版本，去掉 --no-bump 重跑。" ;;
        esac
        echo ""
    fi
fi

# ─── 内嵌 skill（只跑一次，与目标架构无关）───

echo ">>> 生成内嵌 skill..."
bun run scripts/embed-builtin-skills.ts
echo ""

# ─── 准备内嵌 ripgrep（4 平台，best-effort）───
# packages/core/vendor/ripgrep/<version>/rg-<platform> 已 git 提交入库，优先直接复用（全程不联网）；
# 仓库内缺失（如刚 bump 版本号还没提交）才回退联网下载服务器。服务器缺文件不阻断发布，
# 产物退化为「无内嵌 rg，运行时回退系统 rg」——与本功能上线前的行为完全一致。

echo ">>> 准备内嵌 ripgrep（4 平台，best-effort）..."
if bun run scripts/fetch-ripgrep.ts --all; then
    ok "ripgrep 二进制就绪"
else
    warn "准备 ripgrep 二进制失败（仓库内缺失且服务器也拉不到，见 --upload-ripgrep）。本次产物不含内嵌 rg，运行时回退系统 rg，不影响发布。"
fi
echo ""

# ─── 清理旧产物 ───
# dist/release/ 本地目录结构与服务器完全镜像：install.sh + latest.txt 在顶层，
# tarball/sha256 落在 <version>/ 子目录 —— 这样 file://dist/release 本地测试
# 和真实服务器上 http://.../releases/sid-code 走的是同一套相对路径逻辑。

VERSION_DIR="$RELEASE_DIR/$VERSION"
rm -rf "$BUILD_DIR" "$RELEASE_DIR"
mkdir -p "$BUILD_DIR" "$VERSION_DIR"

# ─── 循环交叉编译 4 个目标 ───

SELF_PLATFORM="$(self_platform)"
SELF_SMOKE_DONE=false

for entry in "${TARGETS[@]}"; do
    BUN_TARGET="${entry%%:*}"
    PLATFORM="${entry##*:}"

    echo ">>> 构建 $PLATFORM ($BUN_TARGET) ..."
    OUT_DIR="$BUILD_DIR/$PLATFORM"
    mkdir -p "$OUT_DIR"

    # ─── 切换嵌入的 rg 二进制为当前 target 对应平台 ───
    # packages/core/vendor/rg-embed 是 bun --compile 的固定嵌入 import 路径（见 packages/core/src/tool/rg-embedded.ts）。
    # 明确置空（而非跳过）以避免复用上一个 target 残留的错误平台二进制。
    RG_VENDOR_FILE="$VENDOR_DIR/ripgrep/${RG_VERSION}/rg-${PLATFORM}"
    if [ -f "$RG_VENDOR_FILE" ]; then
        cp "$RG_VENDOR_FILE" "$VENDOR_DIR/rg-embed"
        chmod +x "$VENDOR_DIR/rg-embed"
    else
        : > "$VENDOR_DIR/rg-embed"
        warn "未找到 packages/core/vendor/ripgrep/${RG_VERSION}/rg-${PLATFORM}，本次 ${PLATFORM} 产物不含内嵌 rg（运行时回退系统 rg）"
    fi

    # --define process.env.NODE_ENV：必须带，别删（与 Makefile 的 BUILD_DEFINES 同源同理由）。
    # bun --compile 不会自动设 NODE_ENV，产物运行时恒为 "development"，
    # react-reconciler 会因此加载 development build，其 console.error(
    # "Maximum update depth exceeded ... setState inside useEffect ...") 会直接刷用户的屏
    # （不 throw → 错误边界抓不到、进程不崩、日志无痕）。详见 Makefile 中 BUILD_DEFINES 的注释。
    bun build --compile --target="$BUN_TARGET" \
        --define process.env.NODE_ENV='"production"' \
        --outfile "$OUT_DIR/sid-code" \
        packages/cli/src/entrypoints/bootstrap.ts

    [ -f "$OUT_DIR/sid-code" ] || fail "构建失败: 未找到 $OUT_DIR/sid-code"
    chmod +x "$OUT_DIR/sid-code"

    # ─── 冒烟测试：只有当前平台的产物能在本机执行，跑一次 --version 挡住损坏产物 ───

    if [ -n "$SELF_PLATFORM" ] && [ "$PLATFORM" = "$SELF_PLATFORM" ]; then
        SMOKE_VER="$("$OUT_DIR/sid-code" --version 2>/dev/null)" \
            || fail "冒烟测试失败：$PLATFORM 产物无法执行 --version，发布中止"
        ok "冒烟测试通过（${PLATFORM}）: $SMOKE_VER"
        # 方向 0（编译产物自检）：本平台产物额外跑 --self-check，断言 git-status 仲裁锚点等
        # 关键修复已内联进二进制。堵住"源码有修复但编译产物没跟上"的发布陷阱——那正是
        # git-status 快照冻结死循环的直接触发因素（根因分析-commit任务git状态快照冻结死循环.md）。
        "$OUT_DIR/sid-code" --self-check \
            || fail "自检失败：$PLATFORM 产物缺失关键修复（git-status 锚点等），发布中止"
        ok "编译产物自检通过（${PLATFORM}）"
        SELF_SMOKE_DONE=true
    fi

    # ─── 打包 tar.gz（staging 成 sid-code/sid-code，install.sh 用 --strip-components=1 解压）───

    STAGING="$BUILD_DIR/_staging_$PLATFORM"
    rm -rf "$STAGING"
    mkdir -p "$STAGING/sid-code"
    cp "$OUT_DIR/sid-code" "$STAGING/sid-code/sid-code"
    chmod +x "$STAGING/sid-code/sid-code"

    TARBALL_NAME="sid-code-${VERSION}-${PLATFORM}.tar.gz"
    tar -czf "$VERSION_DIR/$TARBALL_NAME" -C "$STAGING" sid-code
    rm -rf "$STAGING"

    # ─── sha256 ───

    SHA="$(sha256_of "$VERSION_DIR/$TARBALL_NAME")"
    echo "$SHA  $TARBALL_NAME" > "$VERSION_DIR/${TARBALL_NAME}.sha256"

    SIZE="$(du -h "$VERSION_DIR/$TARBALL_NAME" | cut -f1)"
    ok "$TARBALL_NAME ($SIZE, sha256=${SHA:0:12}...)"
done

if [ "$SELF_SMOKE_DONE" = false ]; then
    warn "当前平台（$(uname -s)/$(uname -m)）不在构建目标内，跳过本机冒烟测试"
fi

echo ""

# ─── 提交 bump + 打 annotated tag（构建与冒烟全部通过之后）─────────────────────
#
# ★为什么放在这里、且由脚本自己提交（2026-08-01 修复）：
#
# 旧流程是「tag 打在 bump 之前的 HEAD 上，bump 提交由用户在脚本结束后手工补做」。
# 后果是 tag 指向的那个 commit 里 package.json 版本号比 tag **低一位**——实测
# v0.1.591…v0.1.596 六个 tag 无一例外全部错位。于是 `git checkout v0.1.596` 构建出的
# 二进制自报 0.1.595，**没有任何 git 引用能重建出线上那个二进制**，CLAUDE.md §1 那条
# "发布产物必须能对应到一个确切 git commit，否则出线上问题无法定位到确切代码版本"
# 的铁律在事实上是失效的——而且失效方式恰好就是它想防的。
#
# 修法：脚本自己把 bump + changelog 产物提交掉，再把 tag 打在**这个**提交上。
# 于是 tag ↔ 源码版本号天然对齐，无需依赖人记得补第 4 步。
#
# 放在构建/冒烟/自检**之后**：这些步骤是最可能失败的，失败时不该留下提交和 tag。
# 到了这一行，产物已经证明可用，提交才有意义。
# 上传仍在其后——tag 的 push 继续推迟到上传成功之后，不为尚未上线的版本对外广播。
#
# generate-changelog.ts 会过滤 `^bump v\d` 的提交，所以这个自动提交不会污染 changelog。

RELEASE_COMMIT_FILES=(
    package.json
    CHANGELOG.md
    website/.vitepress/data/changelog.json
    packages/core/src/skill/builtin-embedded.generated.ts
)

if [ "$NO_COMMIT" = true ]; then
    warn "已跳过自动提交（--no-commit）：tag 将打在当前 HEAD 上，可能与 package.json 版本号错位"
elif [ "$DO_BUMP" = false ]; then
    info "跳过自动提交（--no-bump：版本号未变，无 bump 需要提交）"
else
    echo ">>> 提交版本号 + changelog 产物 ..."
    # 只 add 本脚本自己产出的文件，绝不 git add -A（避免把用户无关改动裹进发布提交）
    _to_commit=()
    for _f in "${RELEASE_COMMIT_FILES[@]}"; do
        [ -e "$ROOT/$_f" ] && _to_commit+=("$_f")
    done
    # ⚠ macOS 自带 bash 3.2：`set -u` 下展开**空数组** "${arr[@]}" 会直接
    # "unbound variable" 致命退出（bash 4.4+ 才修）。所以必须先判长度再展开。
    if [ ${#_to_commit[@]} -eq 0 ]; then
        warn "没有任何待提交产物存在，跳过提交"
    else
        git add -- "${_to_commit[@]}" || fail "git add 失败"
    fi

    if git diff --cached --quiet; then
        info "无内容需要提交（产物与 HEAD 一致）"
    else
        git commit -q -m "bump ${TAG}" || fail "git commit 失败"
        # 提交成功后这些文件已进入历史，回滚清单作废：再 checkout 会把发布提交的内容清掉
        ROLLBACK_FILES=()
        BUMP_APPLIED=false
        ok "已提交 bump ${TAG}（$(git rev-parse --short HEAD)）"
    fi
fi

if git rev-parse -q --verify "refs/tags/$TAG" >/dev/null 2>&1; then
    warn "tag $TAG 已存在，跳过创建（--no-bump 复用场景）"
else
    if git tag -a "$TAG" -m "Release $TAG"; then
        ok "已创建 tag ${TAG}（HEAD=$(git rev-parse --short HEAD)）"
        # 立刻验证对齐，把"错位一位"这类回归钉死在发布时刻而不是事后考古
        _tag_pkg_ver="$(git show "$TAG:package.json" 2>/dev/null | bun -e "
            let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{
              try{console.log(JSON.parse(s).version)}catch{console.log('')}
            })" 2>/dev/null || echo "")"
        if [ -n "$_tag_pkg_ver" ] && [ "$_tag_pkg_ver" != "$VERSION" ]; then
            warn "tag $TAG 指向的提交里 package.json 是 v${_tag_pkg_ver}（期望 v${VERSION}）——"
            warn "  该 tag 无法重建出本次发布的二进制。若用了 --no-commit，这是预期行为。"
        else
            ok "tag ↔ 源码版本号对齐校验通过（v${VERSION}）"
        fi
    else
        warn "tag 创建失败（不阻断发布）"
    fi
fi
echo ""

# ─── 生成 install.sh：把 PUBLIC_BASE_URL 注入为下载地址，对外地址只需在 deploy.env 改一处 ───
#
# 替换目标是模板里的 origin（https://www.sid-code.cc），不是 DEPLOY_SSH_HOST：
# install.sh 是给用户 curl 的，必须用带证书的对外域名；SSH 上传目标（可能是 IP）
# 绝不能泄进这份脚本，否则用户走 IP → 301 https → 证书不匹配 → 安装失败。

sed "s#https://www\.sid-code\.cc#${PUBLIC_BASE_URL}#g" \
    "$SCRIPT_DIR/install-template.sh" > "$RELEASE_DIR/install.sh"
chmod +x "$RELEASE_DIR/install.sh"
echo "$VERSION" > "$RELEASE_DIR/latest.txt"

# 把仓库根 CHANGELOG.md 纳入发布产物（服务器顶层），让 file://$RELEASE_DIR
# 本地验证与真实上传走同一套相对路径逻辑。MD 是文本事实源。
if [ -f "$ROOT/CHANGELOG.md" ]; then
    cp "$ROOT/CHANGELOG.md" "$RELEASE_DIR/CHANGELOG.md"
fi

echo "=== 发布产物（${RELEASE_DIR}）==="
ls -1 "$RELEASE_DIR"
echo "  --- v$VERSION ---"
ls -1 "$VERSION_DIR"
echo ""
echo "  本地验证（不碰真实服务器）："
echo "    RELEASE_BASE=\"file://$RELEASE_DIR\" bash $RELEASE_DIR/install.sh"

# ─── 北极星指标快照（P1-5 第一层：版本间对比）───────────────────────────────
#
# 位置：构建之后、上传之前。
#   · 放构建后 —— 快照要标的是"这个版本"，而版本号在 bump 之后才确定；
#   · 放上传前 —— 让维护者在真正对外广播之前看到"这版比上版是快了还是慢了"。
#
# 三条禁令（与 changelog 那四条同源：发布路径必须确定性 + 离线 + 幂等）：
#   ① **绝不调 LLM**。northstar-snapshot.ts 全程只读本地 jsonl，无网络无模型。
#   ② 失败**不阻断发版**（`|| warn`）。快照是观测产物，不是发布物 —— 让一份统计
#      写不下去而中止一次已经构建+冒烟+自检全过的发布，是拿因果关系换整洁。
#   ③ 指标退步**只报告不拦**。发版门禁已经够多（工作区洁净 + bun test + 冒烟 +
#      自检）；再加一道基于统计量的门禁会因样本波动误拦，而人一旦被误拦过就会
#      养成加 --skip 的习惯，最后连报告都不看了 —— 那是比没有门禁更差的结局。
#
# 产出两份（都在 northstar/，随仓库入库，让曲线可追溯）：
#   · northstar/v<version>.json   本版快照（4 主指标 + 辅助指标 + 每项的 n）
#   · northstar/latest-delta.md   与上一版逐指标 diff；首次发版输出"基线已建立"
echo ""
echo ">>> 生成北极星指标快照（v${VERSION}）..."
if bun run "$ROOT/scripts/northstar-snapshot.ts" --version "$VERSION" --emit "$ROOT/northstar"; then
    # 把 delta 直接打到发布日志里：写进文件但没人看的报告等于没有报告
    if [ -f "$ROOT/northstar/latest-delta.md" ]; then
        echo ""
        echo "  --- 与上一版对比（只报告，不阻断）---"
        sed 's/^/  /' "$ROOT/northstar/latest-delta.md"
    fi
else
    warn "北极星快照生成失败（不阻断发布）"
fi

# ─── 上传（可选）───

if [ "$DO_UPLOAD" = true ]; then
    require_ssh_user
    echo ""
    echo ">>> 上传到 ${DEPLOY_SSH_USER}@${DEPLOY_SSH_HOST}:${DEPLOY_PATH} ..."

    # ─── 版本目录：先传进临时目录，全部就位并校验通过后再原子 mv 到正式路径 ──────────
    #
    # 旧写法是 `mkdir -p <path>/<version>` 后直接往里逐个 scp。中途任何一个 scp 失败
    # （网络抖动、磁盘满、Ctrl-C）都会在服务器上留下一个**只含部分平台**的版本目录，
    # 脚本既不清理也不告知。latest.txt 放最后确实挡住了"用户装到半成品版本"的主路径，
    # 但挡不住这些：
    #   · 重跑若带 --no-bump，覆盖上传时残留的旧平台文件不会被清掉（新旧文件混在一个目录）；
    #   · 用户/脚本按显式版本号直接取 URL（不读 latest.txt）时会拿到 404 或残缺集合；
    #   · 服务器端清理逻辑按目录计数保留 N 个版本，半成品目录也占一个名额。
    #
    # 改为 staging + mv：mv 在同一文件系统内是原子的，正式目录要么不存在、要么内容完整。
    # 临时目录带 $$（PID）后缀避免并发发布互相踩，失败时由远端 trap 自己清掉。
    _remote_staging="${DEPLOY_PATH}/.upload-${VERSION}-$$"
    run_ssh "${DEPLOY_SSH_USER}@${DEPLOY_SSH_HOST}" "mkdir -p '${_remote_staging}'" \
        || fail "创建远程临时目录失败: ${_remote_staging}"

    # 任何一步失败都要清掉远端半成品，否则残留一堆 .upload-* 垃圾目录
    _cleanup_remote_staging() {
        run_ssh "${DEPLOY_SSH_USER}@${DEPLOY_SSH_HOST}" "rm -rf '${_remote_staging}'" 2>/dev/null || true
    }

    for f in "$VERSION_DIR"/*; do
        info "上传 $(basename "$f") ..."
        run_scp "$f" "${DEPLOY_SSH_USER}@${DEPLOY_SSH_HOST}:${_remote_staging}/" || {
            _cleanup_remote_staging
            fail "上传 $(basename "$f") 失败，已清理远端半成品目录（服务器上的 v${VERSION} 未被改动）"
        }
    done

    # ─── 落地前校验：在服务器上比对 sha256，挡住传输过程中的静默损坏 ───
    # 本地生成过 .sha256，但此前从没在服务器侧验过——传坏了要等用户安装时才发现。
    info "服务器端校验 sha256 ..."
    _verify_cmd="cd '${_remote_staging}' || exit 1
for s in *.sha256; do
    [ -e \"\$s\" ] || continue
    if command -v sha256sum >/dev/null 2>&1; then
        sha256sum -c \"\$s\" >/dev/null 2>&1 || { echo \"校验失败: \$s\"; exit 1; }
    elif command -v shasum >/dev/null 2>&1; then
        shasum -a 256 -c \"\$s\" >/dev/null 2>&1 || { echo \"校验失败: \$s\"; exit 1; }
    else
        echo \"__NO_SHA_TOOL__\"; exit 0
    fi
done
echo __SHA_OK__"
    _verify_out="$(run_ssh "${DEPLOY_SSH_USER}@${DEPLOY_SSH_HOST}" "$_verify_cmd" 2>&1)" || {
        _cleanup_remote_staging
        fail "服务器端 sha256 校验失败（产物可能在传输中损坏）：${_verify_out}"
    }
    case "$_verify_out" in
        *__SHA_OK__*)        ok "sha256 校验通过（${#TARGETS[@]} 个平台产物）" ;;
        *__NO_SHA_TOOL__*)   warn "服务器上没有 sha256sum/shasum，跳过落地前校验" ;;
        *)                   _cleanup_remote_staging
                             fail "服务器端 sha256 校验输出异常：${_verify_out}" ;;
    esac

    # ─── 原子切换：旧目录先挪走，新目录 mv 到位，成功后再删旧 ───
    info "原子切换到 ${DEPLOY_PATH}/${VERSION} ..."
    _swap_cmd="set -e
cd '${DEPLOY_PATH}'
_old=''
if [ -d '${VERSION}' ]; then
    _old='.old-${VERSION}-$$'
    mv '${VERSION}' \"\$_old\"
fi
if mv '.upload-${VERSION}-$$' '${VERSION}'; then
    [ -n \"\$_old\" ] && rm -rf \"\$_old\"
    exit 0
else
    # 切换失败：把旧目录放回去，保证服务器停留在切换前的可用状态
    [ -n \"\$_old\" ] && mv \"\$_old\" '${VERSION}'
    exit 1
fi"
    run_ssh "${DEPLOY_SSH_USER}@${DEPLOY_SSH_HOST}" "$_swap_cmd" || {
        _cleanup_remote_staging
        fail "原子切换失败（服务器上的 v${VERSION} 保持切换前状态）"
    }
    ok "v${VERSION} 目录已完整就位"

    run_scp "$RELEASE_DIR/install.sh" "${DEPLOY_SSH_USER}@${DEPLOY_SSH_HOST}:${DEPLOY_PATH}/install.sh"

    # 上传顶层 CHANGELOG.md（供用户通过链接查看版本变更）
    if [ -f "$RELEASE_DIR/CHANGELOG.md" ]; then
        info "上传 CHANGELOG.md ..."
        run_scp "$RELEASE_DIR/CHANGELOG.md" "${DEPLOY_SSH_USER}@${DEPLOY_SSH_HOST}:${DEPLOY_PATH}/CHANGELOG.md"
    fi

    # latest.txt 放最后：确保它指向的版本此时已经完整上传
    run_scp "$RELEASE_DIR/latest.txt" "${DEPLOY_SSH_USER}@${DEPLOY_SSH_HOST}:${DEPLOY_PATH}/latest.txt"

    # ─── 服务器端清理旧版本：保留最近 RELEASE_KEEP_VERSIONS 个版本目录 ───
    # 只删除形如 <path>/<x.y.z>/ 的版本目录，install.sh / latest.txt / team-defaults.json 不受影响。
    info "清理服务器旧版本（保留最近 ${RELEASE_KEEP_VERSIONS} 个）..."
    # 用普通双引号字符串构建远程命令（不用 heredoc-in-$()，规避 macOS bash 3.2 解析 bug）。
    # 本地展开：DEPLOY_PATH / 保留数量；远程展开：$d 等（用 \$ 转义留给远端 shell）。
    _keep_plus_one=$((RELEASE_KEEP_VERSIONS + 1))
    CLEANUP_CMD="cd '${DEPLOY_PATH}' 2>/dev/null || exit 0
ls -1dt */ 2>/dev/null | tail -n +${_keep_plus_one} | while IFS= read -r d; do
    d=\"\${d%/}\"
    case \"\$d\" in
        *[0-9].*[0-9].*[0-9]) rm -rf -- \"\$d\" && echo \"  已删除旧版本 \$d\" ;;
    esac
done"
    run_ssh "${DEPLOY_SSH_USER}@${DEPLOY_SSH_HOST}" "$CLEANUP_CMD" || warn "旧版本清理失败（不影响本次发布）"

    # ─── 上传成功后推送 tag ───
    # 推到 origin，让发布产物对应的 commit 在远端有确切 tag 标记。失败非致命：
    # 用户在铁律最后一步的 git push 也会把本地 tag 一并推上去。
    if git rev-parse -q --verify "refs/tags/$TAG" >/dev/null 2>&1; then
        info "推送 tag $TAG 到 origin ..."
        git push origin "$TAG" || warn "tag 推送失败，可稍后手动 git push origin $TAG"

        # ─── 建 GitHub Release（正文取自 curated 文案）───
        # 补的是一个真实缺口：这一步以前**根本不存在**，仓库里 v0.1.591…v0.1.600 那 10 个
        # Release 全部创建于 2026-08-13T02:22 那两分钟内（开源首发时一次性人工回填），
        # 之后每次发版 tag 都推了、Release 却没人建 —— 而 GitHub 仓库首页把最新 Release
        # 当作"当前版本"展示，于是页面上长期停在一个旧版本。
        #
        # 必须放在 tag 推送**之后**：Release 挂在 tag 上，tag 不在远端时 gh 会自建一个
        # 指向默认分支 HEAD 的 tag（脚本里也另有一道显式检查兜这个）。
        #
        # 失败一律 warn 不阻断：制品此刻已经上线且 sha256 校验过了，
        # 一个没建成的 Release 页不该让发布流程判定为失败（手动补跑一行就行）。
        info "建 GitHub Release $TAG ..."
        if command -v gh >/dev/null 2>&1; then
            bun run "$ROOT/scripts/github-release.ts" "$VERSION" --create \
                || warn "GitHub Release 创建失败（不阻断发布）：可手动补跑 bun run scripts/github-release.ts ${VERSION} --create"
        else
            warn "未装 gh CLI，跳过 GitHub Release（可稍后手动补跑 bun run scripts/github-release.ts ${VERSION} --create）"
        fi
    fi

    echo ""
    ok "发布完成！安装命令："
    echo "    curl -fsSL ${PUBLIC_BASE_URL}/releases/sid-code/install.sh | bash"
    echo ""
    echo "  📄 更新日志（官网）: ${PUBLIC_BASE_URL}/changelog"
    echo "  📄 更新日志（文本）: ${PUBLIC_BASE_URL}/releases/sid-code/CHANGELOG.md"
    echo ""
    echo "  ⚠️  官网 /changelog 是站点构建期快照，本次发布还没上线到站点。"
    echo ""

    # ─── 收尾指引：bump 提交怎么进 main ───
    #
    # 这一段 2026-08-21 加。此前脚本只说「按铁律补完 bump 提交后跑 website-deploy.sh」，
    # 而铁律写的是 `git push` —— 那条命令在本仓**必然失败**：ruleset `protect-main`
    # 要求 PR + all-checks-passed，直推被 GH013 拒
    # （`Changes must be made through a pull request`）。
    #
    # 后果不是"多打几条命令"那么轻：此刻**制品已上线、tag 已推送，而 bump 提交还在本地**，
    # 正是铁律要防的「已发布但未提交」窗口，只不过成因从人的疏忽变成了门禁冲突。
    # 照着一条注定失败的指引走，人会在这个窗口里卡住 —— 所以这里按实际保护状态给出
    # **能跑通**的命令，而不是让人先撞一次 GH013 再自己想办法。
    #
    # ⚠ 合并方式必须是 merge 不能 squash：tag 已经打在 bump 提交上，squash 会另造一个
    # 提交、原提交不进 main，于是 tag 指向一个游离提交 —— `git checkout <tag>` 仍能用，
    # 但 `git merge-base --is-ancestor <tag> main` 会失败，"产物对应确切 commit"这条
    # 就退化成"对应一个不在主线上的 commit"。本仓 allow_merge_commit=true，用 --merge。
    _release_branch="chore/release-${VERSION}"
    if git remote get-url origin >/dev/null 2>&1 &&
        git ls-remote --exit-code --heads origin "$(git rev-parse --abbrev-ref HEAD)" >/dev/null 2>&1 &&
        [ "$(git rev-parse --abbrev-ref HEAD)" = "main" ]; then
        echo "  ⚠️  main 受 ruleset protect-main 保护，\`git push\` 会被 GH013 拒绝。"
        echo "      bump 提交（tag 就打在它上面）需要走 PR 才能进 main："
        echo ""
        echo "          git switch -c ${_release_branch}"
        echo "          git push -u origin ${_release_branch}"
        echo "          gh pr create --base main --fill"
        echo "          gh pr merge --auto --merge   # ⚠ 必须 --merge，不能 squash（见下）"
        echo ""
        echo "      squash 会另造提交，tag 就指向一个不在 main 上的游离提交。"
        echo "      合并后回到 main 并同步，再发布官网："
        echo ""
        echo "          git switch main && git pull"
        echo "          ./scripts/website-deploy.sh"
    else
        echo "      按铁律补完 bump 提交后，再跑一次："
        echo "          git push && ./scripts/website-deploy.sh"
    fi
else
    echo ""
    echo "  提示：加 --upload 参数可上传到服务器（凭据读自 scripts/deploy.env）"
fi
