#!/usr/bin/env bash
#
# SWE-bench 阶段 A —— 容器编排（§4.4 gold 自检 / §4.5 runner / §4.6 判分）
#
# 事实源：`接入计划.md` §4.4 / §4.5 / §4.6
#
# ## 为什么编排在 shell 而不在 TS 里
#
# 这一层做的全是 `docker cp` / `docker exec` / 起停容器，中间没有一处需要
# 数据结构。放进 TS 只会把每条 docker 命令包一层 `Bun.spawnSync`，
# 而**出错时看到的是被包了一层的输出**，排查要先剥壳。
# 判定逻辑（哪些字段、怎么映射、什么算 ungraded）在 `runner.ts` / `grade.ts`，
# 那部分有单测；shell 这一层刻意只做搬运，不做判断。
#
# ## 用法
#
#   # ① gold 自检（§4.4）：环境错 vs 能力差的唯一分离手段
#   ./exec-swebench.sh gold pytest-dev__pytest-7982
#
#   # ② 跑 agent（§4.5）
#   ./exec-swebench.sh run smoke-1                    # 全部 10 条
#   ./exec-swebench.sh run smoke-1 pytest-dev__pytest-7982   # 单条
#
#   # ③ 判分（§4.6）：丢给官方 harness，不自己判
#   ./exec-swebench.sh grade smoke-1
#
# 环境变量：
#   SC_BASE_URL / SC_API_KEY   模型网关（**只走 exec env，绝不进 argv**）
#   SC_MODEL                   被测模型名（sid-code 侧的 `name`），**必填**。
#                              ⚠️ 这个值必须记进 run meta 才能复算：换了模型的两次 run
#                              分数没有可比性，而模型名不落盘的话事后分不清是哪个模型跑的。
#                              以前写死成 `"name":"m"` —— 那对网关是无效模型名，
#                              网关会用它的默认模型顶上，于是**跑的是哪个模型完全不可知**。
#   SC_MODEL_ID                发往网关的**真实模型 id**（wire model），缺省 = SC_MODEL。
#                              ⚠️ sid-code 的 `name` 是**本地别名**，`modelId` 才进 HTTP 请求体
#                              （见 `packages/core/src/config/config.ts` 的 ModelConfig 注释）。
#                              本机 settings.json 里就有这种拆分：
#                              `name=claude-sonnet-5-ppchat` / `model_id=claude-sonnet-5`。
#                              只传 name 不传 model_id 时别名会被当真名发给网关 → **400/404**，
#                              而那个错在 agent 输出里长得像「模型不可用」，不像配置错。
#   SC_PROVIDER                协议族，默认 openai（anthropic 族传 anthropic）
#   SWE_ARCH                   amd64|arm64，默认按 daemon 实测
#   SWE_MAX_TURNS              默认 40
#   SWE_TIMEOUT                单实例秒数，默认 1800
#   SWE_EFFORT_LEVEL           默认 max（**必控变量**，见 build_agent_script ④）
#   SWE_COST_LIMIT             默认 0（=不限；**必控变量**，见 build_agent_script ④）
#   SWE_JOBS                   跑 agent 的并发，默认 1（串行）。
#                              ⚠️ **必控变量** —— 并发下多容器争 docker daemon / 宿主 CPU /
#                              同一份网关配额，agent_ms 被互相拖长，**分数不可与串行 run 并排**。
#                              已记进 run-meta 的 jobs，grade.ts 在 >1 时会点破。
#                              数据：smoke-8 串行 94.2min、最慢单条 22.2min → 串行代价 4.2×。
#                              建议 smoke-9 用默认 1 拿干净基线（要与 smoke-8 并排读），
#                              之后的迭代轮再开并发。
#   SWE_GRADE_JOBS             判分并发，默认 1。判分不碰网关且是纯函数，
#                              **不影响可比性**（与 SWE_JOBS 不同）；代价是 N 倍内存。
#   SWE_ARTIFACT               显式指定产物（tar.gz 或裸二进制都收），跳过全部自动查找
#   SWE_BUILD_REF              点名 dist/branch-builds/ 里的一个包（commit 前缀或分支 slug）。
#                              ⚠️ 点名了却找不到时**直接失败，不静默回落** ——
#                              回落会让人以为跑的是他点名的那个包。
#   SWE_ALLOW_STALE_ARTIFACT   放行「产物编出来之后编译输入又改了」（做旧产物对照时才用）。
#                              会记进 run-meta 的 gate_bypassed，报告里会点破"不可与其他 run 并排"。
#   SWE_ALLOW_FOREIGN_ARTIFACT 放行「产物来自另一条线（不是当前 HEAD 的祖先）」（跨分支 A/B）。
#                              ⚠️ 与上一个**语义不同，刻意不合成一个**：想做对照实验的人
#                              不该顺手把"别的分支"也放过去，这两件事在报告里的解读完全不同。
#                              （unknown-commit / sidecar-mismatch **没有**逃生舱：
#                               那两个是"数据本身有问题"，放行等于允许在不知道跑的是什么时出分数。）
#
# ⚠️ 权限**没有** SWE_PERMISSION_MODE 这个开关了 —— 唯一取值是
#    `--dangerously-skip-permissions`（写死，见 build_agent_script ①）。
#    留一个环境变量就等于留一个"填错了不报错、只是分数变差"的入口，
#    而这个坑已经踩过一次（`bypassPermissions` 不是合法模式名，见那里的注释）。
#
# ## 容器内 agent 脚本的四条实测约束（§4.5）—— 少一条就起不来或跑歪
#
# 这四条原本记在 `runner.ts` 一个平行实现 `containerScript()` 的 docblock 里，
# 而那个函数零引用、已与本脚本漂移（详见 runner.ts 里删除它的说明）。
# 唯一被真实执行的容器脚本是下面的 `build_agent_script`，所以约束记在这里：
#
#   1. **必须激活 conda testbed**（`source /opt/miniconda3/bin/activate` +
#      `conda activate testbed`）—— 不激活 import 全挂，而 agent 会把
#      「环境没激活」当成代码 bug 去修，白烧十几轮。
#   2. **必须写 settings.json** —— `config.ts` 那道门禁在 `--print` 下
#      `!config.model && availableModels.length === 0` 直接抛。光 cp 二进制起不来。
#   3. **不带 `--no-session-persistence`** —— 编译产物里报「未知选项」
#      （bun parseArgs 不收 `no-` 前缀声明名）。会话隔离靠 `SID_CONFIG_DIR`。
#   4. **HOME 必须可写** —— `SID_CONFIG_DIR` 不覆盖 `debug.log`；且
#      `ensure-ripgrep.ts` 在只读 HOME 下会**静默降级**到系统 rg
#      （静默 = 你不会知道 grep 行为变了）。

set -euo pipefail

SWE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SWE_DIR/../../.." && pwd)"
VENV_PY="$SWE_DIR/.venv/bin/python"
SWEBENCH="$SWE_DIR/.venv/bin/swebench"
RUN_NET="${SWE_RUN_NET:-sid-swebench-run}"
PROXY_NAME="${SWE_PROXY:-sid-swebench-proxy}"
MODEL_NAME="sid-code"
MAX_TURNS="${SWE_MAX_TURNS:-40}"
TIMEOUT_SEC="${SWE_TIMEOUT:-1800}"
EFFORT_LEVEL="${SWE_EFFORT_LEVEL:-max}"
# 0 = 不限（quota.ts:80 是 `costLimit <= 0` 直接 return null）。
# ⚠️ 不能不管它：团队默认模板会补 costLimit=100，撞上就**静默结束整轮**（见 build_agent_script ④）。
COST_LIMIT="${SWE_COST_LIMIT:-0}"

# ## ⚠️ 权限模式写死成 `--dangerously-skip-permissions`，且**只能用布尔 flag**
#
# 这里刻意不留环境变量、也刻意不用 `--permission-mode <值>`，两条都有实测教训：
#
# ### ① `bypassPermissions` 从来不是 sid-code 的合法模式名（2026-08-26 实测）
#
# 合法值只有 9 个（`config/schema.ts` 的 VALID_PERMISSION_MODES）：
#   default / manual / always-allow / deny-write / acceptEdits / plan / dontAsk /
#   auto / dangerously-skip-permissions
# 传 `bypassPermissions` 只会得到一条 **warn 而非错误**，程序照常跑：
#   ⚠ [CONFIG]  ✗ permissionMode: 无效值 "bypassPermissions"，有效值为 default/...
# 然后 `checker.ts` 的判据是 `=== "always-allow"` 精确匹配 → 不命中 → 落到默认 ask
# → headless 无交互 → **直接拒绝**。实测三模式对照（直接调 PermissionChecker.check）：
#
#   模式                 bash(pytest)  write(工作区外)  write(工作区内)
#   acceptEdits          false         false            true
#   always-allow         true          false ←仍被拦     true
#   bypassPermissions    false         false            false ←比 acceptEdits 更差
#   skipPermissions=true true          true             true   ←唯一全通
#
# 也就是说这个"修复"比它要修的 acceptEdits 还糟：连改 testbed 里的文件都不放行。
#
# ### ② `always-allow` 不够 —— 路径验证在 bypass **之前**
#
# `checker.ts` 顺序是 `… → Step 4 路径验证 → … → Step 8 bypass/always-allow`，
# 于是 `path-validator.ts` 那条「写入路径在工作区外」always-allow 绕不过。
# smoke-8 的 113 次拒绝里有 5 次正是 `write(/tmp/repro.py) → 写入路径在工作区外`
# —— 模型写复现脚本是做题的标准动作。只有 `skipPermissions` 走 checker 的早退
# （在路径验证之前）。
#
# ### ③ 必须用布尔 flag，`--permission-mode dangerously-skip-permissions` 不生效
#
# 实测：`--permission-mode dangerously-skip-permissions` 三项全 false。
# 因为 `cli.ts` 把布尔 flag 映射到 `config.skipPermissions`，而 checker 的早退判据
# 是 `this.config.skipPermissions` —— 只设 permissionMode 字符串碰不到它。
# （反向：布尔 flag 会由 `config.ts` 顺带把 permissionMode 同步成同名字符串，
#  所以状态栏/run-meta 里看到的值一样，**但只有布尔 flag 那条真的放行**。）
#
# ### 代价（必须点破，别当成"权限层验证过了"）
#
# skipPermissions 同时跳过 safetyCheck（bypass-immune 那层）与危险命令检测。
# 在这里可接受：容器无外网（走 allowlist 代理）、跑完即 `docker rm -f`、
# 里面只有一个 testbed 仓库。但这意味着**这一轮评测测不到权限层** ——
# 它只是被记进 run-meta 的一个必控变量，不是一条通过了的验证。
PERMISSION_FLAG="--dangerously-skip-permissions"
# 记进 run-meta 的规范名（与 config.ts 同步出的 permissionMode 字符串一致）
PERMISSION_MODE="dangerously-skip-permissions"

# ⚠️ 镜像 registry 前缀，**默认必须留空**（2026-08-25 从 `docker.1ms.run` 改过来）。
#
# 旧值来自「Docker Hub 不可达、只能走镜像站」那个前提，但它顺带引入了一个更严重的
# 问题：**带 registry 前缀的镜像名 swebench harness 认不出来**。
# harness 用的是 dataset 里那个名字（实测
# `swebench/sweb.eval.x86_64.pytest-dev_1776_pytest-7982:latest`，
# 由 `make_test_spec(d).image` 给出，见 `run_evaluation.py` 的 `wanted` 映射），
# 打成 `docker.1ms.run/swebench/...` 它一个都命中不了，于是回落去 registry 拉 ——
# 而 dockerd 在本网络出网不通，最终报的是**拉取失败**，根因（名字对不上）被埋两层。
#
# 现在镜像由 `pull-image.sh` 在**宿主侧**拉好并 `docker load` 进 daemon，
# 打的就是无前缀的官方名字，所以这里也必须无前缀才能对上。
# 想临时换源只影响 pull-image.sh（它有自己的 SWE_REGISTRY），不影响这里的名字。
SWE_REGISTRY="${SWE_REGISTRY:-}"

ok() { printf '  \033[32m✅\033[0m %s\n' "$1"; }
bad() { printf '  \033[31m❌\033[0m %s\n' "$1" >&2; }
info() { printf '  \033[36m→\033[0m %s\n' "$1"; }

need_docker() {
  docker info >/dev/null 2>&1 || {
    bad "docker daemon 不可达。先跑 setup-env.sh 并 export DOCKER_HOST"
    exit 1
  }
}

detect_arch() {
  if [[ -n "${SWE_ARCH:-}" ]]; then
    echo "$SWE_ARCH"
    return
  fi
  # 官方 per-instance 镜像只有 amd64（实测 manifest 里就一个
  # `"architecture":"amd64"`），所以默认按 amd64 走 —— arm64 上靠 qemu。
  echo "amd64"
}

# 官方镜像名规则（抄 swebench/image_builder/image_spec.py:38-43）：
#   sweb.eval.{x86_64|arm64}.{instance_id}:latest
# 且带 namespace 时 `__` 被改写成 `_1776_`（docker hub 不允许双下划线）。
# ⚠️ 这就是 §4.4 那条「它打印出来的本地 image key 不是你能 pull 的名字」。
image_name() {
  local iid="$1" arch="$2" tag_arch
  tag_arch="x86_64"
  [[ "$arch" == "arm64" ]] && tag_arch="arm64"
  local key="sweb.eval.${tag_arch}.${iid}:latest"
  key="${key//__/_1776_}"
  # SWE_REGISTRY 为空时**不能拼出前导斜杠**（`/swebench/...` 不是合法镜像名，
  # 而 docker 报的错是 "invalid reference format"，看不出是空变量拼出来的）。
  if [[ -n "$SWE_REGISTRY" ]]; then
    echo "${SWE_REGISTRY}/swebench/${key}" | tr '[:upper:]' '[:lower:]'
  else
    echo "swebench/${key}" | tr '[:upper:]' '[:lower:]'
  fi
}

# ## ⚠️ arm64 宿主 + qemu 时必须用 **baseline** 变体的 x64 产物
#
# 实测踩到（2026-08-25，arm64 mac + colima，官方镜像只有 amd64 所以必走 qemu）：
# 常规 `sid-code-<ver>-linux-x64` 产物在 qemu-x86_64 里**一启动就
# `Illegal instruction (core dumped)`**（进程 exit 132 = 128+SIGILL）。
# 原因是 Bun 默认编译的 x64 产物要求 AVX2 等较新指令，而 qemu-x86_64 不实现它们。
#
# ⚠️ 这个失败形态**会伪装成 agent 能力差**，而且伪装得很好：
#   - harness 记的是 `agent_exit=132` → outcome 落在 `agent_error`；
#   - 更坏的情形是它落在 `patch_produced`：qemu 的 core dump
#     （`core`、`qemu_sid-code_<ts>_<pid>.core`）掉在 `/testbed` 里，
#     被 `git add -A` 收进工作树，于是**「patch」是两个 core 文件的二进制 diff**，
#     `patch_bytes=326` 看着还挺正常。实测第一次就是这样：
#     一次 SIGILL 崩溃被记成「产出了 patch」。
#   - 唯一的裸眼线索是 `wall_ms`（2162ms —— 真跑一题是分钟量级）。
#
# 解法：`bun build --compile --target=bun-linux-x64-baseline`。
# 实测 baseline 产物在同一 qemu 容器里 `--version` 与 `--self-check` 全过
# （含内嵌 ripgrep 可执行）。
#
# 查找顺序（**baseline 优先**，因为跑 evals 的场景就是 qemu）：
#   ① SWE_ARTIFACT 显式指定（tar.gz 或裸二进制都收）
#   ② SWE_BUILD_REF=<commit前缀|分支slug> → dist/branch-builds/ 里点名一个分支包
#   ③ dist/branch-builds/<当前分支slug>-<当前HEAD的commit12>/  ← 默认找「当前状态的包」
#   ④ dist/release/<ver>/sid-code-<ver>-linux-x64-baseline.tar.gz
#   ⑤ dist/release/<ver>/sid-code-<ver>-linux-x64.tar.gz（原生 x64 机器上就该用这个）
# 找到 ⑤ 而没有 ④ 时**不静默接受** —— cmd_run 会警告「qemu 下大概率 SIGILL」，
# 否则下一个人要把上面这段重新debug一遍。
#
# ## ③ 是关键：默认行为从「找版本号对应的包」变成「找当前 commit 对应的包」
#
# 旧默认（只有 ④⑤）挑的是 `dist/release/<ver>/`，而 `<ver>` 来自 package.json、
# `make build` 刻意不 bump 它 —— 所以「重新构建」不会改变挑中的路径。
# F1 那个事故就是这样发生的：评测静默挑到 5 天前的产物，而 version / 分数 / 日志全部正常。
# 换成按 commit 找之后，那个形态在**挑选阶段**就不会发生：找不到就报
# 「当前 commit 没有包，先编一个」，而不是静默退回一个旧包。
#
# ⚠️ **④⑤ 必须保留**：删掉会让发布制品突然不可用于评测，而「用发布制品跑一轮」
# 是个合法且重要的场景（验证用户真正拿到的字节）。走到 ④⑤ 时会打一行提示。
#
# ⚠️ 目录名（`<slug>-<commit12>`）只是**人肉可读的索引**，不是身份。
# 门禁（G1）一律读产物字节里那 40 位 commit，绝不解析目录名 ——
# 目录名撞了最多是覆盖一个包（重编即可），判据读错 commit 会让整轮评测的归因错掉。
#
# ## ⚠️ 输出格式是 `<source>\t<path>`，不是「路径 + 一个全局变量」
#
# 第一版写成「echo 路径 + 顺手设 ARTIFACT_SOURCE=...」，实测**那个变量恒为空**：
# 调用方是 `artifact="$(artifact_for "$arch")"`，命令替换起的是**子 shell**，
# 里面的赋值不会回到父 shell。
# 失败形态：run-meta 里 `artifact_source` 永远是 `unknown`，而这个字段
# 恰恰是"这个包是怎么挑中的"的唯一记录 —— 一个字段在、有值、看起来正常，
# 但值是废的（本仓 metric-exists-but-value-is-junk 的同型）。
# 所以两个值一起从 stdout 出来，由调用方拆开。
artifact_source_of() { printf '%s' "${1%%$'\t'*}"; }
artifact_path_of() { printf '%s' "${1#*$'\t'}"; }
artifact_for() {
  local arch="$1" ver suffix
  if [[ -n "${SWE_ARTIFACT:-}" ]]; then
    printf 'SWE_ARTIFACT\t%s\n' "$SWE_ARTIFACT"
    return
  fi

  local bb="$REPO_ROOT/dist/branch-builds"

  # ② 显式点名一个分支包。匹配「目录名含这个串」—— commit 前缀与分支 slug 都能用。
  if [[ -n "${SWE_BUILD_REF:-}" ]]; then
    local hit
    hit="$(find "$bb" -maxdepth 1 -type d -name "*${SWE_BUILD_REF}*" 2>/dev/null | sort | head -1)"
    if [[ -n "$hit" ]]; then
      local pkg
      pkg="$(find "$hit" -maxdepth 1 -name '*.tar.gz' 2>/dev/null | sort | head -1)"
      [[ -z "$pkg" && -f "$hit/sid-code" ]] && pkg="$hit/sid-code"
      if [[ -n "$pkg" ]]; then
        printf 'SWE_BUILD_REF\t%s\n' "$pkg"
        return
      fi
    fi
    # 点名了却找不到 → **不静默回落**。回落会让人以为跑的是他点名的那个包。
    bad "SWE_BUILD_REF=${SWE_BUILD_REF} 在 dist/branch-builds/ 里没有匹配的包"
    bad "   现有的包：$(find "$bb" -maxdepth 1 -mindepth 1 -type d -exec basename {} \; 2>/dev/null | tr '\n' ' ')"
    return 1
  fi

  # ③ 当前分支 + 当前 HEAD 的包
  local cur_commit12 cur_slug cur_dir
  cur_commit12="$(git -C "$REPO_ROOT" rev-parse HEAD 2>/dev/null | cut -c1-12)"
  cur_slug="$(git -C "$REPO_ROOT" rev-parse --abbrev-ref HEAD 2>/dev/null |
    tr -c 'A-Za-z0-9' '-' | sed -e 's/--*/-/g' -e 's/^-//' -e 's/-$//' | cut -c1-32)"
  if [[ -n "$cur_commit12" && -n "$cur_slug" ]]; then
    cur_dir="$bb/${cur_slug}-${cur_commit12}"
    if [[ -d "$cur_dir" ]]; then
      local pkg
      pkg="$(find "$cur_dir" -maxdepth 1 -name '*.tar.gz' 2>/dev/null | sort | head -1)"
      [[ -z "$pkg" && -f "$cur_dir/sid-code" ]] && pkg="$cur_dir/sid-code"
      if [[ -n "$pkg" ]]; then
        printf 'branch-builds/current-commit\t%s\n' "$pkg"
        return
      fi
    fi
  fi

  ver="$(node -e 'console.log(require("'"$REPO_ROOT"'/package.json").version)' 2>/dev/null ||
    grep -m1 '"version"' "$REPO_ROOT/package.json" | sed 's/.*"version": *"\([^"]*\)".*/\1/')"
  suffix="linux-x64"
  [[ "$arch" == "arm64" ]] && suffix="linux-arm64"
  local baseline="$REPO_ROOT/dist/release/$ver/sid-code-$ver-$suffix-baseline.tar.gz"
  [[ -f "$baseline" ]] && {
    printf 'dist/release\t%s\n' "$baseline"
    return
  }
  printf 'dist/release\t%s\n' "$REPO_ROOT/dist/release/$ver/sid-code-$ver-$suffix.tar.gz"
}

# ## ⚠️ `dist/release/<ver>/` 里的产物可能比 HEAD 老很多天，而版本号看不出来
#
# 实测踩到（2026-08-26）：`package.json` 是 `0.1.601`，tag `v0.1.601` 打在 **8月21**；
# 此后 8月26 合入的 429 重试修复与权限修复**都不在那个 tag 里**
# （`git merge-base --is-ancestor <fix> v0.1.601` 失败）。
# 而 `make build` **不 bump 版本号**，所以重新构建也不会改变 `artifact_for()` 挑中的路径
# —— 于是「跑评测验证本轮修复」会静默跑成「跑 5 天前的代码」，
# 分数正常、日志正常、run-meta 里的 version 也正常。
#
# 这就是 run-meta 必须记 `git_commit` + `artifact_sha256` 而不是只记 version 的原因
# （同一个版本号能对应几十个 commit）。
#
# ## ⚠️ 上一轮用 mtime 当判据，两个方向都会错（已实测，别改回去）
#
# **假阴性（严重，正是门禁本该抓的场景）**：`cp old new` 会把 mtime 重置成"现在"，
# 内容一字未改，门禁放行。而 `cp` / 下载 / `docker cp` 是最常见的产物搬运方式
# （实测 `tar -xzf` 反而**保留**原 mtime，这一条是好的）。
# **假阳性**：docs-only 提交（只碰 website/、.agents/）会推进全仓 HEAD 时间，
# 于是一个含全部代码改动的好产物被拦。
#
# ⚠️ 假阳性的代价不是"多敲一次命令"：一道经常误报的门禁会被养成
# 「先加 SWE_ALLOW_STALE_ARTIFACT=1 再说」的习惯，于是它真正该拦的那次也被放过去了。
# **误报会训练人绕过门禁。**
#
# ## 现在的判据：产物自报 commit，走三步 git 验证
#
# 判据**不是**「产物含 main 最新」，而是
# **「产物的 commit ∈ 当前工作副本的历史，且此后没有改动过任何编译输入」**。
# 这个区别是全部设计的核心 —— 「必须含 main 最新」会拦住三种合法场景
# （在 PR 分支上验证自己的改动 / main 刚合了别人一个无关 PR / 故意用旧产物做对照）。
#
# 判定逻辑（形态校验、`^{commit}`、编译输入路径清单）全在
# `scripts/lib/artifact-identity.ts` —— **刻意不在这里写 bash 版**：
# 两份会各自漂移，而漂移的形态是「门禁看起来在跑、实际全在放行」。
#
# 退出码是跨语言契约（对齐 lib 里的 EXIT_CODE 表）：
#   0 放行（含「读不到身份 → 已退化到 mtime 兜底」，那不是通过而是没量到）
#   2 stale   3 foreign   4 unknown-commit   5 sidecar-mismatch
#
# 两个逃生舱**语义不同，刻意不合成一个**：
#   SWE_ALLOW_STALE_ARTIFACT=1    「我知道它旧，我就要跑旧的」（对照实验、复算历史 run）
#   SWE_ALLOW_FOREIGN_ARTIFACT=1  「我知道它是别的分支编的」（跨分支 A/B）
# 合成一个的后果：想做对照实验的人顺手把「别的分支」也放过去了，
# 而这两件事在报告里的解读完全不同。任一逃生舱被用时必须记进
# run-meta 的 `gate_bypassed` —— 逃生舱本身不是问题，**用了却不留痕**才是。
#
# 结果通过全局变量带出（bash 没有多返回值），供 run-meta 落盘：
GATE_JSON=""
GATE_VERDICT=""
GATE_BYPASSED=""
check_artifact_identity() {
  local artifact="$1"
  [[ -f "$artifact" ]] || return 0
  local rc=0
  # JSON 走 stdout、人读文本走 stderr（CLI 侧刻意分流）—— 所以这里只捕获 stdout，
  # 人读部分直接流到终端。混在一起时 JSON 里会掺进中文，而 json.load 报的错
  # 完全看不出成因是这个。
  GATE_JSON="$(bun run "$REPO_ROOT/scripts/artifact-identity.ts" gate "$artifact")" || rc=$?
  GATE_VERDICT="$(printf '%s' "$GATE_JSON" |
    sed -n 's/.*"verdict":"\([a-z-]*\)".*/\1/p')"
  case "$rc" in
  0) return 0 ;;
  2)
    if [[ -n "${SWE_ALLOW_STALE_ARTIFACT:-}" ]]; then
      GATE_BYPASSED="stale"
      bad "   SWE_ALLOW_STALE_ARTIFACT=1 已设 —— 继续，但**这一轮测的不是当前代码**（已记进 run-meta.gate_bypassed）"
      return 0
    fi
    return 1
    ;;
  3)
    if [[ -n "${SWE_ALLOW_FOREIGN_ARTIFACT:-}" ]]; then
      GATE_BYPASSED="foreign"
      bad "   SWE_ALLOW_FOREIGN_ARTIFACT=1 已设 —— 继续，产物来自另一条线（已记进 run-meta.gate_bypassed）"
      return 0
    fi
    return 1
    ;;
  *)
    # unknown-commit / sidecar-mismatch / CLI 自己挂了：**没有逃生舱**。
    # 前两者都是"数据本身有问题"（取不到那个 commit / 索引在骗人），
    # 给逃生舱等于允许在不知道跑的是什么的情况下出一个分数。
    # CLI 挂了也必须停 —— 那是"门禁没跑成"，把它当放行就是本仓反复踩的
    # 「『没检查』冒充『检查通过』」。
    return 1
    ;;
  esac
}

# 宿主是 arm64 但产物是非 baseline 的 x64 → qemu 下必 SIGILL。**先警告，别等它崩**。
warn_if_non_baseline() {
  local artifact="$1" arch="$2"
  [[ "$arch" == "amd64" ]] || return 0
  [[ "$(uname -m)" == "arm64" || "$(uname -m)" == "aarch64" ]] || return 0
  case "$artifact" in
  *baseline*) return 0 ;;
  esac
  bad "⚠️ 宿主是 arm64、产物是**非 baseline** 的 x64 —— qemu 下大概率一启动就 SIGILL(132)，"
  bad "   而它会被记成 agent_error 甚至 patch_produced（core dump 被 git add 收进 patch）。"
  bad "   编一个 baseline 分支包（默认就是 baseline target，且自带两个 define）："
  bad "     bash scripts/build-branch-artifact.sh"
  bad "   它会放进 dist/branch-builds/<分支>-<commit12>/，artifact_for() 会自动挑到。"
  return 1
}

subset_ids() {
  # 只取 `instances:` 段，**不取 candidate_pool** —— 候选池是替补，
  # 捎带进来会让 n 从 10 变 15，而 solved_count 的分母就错了。
  awk '
    /^instances:[[:space:]]*$/ { inb=1; next }
    inb && /^[a-zA-Z_]+:/ { inb=0 }
    inb && /^[[:space:]]*-[[:space:]]+instance_id:/ {
      gsub(/.*instance_id:[[:space:]]*"?/, ""); gsub(/"[[:space:]]*$/, ""); print
    }
  ' "$SWE_DIR/verified-subset.yaml"
}

# ─────────────────────────────────────────────────────────────────────────────
# ① gold 自检（§4.4）
# ─────────────────────────────────────────────────────────────────────────────
#
# **gold 都跑不过就是环境问题，不是 agent 问题** —— 这是把「环境错」与
# 「能力差」分开的唯一手段。所以它必须在跑 agent 之前做，而且失败要停。
# ## 不给 instance_id 时跑 subset 全部
#
# 为什么需要：`gold_ok` 的判据是「submitted 的**每一条**都有 gold 通过记录」
# （见 grade.ts 的 readGoldOk）—— 少跑哪条，那条的环境就没验证过，
# 而 grade 侧会因此把 gold_ok 记成 null（未跑），整轮失去环境背书。
# 手敲 10 次很容易漏一条，而漏了之后**报告只是显示「未跑」，不报错**。
cmd_gold() {
  need_docker
  if [[ $# -eq 0 ]]; then
    local fail=0 n=0 total
    total="$(subset_ids | wc -l | tr -d ' ')"
    while read -r one; do
      n=$((n + 1))
      info "[${n}/${total}] gold 自检: $one"
      gold_one "$one" || fail=1
    done < <(subset_ids)
    if ((fail)); then
      bad "有实例 gold 自检未通过 —— **先查环境，此时任何 solved_count 都不可信**"
      return 1
    fi
    ok "全部 ${total} 条 gold 自检通过（环境可信）"
    return 0
  fi
  local one
  for one in "$@"; do
    gold_one "$one" || return 1
  done
}

gold_one() {
  local iid="${1:?需要 instance_id}"
  info "gold 自检: $iid"
  local out
  # ⚠️ `--namespace ''` 在 swebench 5.0.2 里**已被删除**（实测
  # `Error: No such option: --namespace`）。5.0.2 的替代是 `--task-repo`，
  # 但它需要一个逐实例 Dockerfile 的外部仓库，本仓没有 —— 所以这里走
  # 默认行为（拉 registry 镜像），镜像来源由 SWE_REGISTRY 控制。
  set +e
  out="$("$SWEBENCH" eval verified --gold -i "$iid" \
    --run-id "validate-gold-$iid" -j 1 --report-dir "$SWE_DIR/runs/gold" 2>&1)"
  local code=$?
  set -e
  echo "$out" | tail -20
  # ⚠️ **退出码不可信**：实测整个实例报错时 `swebench eval` 仍然 exit 0，
  # 摘要里写的是 `Instances resolved: 0` / `Instances with errors: 1`。
  # 判据必须是摘要里的计数（与 preflight.ts 的 judgeBuildOutcome 同一口径）。
  if echo "$out" | grep -qE "Instances with errors:[[:space:]]*[1-9]"; then
    bad "gold 自检失败：harness 报实例出错（注意此时 exit=${code}，退出码不可信）"
    return 1
  fi
  if echo "$out" | grep -qE "Instances resolved:[[:space:]]*0"; then
    bad "gold 自检失败：gold patch 都没解出 → **这是环境问题，不是 agent 问题**"
    return 1
  fi
  ok "gold 自检通过（环境可信，可以开始跑 agent）"
}

# ─────────────────────────────────────────────────────────────────────────────
# ② 跑 agent（§4.5）
# ─────────────────────────────────────────────────────────────────────────────
cmd_run() {
  need_docker
  local run_id="${1:?需要 run_id}"
  shift || true
  local arch
  arch="$(detect_arch)"
  # 一次命令替换取回两个值（`<source>\t<path>`）。理由见 artifact_for 上方注释：
  # 在子 shell 里设全局变量**不会回到父 shell**，那条路会让 run-meta 的
  # artifact_source 恒为 unknown（字段在、有值、值是废的）。
  local artifact artifact_pick
  artifact_pick="$(artifact_for "$arch")" || exit 1
  ARTIFACT_SOURCE="$(artifact_source_of "$artifact_pick")"
  artifact="$(artifact_path_of "$artifact_pick")"
  [[ -f "$artifact" ]] || {
    bad "产物不存在: ${artifact}"
    bad "   编一个当前 commit 的评测产物（linux-x64-baseline + 两个 define + 3 个生成脚本）："
    bad "     bash scripts/build-branch-artifact.sh"
    bad "   或用发布制品：./scripts/release.sh --upload 之后 dist/release/<ver>/ 下那份"
    exit 1
  }
  # arm64 + 非 baseline x64 产物 = qemu 下必崩，**且崩得像 agent 能力差**。
  # 所以这里直接停，不让它跑出一份看起来正常的假结果。
  # 想强行跑（比如你在原生 x86_64 机器上，uname 判断被别的层骗了）：SWE_ALLOW_NON_BASELINE=1
  warn_if_non_baseline "$artifact" "$arch" || {
    [[ -n "${SWE_ALLOW_NON_BASELINE:-}" ]] || {
      bad "   确认要强行跑：SWE_ALLOW_NON_BASELINE=1"
      exit 1
    }
    bad "   SWE_ALLOW_NON_BASELINE=1 已设 —— 继续，但这一轮的分数请当作不可信"
  }
  # G1：产物必须包含被测 commit。判据是产物**自报的 commit**（编在字节里，`cp` 改不了它），
  # 不是 mtime —— 见 check_artifact_identity 上方那段为什么 mtime 两个方向都会错。
  # 走到 ④⑤（dist/release）时提示一句：那是发布制品，不一定含当前分支的改动。
  [[ "$ARTIFACT_SOURCE" == "dist/release" ]] &&
    info "产物来自 dist/release（发布制品）—— 若要测当前分支的改动，先 bash scripts/build-branch-artifact.sh"
  check_artifact_identity "$artifact" || exit 1
  : "${SC_BASE_URL:?必须设 SC_BASE_URL（模型网关）}"
  : "${SC_API_KEY:?必须设 SC_API_KEY —— 只走 exec env，绝不进 argv}"
  # ⚠️ SC_MODEL 必填、**不给默认值**。给了默认值就会出现「以为在测 A 实际在测 B」，
  # 而分数看起来完全正常 —— 这类错误不会报错，只会静默产出不可比的数字。
  : "${SC_MODEL:?必须设 SC_MODEL（被测模型名，会进 API 请求体且记进 run meta）}"

  local ids
  if [[ $# -gt 0 ]]; then ids="$*"; else ids="$(subset_ids)"; fi

  local out_dir="$SWE_DIR/runs/$run_id"
  mkdir -p "$out_dir"
  : >"$out_dir/predictions.jsonl"
  : >"$out_dir/records.jsonl"

  # ## run meta：模型名与网关 host 必须落盘，否则分数不可复算
  #
  # 不是元数据装饰 —— 换了模型或换了网关的两次 run 的 `solved_count` 之间
  # **没有可比性，而分数本身看不出来这件事**。grade.ts 读这个文件，
  # 读不到就在 unaccounted 里点破「不可与其他 run 并排」。
  #
  # ⚠️ **只记 host，不记完整 URL、绝不记 key**。`SC_API_KEY` 从头到尾只走
  # `docker exec -e`，既不进 argv 也不进任何落盘文件。
  local gw_host
  gw_host="$(printf '%s' "$SC_BASE_URL" | sed -E 's#^[a-zA-Z]+://##; s#/.*$##')"
  # jobs 在这里校验（而不是用到它的地方）—— 它要进下面的 run-meta。
  # 非法值必须**在起任何容器之前**就停，否则会跑掉半轮才发现 meta 是坏的。
  local jobs="${SWE_JOBS:-1}"
  if [[ ! "$jobs" =~ ^[0-9]+$ ]] || ((jobs < 1)); then
    bad "SWE_JOBS 必须是 >=1 的整数（收到 '$jobs'）"
    exit 1
  fi
  # ⚠️ 预算闸门与权限模式**也是必控变量**，此前漏记（ZZZZ.11 P1 点出过 max_turns 缺项）。
  # 它们和模型一样：换了值两轮分数就不可比，而分数本身看不出来。
  # `permission_mode` 尤其关键 —— acceptEdits 与 skipPermissions 之间差的不是
  # "严格程度"，是 agent **能不能跑测试**（实测 113 次拒绝，见 build_agent_script）。
  #
  # ## 被测代码的身份：`git_commit` 才是事实源，version 不是
  #
  # 实测踩到（2026-08-26）：`package.json` 停在 `0.1.601`，而 tag `v0.1.601` 打在
  # **8月21** 的提交上；此后 8月26 合入的 429 重试修复、权限修复全都不在那个 tag 里
  # （`git merge-base --is-ancestor <fix> v0.1.601` 失败）。
  # 也就是说**同一个版本号对应了几十个不同的 commit** ——
  # 只记 version 等于没记，而 `artifact_for()` 默认挑 `dist/release/<ver>/` 下那份
  # 8月21 的产物，里面一行本轮修复都没有。
  #
  # 所以这里记四项，缺一项就有"不知道跑的是哪份代码"的缝：
  #   version         人读的标签（会重复，仅供对照）
  #   git_commit      **唯一身份**
  #   git_dirty       工作区脏 → commit 也不能完全描述产物，报告里要点破
  #   artifact_sha256 产物字节指纹 —— 上面三项都对但产物是旧的时唯一能发现的途径
  #
  # ## ⚠️ 但 `git_commit` 记的是**宿主 HEAD**，不是产物的 commit（F3，本轮修）
  #
  # 产物可能是任意时候编的，**这两个值不一定相等，而读报告的人会当它们相等**。
  # F1 那个场景里 `git_commit` 是 8月26 的 HEAD、产物是 8月21 的 ——
  # run-meta.json 从"事实源"退化成了"一个看起来很可靠的错值"。
  #
  # 所以从本轮起两者分开记，且**语义写在字段名上**：
  #   artifact_commit    产物**自报**的 commit（编在字节里，`cp` 改不了它）← 事实源
  #   host_head_commit   跑评测时宿主的 HEAD（此前那个 git_commit 记的就是它）
  #   artifact_identity_source  embedded / mtime-fallback ← **没量到 ≠ 没变化**
  #   gate_bypassed      用了哪个逃生舱（逃生舱本身不是问题，用了不留痕才是）
  # `git_commit` 保留为 host_head_commit 的别名（旧报告与 grade.ts 的兼容路径），
  # 但**报告渲染一律以 artifact_commit 为准** —— 见 grade.ts 的 renderReport。
  local sc_version sc_commit sc_dirty artifact_sha
  sc_version="$(grep -m1 '"version"' "$REPO_ROOT/package.json" |
    sed 's/.*"version": *"\([^"]*\)".*/\1/')"
  sc_commit="$(git -C "$REPO_ROOT" rev-parse HEAD 2>/dev/null || echo unknown)"
  if [[ -n "$(git -C "$REPO_ROOT" status --porcelain 2>/dev/null)" ]]; then
    sc_dirty="true"
  else
    sc_dirty="false"
  fi
  # shasum 在 macOS/Linux 都有；sha256sum 只在 Linux。取到哪个用哪个，都没有就 unknown
  # （**不静默省略字段** —— 缺了要能在报告里看出来是"没量"而不是"没变"）。
  if command -v shasum >/dev/null 2>&1; then
    artifact_sha="$(shasum -a 256 "$artifact" | awk '{print $1}')"
  elif command -v sha256sum >/dev/null 2>&1; then
    artifact_sha="$(sha256sum "$artifact" | awk '{print $1}')"
  else
    artifact_sha="unknown"
  fi
  # 题面模板指纹（必控变量）。**提示词是必控变量，改一个字分数就不可外比** ——
  # 而它此前完全没记：smoke-10 给 prompt-v1.txt 加了「无外网」那句，
  # 如果不记这个指纹，事后没有任何办法区分「smoke-9 与 smoke-10 用的是同一份题面模板」。
  # 记 sha256 而不是全文：全文进 run-meta 会把每份 meta 撑大且不便 diff，
  # 而判据只需要「两轮是否同一份」。
  local prompt_sha="unknown"
  if command -v shasum >/dev/null 2>&1; then
    prompt_sha="$(shasum -a 256 "$SWE_DIR/prompt-v1.txt" | awk '{print $1}')"
  elif command -v sha256sum >/dev/null 2>&1; then
    prompt_sha="$(sha256sum "$SWE_DIR/prompt-v1.txt" | awk '{print $1}')"
  fi
  # 产物身份：`check_artifact_identity` 已经把 CLI 的 JSON 存进 GATE_JSON。
  # 这里**原样透传给 python 解析**，不在 bash 里 sed 出每个字段 ——
  # 两处解析同一份 JSON 就会有两套口径，而口径漂移不报错。
  "$VENV_PY" - "$out_dir/run-meta.json" "$SC_MODEL" "${SC_MODEL_ID:-}" "$gw_host" \
    "${SC_PROVIDER:-openai}" "$MAX_TURNS" "$PERMISSION_MODE" "$TIMEOUT_SEC" \
    "$EFFORT_LEVEL" "$COST_LIMIT" "$sc_version" "$sc_commit" "$sc_dirty" \
    "$(basename "$artifact")" "$artifact_sha" "$jobs" "$prompt_sha" \
    "${GATE_JSON:-}" "${GATE_BYPASSED:-}" "${ARTIFACT_SOURCE:-unknown}" <<'PY'
import json, sys
(out, model, model_id, host, provider, max_turns, perm_mode, timeout_sec,
 effort, cost_limit, version, commit, dirty, artifact, artifact_sha, jobs,
 prompt_sha, gate_json, gate_bypassed, artifact_source) = sys.argv[1:21]

# 门禁 JSON 解析失败时**一律落 unknown，绝不回填宿主 HEAD**。
# 回填的后果正是本方案要消灭的那个形态：每个字段看起来都正常，而结论是错的。
try:
    gate = json.loads(gate_json) if gate_json else {}
except Exception:
    gate = {}
# model_id 缺省时等于 model —— 记的是**实际发给网关的那个值**，
# 不是「用户填了什么」。事后复算看的是 wire model，别名对不上厂商侧的任何东西。
json.dump(
    {
        "model": model,
        "model_id": model_id or model,
        "gateway_host": host,
        "provider": provider,
        # ── 必控变量（D17）：任一项变化都让分数不可与其他 run 并排 ──
        "max_turns": int(max_turns),
        "permission_mode": perm_mode,
        "timeout_sec": int(timeout_sec),
        # effort_level 直接决定推理预算与成本；cost_limit=0 表示不限。
        # 这两项此前完全没记，而它们是**被团队默认模板悄悄塞进来的**
        # （见 build_agent_script ④），也就是说前几轮跑的是谁也没选过的值。
        "effort_level": effort,
        "cost_limit_usd": float(cost_limit),
        # jobs > 1 时多个容器争 docker daemon / 宿主 CPU / 同一份网关配额，
        # 每条实例的 agent_ms 都被别的实例拖长 → **与串行 run 分数不可并排**，
        # 而分数本身看不出来。grade.ts 在 jobs > 1 时会在 unaccounted 里点破。
        "jobs": int(jobs),
        # 题面模板指纹：提示词改一个字分数就不可外比，而它此前没记（见上面取值处）。
        "prompt_template_sha256": prompt_sha,
        # ── 被测代码的身份 ──
        #
        # ⚠️ artifact_commit 与 host_head_commit **必须分开**（F3）：产物可能是任意时候
        # 编的，两者不一定相等，而读报告的人会当它们相等。事实源是前者。
        "sid_code_version": version,
        "artifact_commit": gate.get("artifact_commit", "unknown"),
        "artifact_branch": gate.get("artifact_branch", "unknown"),
        "artifact_describe": gate.get("artifact_describe", "unknown"),
        "artifact_built_at": gate.get("artifact_built_at", "unknown"),
        "artifact_builder": gate.get("artifact_builder", "unknown"),
        "artifact_origin": gate.get("artifact_origin", "unknown"),
        # 产物构建时的工作区是否脏（≠ 跑评测时宿主脏不脏，见下面 host_dirty）。
        # 三态：读不到时是字符串 "unknown"，**不塌成 False** —— 塌成 False
        # 就是替它断言"构建时是干净的"，而那正是这个字段要防的事。
        "artifact_dirty": gate.get("artifact_dirty", "unknown"),
        # 身份到底量到了没有。mtime-fallback = 老产物，本轮判据退化成时间戳 ——
        # **那不是"通过"，是"没量到"**，报告必须点破而不是显示一个绿灯。
        "artifact_identity_source": gate.get("identity_source", "unknown"),
        "artifact_gate_verdict": gate.get("verdict", "unknown"),
        # 产物 commit 与宿主 HEAD 是否一致。不一致不一定是问题（PR 分支上验证
        # 自己的改动就是这样），但要能看见。
        "commit_matches_host": gate.get("commit_matches_host"),
        # 逃生舱：stale / foreign / 空。用了逃生舱的 run **不可与没用的 run 并排**。
        "gate_bypassed": [gate_bypassed] if gate_bypassed else [],
        # 产物是怎么挑中的（SWE_ARTIFACT / SWE_BUILD_REF / branch-builds / dist/release）
        "artifact_source": artifact_source,
        # 跑评测时宿主的 HEAD 与工作区状态。**不是**产物的身份，仅供对照。
        "host_head_commit": commit,
        "host_dirty": dirty == "true",
        # 旧字段名，保留为 host_head_commit 的别名（旧报告 / 旧脚本的兼容路径）。
        # ⚠️ 语义是"宿主 HEAD"而不是"跑的是这份代码"—— 新代码一律读 artifact_commit。
        "git_commit": commit,
        "git_dirty": dirty == "true",
        "artifact": artifact,
        "artifact_sha256": artifact_sha,
    },
    open(out, "w"),
    indent=2,
)
PY
  # ⚠️ 这条警告的主语从"产物"改成了"宿主"（本轮修）。
  # 宿主工作区脏**不说明产物有问题** —— 产物的 commit 与 dirty 都编在它自己的字节里，
  # 由上面的 G1 单独判（artifact_dirty）。旧文案写成"产物与 <host HEAD> 不完全对应"
  # 是把两件事混成一件：一个从干净 commit 编出的好产物，会因为宿主此刻有未提交改动
  # 而被打上"只可自比"的标签，而那个标签本该留给**产物**真的编自脏工作区的那种情况。
  if [[ "$sc_dirty" == "true" ]]; then
    bad "⚠️ 宿主工作区不干净（host_dirty=true）—— 产物身份另判（见上面 G1 的 artifact_dirty），"
    bad "   这里只是说宿主 ${sc_commit:0:8} 之外还有未提交改动，它们**不一定**在产物里"
  fi

  local proxy_ip=""
  proxy_ip="$(docker inspect -f "{{(index .NetworkSettings.Networks \"$RUN_NET\").IPAddress}}" \
    "$PROXY_NAME" 2>/dev/null || true)"
  [[ -n "$proxy_ip" ]] || {
    bad "取不到 allowlist 代理在 $RUN_NET 上的 IP。先跑 net-setup.sh"
    bad "⚠️ 没有代理 = agent 自由出网 = 它会去读上游修复，**分数不可信**（§5.1：实测 25% rollout 试图 git log 找答案）"
    exit 1
  }
  # 解压一次，所有实例共用（见 resolve_binary）。失败即停 ——
  # 让它跑下去只会得到 N 条"产物找不到"，每条还先白起一个容器。
  resolve_binary "$artifact" || exit 1
  info "arch=$arch  产物=$(basename "$artifact")  代理=$proxy_ip:8080  jobs=$jobs"

  # ## 并发：默认仍是 1（串行），要开得显式开
  #
  # 数据（smoke-8 重新汇总）：10 题串行 94.2 min，最慢单条 22.2 min
  # → **串行代价 4.2×**。也就是说完美并发能把墙钟压到 ~22 min。
  #
  # 但默认值必须是 1，三个理由都是"会静默改变结论"那一类：
  #
  #   1. **并发是必控变量。** 并发下多个容器共享 docker daemon、宿主 CPU、
  #      同一个网关配额，每条实例的 `agent_ms` 都会被别的实例拖长。
  #      smoke-8（串行）与一个 -j 4 的 run **分数不可并排**，
  #      而分数本身看不出来 —— 所以它进 run_meta 的 jobs 字段。
  #   2. **网关限流。** ZZZZZ 那个 P0 就是一次 429 终止整轮。并发 N 倍
  #      请求速率会把限流概率抬上去，于是"并发跑得快"变成"并发跑挂得快"。
  #      429 重试已修，但这条仍是先串行拿一轮干净基线再谈并发的理由。
  #   3. **smoke-9 的用处是验证本轮修复，不是刷速度。** 它必须能与 smoke-8
  #      并排读（那是判断"113 次拒绝没了""429 不再终止整轮"的唯一方式）。
  #
  # 所以推荐用法：**smoke-9 用默认 1**，拿到干净基线后再 `SWE_JOBS=4` 跑
  # 后续的迭代轮。开并发时报告里的 jobs 字段会点破"不可与串行 run 并排"。
  # 挡住宿主休眠。放在这里（起第一个容器之前、跑完所有实例之后停）而不是
  # 每题各起一个：守卫本身没有成本，而一轮中间的题间空隙同样会触发空闲睡眠。
  # ⚠️ 起不来不中止本轮 —— 那种场合由 host_slept_ms 兜底（见 start_sleep_inhibitor）。
  start_sleep_inhibitor
  # 无论后面怎么退（正常/报错/Ctrl-C）都要收掉守卫，否则它会一直吊在后台
  # 让这台机器再也不睡 —— 一个"评测跑完了但机器不休眠了"的形态没人会联想到这里。
  trap 'stop_sleep_inhibitor' EXIT INT TERM

  if ((jobs == 1)); then
    for iid in $ids; do
      run_one "$iid" "$run_id" "$arch" "$artifact" "$proxy_ip" "$out_dir" || true
    done
  else
    # ⚠️ `${jobs}` 必须带花括号：`$jobs（` 会让 bash 把全角括号吃进变量名
    # → `set -u` 下直接 `未绑定的变量` 退出。这是本仓第四次踩同一个坑
    # （前三次记在 ZZ.2d），门禁在 tests/scripts/shell-fullwidth-var.test.ts。
    bad "⚠️ SWE_JOBS=${jobs}（并发）—— 本轮分数**不可与串行 run 并排**，已记进 run-meta"
    # ## 为什么是这个 wait 形态，而不是 `xargs -P` 或 `wait -n`
    #
    #   - `xargs -P` 要把 run_one 导出成子 shell 可见的函数，
    #     而它依赖十几个 local/全局变量 —— export -f 在 bash 3.2（macOS 自带）
    #     行为不一致，实测会丢变量，失败形态是"每条都起不来容器"。
    #   - `wait -n` 需要 bash 4.3+，macOS 自带 3.2。
    # 所以用最钝的写法：满 N 个就 wait 全部。它比 `wait -n` 慢
    # （一批里最慢的拖住整批），但**在所有 bash 上行为一致**，
    # 而这一层要的是可预测，不是极致吞吐。
    local -a pids=()
    for iid in $ids; do
      run_one "$iid" "$run_id" "$arch" "$artifact" "$proxy_ip" "$out_dir" || true &
      pids+=($!)
      if ((${#pids[@]} >= jobs)); then
        wait "${pids[@]}" 2>/dev/null || true
        pids=()
      fi
    done
    ((${#pids[@]})) && { wait "${pids[@]}" 2>/dev/null || true; }
  fi

  # ## 合并 .parts/ → 共享 jsonl（单线程，按 subset 顺序）
  #
  # record.ts 写的是每题各自的文件而不是 append 到共享 jsonl ——
  # 并发下 append 几 KB 的 `model_patch` 不保证原子，两条会交错成坏行，
  # 而官方 harness 读到坏行的反应是把那条当"没提交"（→ 假 no_patch）。
  #
  # 顺序按 `$ids`（= subset 顺序）而不是完成顺序：让两次 run 的 jsonl
  # 可以直接 diff。并发下完成顺序是随机的，按完成顺序写就 diff 不了。
  #
  # ⚠️ 缺文件不静默跳过 —— 那正是"一条实例悄悄没进 predictions"的形态，
  # 而它在分数上长得和"跑了但没产出 patch"一模一样。
  local missing=0
  for iid in $ids; do
    local rec="$out_dir/.parts/$iid.record.json"
    local prd="$out_dir/.parts/$iid.prediction.json"
    if [[ -f "$rec" && -f "$prd" ]]; then
      cat "$rec" >>"$out_dir/records.jsonl"
      cat "$prd" >>"$out_dir/predictions.jsonl"
    else
      bad "$iid: 缺 record/prediction 分片（record.ts 没跑成？）—— 这条不会进 predictions"
      missing=$((missing + 1))
    fi
  done
  ((missing > 0)) && bad "⚠️ $missing 条实例缺分片：predictions 条数 < 请求条数，grade.ts 会判 partial"
  ok "predictions 落盘: ${out_dir#"$REPO_ROOT"/}/predictions.jsonl"

  # ## 全轮休眠汇总：单题的告警会被 10 题的日志刷掉
  #
  # 单题那条告警（run_one 里）在跑的时候看得见，但**读报告的人看的是这一行**。
  # 判据刻意是"任一题 > 0 即点破整轮不可外比"而不是"总和大于某个阈值"：
  # 717 秒睡在一题里，那一题的 agent_ms 就已经废了，平摊到 10 题看起来会很小。
  local slept_total slept_worst
  read -r slept_total slept_worst <<<"$("$VENV_PY" - "$out_dir/records.jsonl" <<'PY'
import json, sys
tot = worst = 0
seen = False
for line in open(sys.argv[1]):
    line = line.strip()
    if not line:
        continue
    v = json.loads(line).get("host_slept_ms")
    if v is None:      # 没量到 —— 不参与汇总，也不伪造 0
        continue
    seen = True
    tot += v
    worst = max(worst, v)
print(f"{tot} {worst}" if seen else "- -")
PY
)"
  if [[ "$slept_total" == "-" ]]; then
    bad "⚠️ 本轮没有量到宿主休眠（host_slept_ms 全为 null）—— 耗时可信度未知，别拿去与其他 run 并排"
  elif ((slept_worst > 1000)); then
    bad "⚠️ 本轮宿主休眠合计 $((slept_total / 1000))s（单题最长 $((slept_worst / 1000))s）"
    bad "   → 这一轮的 agent_ms / wall_ms **不可与其他 run 并排**；受影响的题的超时闸门也被延长了同样时长"
  else
    ok "宿主未休眠（host_slept_ms 全 0）—— 本轮耗时口径干净"
  fi
}

# ## 毫秒时钟：不能用 `date +%s%3N`
#
# 实测（macOS 15）：`date +%s%3N` **exit 0**，但输出是 `17876085973N` ——
# GNU 的 `%3N`（纳秒截断到毫秒）在 BSD date 上不被识别，于是那个 `N`
# 被当成字面量留在输出里。后果是 `$((t1 - t0))` 报
# `value too great for base (error token is "17876085893N")`，
# **而写成 `date +%s%3N || date +%s000` 的兜底根本不会触发**（退出码是 0）。
#
# 所以判据不能是「命令失败了没」，只能换一个两边都对的实现。
# `perl` / `python3` 都在，用 perl 更轻（不必启动解释器读 stdlib）。
# ## 产物解压：整轮一次，不是每题一次
#
# 原先在 run_one 里每条实例各自 mktemp + tar -xzf 一份 40MB 产物再删。
# 10 题 = 解压 10 次同一个文件；`SWE_JOBS>1` 时还会有几个 tar 同时抢磁盘 IO，
# 直接体现在每条的 setup_ms 上。
#
# 解出来的目录**故意不清理** —— 它在 mktemp 下，由系统回收。
# 在 run_one 里 `rm -rf` 过（每条跑完删自己那份），并发下会变成
# "一条删掉了另一条正在 cp 的文件"，失败形态是随机的 `docker cp` 报文件不存在。
# 共用一份 + 不删，两个问题一起没了。
RESOLVED_BIN=""
resolve_binary() {
  local artifact="$1"
  case "$artifact" in
  *.tar.gz | *.tgz)
    local tmp_extract
    tmp_extract="$(mktemp -d)"
    tar -xzf "$artifact" -C "$tmp_extract" || {
      bad "产物解压失败: $artifact"
      return 1
    }
    RESOLVED_BIN="$(find "$tmp_extract" -type f -name 'sid-code*' -perm -u+x | head -1)"
    ;;
  *)
    # 裸二进制：可执行位可能没设（比如刚从别处 cp 过来），这里不挑剔，
    # 反正进容器后还会 chmod +x 一次。
    RESOLVED_BIN="$artifact"
    ;;
  esac
  [[ -n "$RESOLVED_BIN" && -f "$RESOLVED_BIN" ]] || {
    bad "产物里找不到可执行的 sid-code: $artifact"
    return 1
  }
}

now_ms() {
  perl -MTime::HiRes=time -e 'printf "%.0f", time()*1000' 2>/dev/null ||
    python3 -c 'import time;print(int(time.time()*1000))'
}

# ## 宿主休眠：既要防止它发生，也要在发生了之后能被看见
#
# 实测踩到（2026-08-26，smoke-10）：`django__django-13964` 的 `agent_ms=2009007`
# （33.5 min）**超过了 SWE_TIMEOUT=1800，而 timed_out 是 None、agent_exit=0**，
# 看起来像超时闸门坏了。逐层排查后闸门是好的（perl-alarm 兜底与隔着 docker exec
# 都实测 exit 124），真凶在 `pmset -g log`：**宿主睡了 717 秒，正好在这一题跑的中间。**
#
# 根因是一个口径分裂：`alarm()` 按**进程可运行时间**计，休眠期间不推进；
# 而 `now_ms()` 取**墙钟**。于是同一段休眠同时造成两个后果：
#
#   1. **`agent_ms` 被污染** —— 它正是北极星「更快」那条的取数源。
#      smoke-9 的 85.2 min 与 smoke-10 的 118.9 min **口径不一致**（后者含 717s 休眠），
#      两轮耗时不可并排，尽管都是 jobs=1。
#   2. **超时闸门被静默续命** —— 宿主睡得够久，一题可以跑到墙钟 2× 上限还不被杀。
#      失败形态是"某题墙钟离谱地长"，而 `timed_out=false` 把人引向"agent 慢"。
#
# 与记忆里 sleep-deduction-only-in-loop-fallback-false-kills **同源反向**：
# 那条是"休眠扣减只在一处做 → 误杀健康流"，这条是"休眠不扣减 → 漏杀超长题"。
# **同一个「墙钟 vs 可运行时间」的分裂，两个方向各产生一个缺陷。**
#
# 所以这里做两件事，缺一不可：
#   ① `start_sleep_inhibitor` —— 防止休眠发生（根治：不发生则两个问题一起没了）
#   ② `slept_ms_since`        —— 发生了要能被看见（诚实：挡不住的场合也能归因）
#
# ⚠️ **只做 ① 是不够的**：跑在别人机器上、caffeinate 被系统忽略、
# 或 Linux 上没有 systemd-inhibit 时，问题会**静默复发**，
# 而报告里的耗时数字看起来完全正常。这正是这个缺陷第一次逃过验收的方式。

# 起一个"别睡"的守卫进程，把 pid 写进 SLEEP_INHIBITOR_PID。
# 拿不到守卫不算失败 —— 那种场合靠 ② 的 host_slept_ms 兜底。
start_sleep_inhibitor() {
  SLEEP_INHIBITOR_PID=""
  SLEEP_INHIBITOR_KIND="none"
  if command -v caffeinate >/dev/null 2>&1; then
    # -d 屏幕 -i 空闲睡眠 -m 磁盘 -s 系统睡眠（接电源时才有意义，一并给上）
    caffeinate -dims &
    SLEEP_INHIBITOR_PID=$!
    SLEEP_INHIBITOR_KIND="caffeinate"
  elif command -v systemd-inhibit >/dev/null 2>&1; then
    # --what=sleep:idle 只挡睡眠，不挡关机；sleep infinity 由 stop 时杀掉
    systemd-inhibit --what=sleep:idle --why="sid-code swe-bench run" \
      --mode=block sleep infinity &
    SLEEP_INHIBITOR_PID=$!
    SLEEP_INHIBITOR_KIND="systemd-inhibit"
  fi
  if [[ -n "$SLEEP_INHIBITOR_PID" ]]; then
    # ⚠️ `${VAR}` 必须带花括号：`$VAR）` 会让 bash 把全角右括号吃进变量名
    # → `set -u` 下直接「未绑定的变量」退出。门禁在 tests/scripts/shell-fullwidth-var.test.ts，
    # 本仓这是第五次踩同一个坑（前四次记在 ZZ.2d 与 771 行那处）。
    info "休眠守卫已起（${SLEEP_INHIBITOR_KIND}, pid=${SLEEP_INHIBITOR_PID}）"
  else
    bad "⚠️ 未找到 caffeinate / systemd-inhibit —— 本轮不挡宿主休眠，靠 host_slept_ms 兜底"
  fi
}

stop_sleep_inhibitor() {
  [[ -n "${SLEEP_INHIBITOR_PID:-}" ]] || return 0
  kill "$SLEEP_INHIBITOR_PID" 2>/dev/null || true
  wait "$SLEEP_INHIBITOR_PID" 2>/dev/null || true
  SLEEP_INHIBITOR_PID=""
}

# ## 累计休眠时钟：两个平台的时钟语义**正好相反**，用错一个就恒 0
#
# 判据是"墙钟推进了多少 − 可运行时间推进了多少"，难点在于哪个时钟含休眠：
#
#   macOS：CLOCK_MONOTONIC     **含**休眠   CLOCK_UPTIME_RAW **不含**
#   Linux：CLOCK_BOOTTIME      **含**休眠   CLOCK_MONOTONIC  **不含**
#
# 本机实测（2026-08-27）：MONOTONIC=3106815s 而 UPTIME_RAW=1337342s ——
# 差 1769473s，那就是这台机器累计睡过的时间。**若在 macOS 上照 Linux 的写法
# 用 MONOTONIC 当"不含休眠"的那个，差值恒为 0**，字段在、有值、值是废的
# （记忆 metric-exists-but-value-is-junk 那一类）。
#
# 取不到任何一对时钟时返回空串而不是 0 —— **"没量到"必须与"没休眠"可区分**。
awake_ms() {
  python3 -c '
import sys, time
# (含休眠, 不含休眠) 按平台取；名字不存在的直接跳过
pairs = [("CLOCK_UPTIME_RAW", None), ("CLOCK_BOOTTIME", "CLOCK_MONOTONIC")]
if sys.platform == "darwin":
    # macOS: MONOTONIC 含休眠，UPTIME_RAW 不含
    try:
        print(int(time.clock_gettime(time.CLOCK_UPTIME_RAW) * 1000)); sys.exit(0)
    except Exception:
        pass
else:
    try:
        print(int(time.clock_gettime(time.CLOCK_MONOTONIC) * 1000)); sys.exit(0)
    except Exception:
        pass
print("")
' 2>/dev/null
}

# 从一对 (wall_before, awake_before) 算出这段区间里宿主睡了多少毫秒。
# 空串输入 → 空串输出（沿着"没量到"往下传，不伪造 0）。
# 允许负数抖动，clamp 到 0：两个时钟不是同一次系统调用取的，差几毫秒是正常的。
slept_ms_since() {
  local wall_before="$1" awake_before="$2" wall_after="$3" awake_after="$4"
  [[ -n "$wall_before" && -n "$awake_before" && -n "$wall_after" && -n "$awake_after" ]] || {
    printf ''
    return 0
  }
  local d=$(((wall_after - wall_before) - (awake_after - awake_before)))
  ((d < 0)) && d=0
  printf '%d' "$d"
}

# ## 便携 timeout：macOS 没有 `timeout`
#
# 实测踩到（2026-08-25）：`timeout 1800 docker exec ...` 在 macOS 上
# **599ms 就返回 exit 127**（command not found）—— `timeout` 是 GNU coreutils
# 的命令，macOS 自带的只有 BSD 那套，`gtimeout` 也没装。
#
# 这个失败形态最坑的地方：**127 被记成了 `agent_error`**，
# 报告里写「agent 非 0 退出：127」，看起来像 agent 自己崩了；
# 而 `wall=599ms` 才是唯一的线索（真跑一题是分钟量级）。
# 换句话说，**harness 的一个环境缺失被记成了被测对象的能力问题** ——
# 正是 gold 自检要防的那类错，只是这次发生在 gold 之后。
#
# 优先用系统的 timeout / gtimeout（Linux CI 上有，语义最准），
# 都没有时用 perl 的 alarm 实现：`$?` 的语义与 GNU timeout 对齐 ——
# **超时返 124**，因为 `timed_out` 的判据就是 `== 124`。
run_with_timeout() {
  local secs="$1"
  shift
  if command -v timeout >/dev/null 2>&1; then
    timeout "$secs" "$@"
  elif command -v gtimeout >/dev/null 2>&1; then
    gtimeout "$secs" "$@"
  else
    perl -e '
      my $secs = shift @ARGV;
      my $pid = fork();
      die "fork failed: $!" unless defined $pid;
      if ($pid == 0) { exec @ARGV or exit 127; }
      # 超时就杀掉子进程并按 GNU timeout 的约定返回 124
      local $SIG{ALRM} = sub { kill "TERM", $pid; sleep 2; kill "KILL", $pid; exit 124 };
      alarm $secs;
      waitpid($pid, 0);
      alarm 0;
      my $st = $?;
      exit($st & 127 ? 128 + ($st & 127) : $st >> 8);
    ' "$secs" "$@"
  fi
}

run_one() {
  local iid="$1" run_id="$2" arch="$3" artifact="$4" proxy_ip="$5" out_dir="$6"
  local img cname
  img="$(image_name "$iid" "$arch")"
  cname="sid-swe-${run_id}-${iid//__/_}"
  cname="$(echo "$cname" | tr '[:upper:]' '[:lower:]' | cut -c1-60)"

  info "── $iid"
  # 现取题面（§4.2：不落在 yaml 里）。**只取白名单字段，不含任何答案。**
  local meta
  meta="$(HF_HUB_OFFLINE=${HF_HUB_OFFLINE:-1} "$VENV_PY" "$SWE_DIR/fetch-instance.py" "$iid" 2>/dev/null | tail -1)" || {
    bad "$iid: 题面现取失败（instance_id 可能不在 dataset 里 —— 那会静默变成 ungraded）"
    return 1
  }
  local ps_file="$out_dir/$iid.prompt.txt"
  "$VENV_PY" - "$meta" "$SWE_DIR/prompt-v1.txt" "$ps_file" <<'PY'
import json, sys
meta = json.loads(sys.argv[1])
tpl = open(sys.argv[2]).read()
assert "{problem_statement}" in tpl, "prompt-v1.txt 缺 {problem_statement} 占位符"
open(sys.argv[3], "w").write(tpl.replace("{problem_statement}", meta["problem_statement"]))
PY

  docker rm -f "$cname" >/dev/null 2>&1 || true
  # ## 三段计时，不是一个 wall_ms
  #
  # `wall_ms` 的边界一直是 t0（docker run 前）→ t1（docker exec 返回后），
  # 也就是说它**把起容器 + cp 40MB 产物算进了「agent 耗时」**。
  # smoke-8 的 94.2 分钟里有多少是搬运、多少是模型在想，一个字都看不出来。
  #
  # 拆成三段之后才有归因能力（北极星「更快」那条要的就是这个）：
  #   setup_ms  docker run + tar 解压 + cp 产物/题面（**基础设施**，与模型无关）
  #   agent_ms  docker exec 跑 sid-code（**真正的能力+延迟账**）
  #   extract_ms git add/diff 提取 patch + 取回轨迹（收尾搬运）
  # wall_ms 保留为三段之和，向后兼容旧报告的口径。
  local t0 t1 t_setup_done t_agent_done
  t0=$(now_ms)

  # 起容器：接**隔离 network**，出网只能过 allowlist 代理
  docker run -d --name "$cname" --platform "linux/$arch" \
    --network "$RUN_NET" \
    -e "http_proxy=http://$proxy_ip:8080" \
    -e "https_proxy=http://$proxy_ip:8080" \
    "$img" sleep infinity >/dev/null || {
    bad "$iid: 容器起不来（镜像 $img 拉不到？）"
    return 1
  }

  # docker cp 产物 + 题面。
  #
  # ## 解压只做一次，由 cmd_run 预先做好（$RESOLVED_BIN）
  #
  # 原先每条实例各自 `mktemp -d` + `tar -xzf` 一份 40MB 产物再删掉 ——
  # 10 题就是解压 10 次同一个文件，纯浪费，而且 `SWE_JOBS>1` 时
  # 几个 tar 同时抢磁盘 IO，直接拖长每条的 setup 段。
  # 现在由 `resolve_binary` 在起第一个容器之前解一次，所有实例共用。
  # （`docker cp` 本身仍是每条一次 —— 那是往各自容器里放，省不掉。）
  local bin_path="$RESOLVED_BIN"
  [[ -n "$bin_path" && -f "$bin_path" ]] || {
    bad "$iid: 产物里找不到可执行的 sid-code（artifact=${artifact}）"
    docker rm -f "$cname" >/dev/null 2>&1
    return 1
  }
  docker cp "$bin_path" "$cname:/usr/local/bin/sid-code" >/dev/null
  docker exec "$cname" chmod +x /usr/local/bin/sid-code
  docker cp "$ps_file" "$cname:/tmp/prompt.txt" >/dev/null
  # 搬运结束、模型还没开始 —— 这个点把「基础设施」与「能力」切开
  t_setup_done=$(now_ms)
  # 休眠只在 agent 段内测：setup/extract 是秒级搬运，睡在那里不影响任何结论，
  # 而 `agent_ms` 是北极星「更快」的取数源，被污染就直接让曲线说谎（见 awake_ms 上方注释）。
  local awake_agent_start
  awake_agent_start=$(awake_ms)

  # 跑 agent。API key 走 -e，**不进 argv**（进了 docker inspect 就能读到）
  local agent_out agent_exit=0 timed_out=0
  set +e
  agent_out="$(run_with_timeout "$TIMEOUT_SEC" docker exec \
    -e "SC_API_KEY=$SC_API_KEY" -e "SC_BASE_URL=$SC_BASE_URL" \
    -e "SC_MODEL=$SC_MODEL" -e "SC_MODEL_ID=${SC_MODEL_ID:-}" \
    -e "SC_PROVIDER=${SC_PROVIDER:-openai}" \
    -e "SC_EFFORT_LEVEL=$EFFORT_LEVEL" -e "SC_COST_LIMIT=$COST_LIMIT" \
    "$cname" bash -lc "$(build_agent_script)" 2>&1)"
  agent_exit=$?
  set -e
  [[ $agent_exit == 124 ]] && timed_out=1
  t_agent_done=$(now_ms)
  local host_slept_ms
  host_slept_ms="$(slept_ms_since "$t_setup_done" "$awake_agent_start" \
    "$t_agent_done" "$(awake_ms)")"
  # 点破，不只落盘：非 0 时这一题的 agent_ms 已不可外比，且超时闸门被续了这么久。
  # 阈值 1000ms 是为了不被两次时钟调用之间的几毫秒抖动刷屏。
  if [[ -n "$host_slept_ms" ]] && ((host_slept_ms > 1000)); then
    bad "$iid: ⚠️ 宿主休眠 $((host_slept_ms / 1000))s —— 本题 agent_ms 含休眠、不可外比；超时闸门实际被延长了同样时长"
  fi

  # ## agent 输出必须落盘 —— 非 0 退出时它是**唯一**的线索
  #
  # 实测踩到（2026-08-25，10 题跑分时）：`django__django-13964` 记成
  # `agent_error / exit=1 / wall=66s / patch=0B`，而 `agent_out` 捕获了却从没写出去，
  # 于是**「67 秒就退了」这个事实之外什么都没有** ——
  # 分不清是模型放弃了、网关拒了、还是容器里少个依赖。
  #
  # 这直接违背 §附录 ZZ.5 第 4 条那条判据（「先问它是不是环境故障」）：
  # 那条判据要能执行，前提是**看得到 agent 说了什么**。
  # 一个记成 agent_error 但查不出原因的实例，等于一条不可归因的数据。
  #
  # ⚠️ **不做任何过滤/截断**：截断就会砍掉尾部的报错，而报错通常在尾部。
  # key 不会出现在这里（只走 `docker exec -e`，agent 也不回显它），
  # 但落盘路径仍在 `runs/<id>/` 内，与其他中间产物同级、不额外扩大暴露面。
  printf '%s' "$agent_out" >"$out_dir/$iid.agent.log"

  # 提取 patch。**与 agent 段分开跑**：agent 非 0 退出时工作树里可能已有部分改动，
  # 合成一段会让 `set -e` 跳过提取，把一个本该有 patch 的结果记成 no_patch。
  local extract_out
  set +e
  extract_out="$(docker exec "$cname" bash -lc "$(build_extract_script)" 2>&1)"
  set -e

  printf '%s' "$extract_out" >"$out_dir/$iid.extract.raw"

  # ## 轨迹取回 —— 必须在 docker rm 之前，且失败不许中断整轮
  #
  # 轨迹一直在生成（容器日志有 `轨迹采集已启用`，digest 自检还报过
  # `检出 5 条[高]级异常`），但从没被拷出来 → `docker rm -f` 一删，
  # **结构化的 StreamPhase / RetryTelemetry / exit_status 全部消失**，
  # 排查只能退化成 grep agent.log。ZZZZ.10 归因那两条 429 就是这么啃的。
  #
  # ⚠️ `|| true`：取轨迹是**观测**，不是判分依赖。这一步失败（目录不存在、
  # agent 在建轨迹前就崩了）绝不能让一条本来有效的记录变成 bad ——
  # 否则会为了"日志齐全"丢掉真数据，方向正好反了。
  # 取不到时显式打一行，别让"没有轨迹目录"看起来像"轨迹是空的"。
  #
  # ## 取回后的目录形状 = trace-digest 的输入形状
  #
  # 容器内 outputDir 是 `/tmp/sid-traj/trajectories`（见 build_agent_script ②），
  # 所以 `cp /tmp/sid-traj/.` 落地就是 `<dst>/trajectories/sessions/<id>/` ——
  # 正是 `trace/digest.ts` 的 resolvePaths 期望的形状，可直接：
  #     SID_CODE_HOME=<dst> bun scripts/trace-digest.ts
  # ⚠️ 不要把 cp 的源改成 `.../sid-traj/trajectories/.`（少一层 → digest 读不到），
  # 也不要改成 `.../sid-traj`（多一层 iid.trajectories/sid-traj/ → 同样读不到）。
  local traj_dst="$out_dir/$iid.trajectories"
  if docker cp "$cname:/tmp/sid-traj/." "$traj_dst" >/dev/null 2>&1; then
    :
  else
    printf '  ⚠️  %s: 轨迹取回失败（容器内 /tmp/sid-traj 不存在？agent 可能在建轨迹前就退了）\n' "$iid" >&2
  fi

  # ## $SID_CONFIG_DIR 侧的遥测也要取回 —— 它不在 outputDir 下
  #
  # 实测（2026-08-26）：`telemetry/events.jsonl`、`session-index.jsonl`、
  # `sessions/<cwd>/<id>.jsonl` 落在 `$SID_CONFIG_DIR`，**不随 trace.outputDir 走**。
  # 上面那条 cp 一个都带不到，于是会话级 hook 事件同样随 `docker rm -f` 消失。
  # 只取这三样（不整个 cp 配置目录）：settings.json 里有 api_key，
  # 而 §ZZ 那条纪律是 key 只走 exec env、绝不落盘。
  local cfg_dst="$out_dir/$iid.sidcfg"
  mkdir -p "$cfg_dst"
  for rel in telemetry session-index.jsonl sessions; do
    docker cp "$cname:/tmp/sid-cfg/$rel" "$cfg_dst/" >/dev/null 2>&1 || true
  done
  # 一个都没取到就把空目录删掉，别留下一个空壳让人以为"遥测是空的"
  rmdir "$cfg_dst" 2>/dev/null || true

  docker rm -f "$cname" >/dev/null 2>&1 || true

  # ## 落盘放在最后：t1 必须包含提取与取回，否则 wall_ms 又少一段
  #
  # 这一步以前在提取之后、轨迹取回**之前** —— 于是 cp 40MB 轨迹的耗时
  # 掉在所有字段之外。三段之和 == wall_ms 这个不变量有单测守着，
  # 挪动任一 now_ms 调用点都会让它红。
  t1=$(now_ms)
  bun run "$SWE_DIR/record.ts" \
    --instance "$iid" --run-dir "$out_dir" \
    --agent-exit "$agent_exit" --timed-out "$timed_out" \
    --wall-ms "$((t1 - t0))" \
    --setup-ms "$((t_setup_done - t0))" \
    --agent-ms "$((t_agent_done - t_setup_done))" \
    --extract-ms "$((t1 - t_agent_done))" \
    --host-slept-ms "$host_slept_ms" || bad "$iid: 记录落盘失败"
}

build_agent_script() {
  # ## ⚠️ 四件事必须一起做对，少一件这一轮数据就有系统性偏差
  #
  # ### ① 权限：只能用 `--dangerously-skip-permissions` 布尔 flag
  #
  # 实测（smoke-8，2026-08-25）：`acceptEdits` 下 10 条实例共 **113 次权限拒绝**，
  # django-13964 / matplotlib-20488 / django-15128 三条**过半轮次**是被拒绝烧掉的
  # （58% / 58% / 55%）。被拒的都是做题必需的动作：
  #
  #     bash(python3 -m pytest lib/matplotlib/tests/test_image.py::…) → 拒绝(非交互模式)  ×3
  #     write(/tmp/repro.py) → 需确认(路径验证: 写入路径在工作区外) → 拒绝              ×5
  #     bash(python -c "import numpy; print(numpy.__version__)")     → 拒绝              ×2
  #
  # 成因：`acceptEdits` 只自动放行 FILE_TOOLS 与 **cwd 内**的 7 个 fs 命令
  # （`checker.ts` 的 ACCEPT_EDITS_FS_COMMANDS：mkdir/touch/rm/rmdir/mv/cp/sed）。
  # `python` / `pytest` / `git log` 全部落到默认 ask → headless 无交互 → **直接拒绝**。
  #
  # 于是 matplotlib 两条被记成「40 轮预算用尽」，读起来像"能力不够/在绕圈"，
  # 真相是**它一直在试着跑测试验证自己的修复，被拦了 23 次**。
  # ⚠️ 这正是「非能力原因混进能力账」那一类，与 fuzz 兜底、NUL 吞字段同型。
  #
  # ⛔ **修它时踩了第二个坑**：第一版改成 `--permission-mode bypassPermissions`，
  # 而那不是合法模式名 —— 实测比 acceptEdits **更差**（连工作区内的 write 都拒）。
  # 三模式对照表、为什么 always-allow 也不够、为什么必须用布尔 flag，
  # 全部记在文件头 `PERMISSION_FLAG` 那段注释里，改这里之前先读那段。
  #
  # 为什么不"逐条加 allow 规则"：**allow 白名单会变成新的必控变量** ——
  # 写多一条少一条都改变 agent 能做什么，而"这一轮放行了哪些命令"极难在报告里说清。
  # 容器本身就是沙箱（无外网、跑完即删、只有一个 testbed 仓库），
  # 权限层在这里防的不是攻击者，是它自己的默认保守。
  # ⚠️ 它是必控变量，已记进 run-meta.json（permission_mode），换值即分数不可比。
  #
  # ### ② 轨迹必须捞出来，**而且要落成 trace-digest 读得懂的形状**
  #
  # 容器内日志明确写着 `轨迹采集已启用`，digest 自检甚至报了
  # `会话 20260825-074654-f959d79e 检出 5 条[高]级异常：exit_status_error, …`
  # —— **而那 5 条谁也没看见过**，因为轨迹写在容器内、`docker rm -f` 直接删掉。
  # 于是 ZZZZ.10 归因那两条 429 时只能靠 grep agent.log 硬啃，
  # 而轨迹里本来就有结构化的 StreamPhase / RetryTelemetry / exit_status。
  #
  # ⚠️ **outputDir 末级必须叫 `trajectories`**，否则取回来也读不了（2026-08-26 实测）：
  #   - `collector.ts` 是 `outputDir ?? sidPaths.trajectories()` —— 显式给了
  #     outputDir 时它**就是** sessions 的父目录，不再拼一层 `trajectories/`；
  #   - 而 `trace/digest.ts` 的 resolvePaths 硬拼 `{root}/trajectories/sessions`。
  # 于是 outputDir=/tmp/sid-traj 时产出 `/tmp/sid-traj/sessions/<id>/`，
  # 拿 `SID_CODE_HOME` 指过去 digest 报「未找到任何会话轨迹」——
  # 取回成功、文件都在、**排查工具一条都读不到**。
  # 写成 `/tmp/sid-traj/trajectories` 后，`docker cp .../sid-traj/.` 落地即是
  # `<dst>/trajectories/sessions/<id>/`，`SID_CODE_HOME=<dst>` 直接能跑 digest。
  # （实测：补上这一层后 digest 正常输出 L0 事实层与 exit_status 出处。）
  #
  # session.traj / raw.jsonl / events.jsonl 三个文件同在 session 目录下
  # （`trace/writer.ts` 三个写入方法都 join 同一个 sessionDir），所以一次 cp 全带走。
  #
  # ### ③ 关掉轨迹上传 —— 评测容器没有外网，每条实例都在白跑重试
  #
  # 10/10 实例都有这两行：
  #     [TRACE] 上传已启用: https://www.sid-code.cc/traj
  #     [TRACE] 服务端不可达，上传任务进入重试队列
  # 上传配置**不是**这个脚本写的，是 `backfill-team-defaults` 迁移把编译进二进制的
  # `scripts/team-defaults.template.json` merge 进了 `$SID_CONFIG_DIR/settings.json`
  # （模板里 `trace.upload.url` / `token` 都有值）。同一个 merge 还带进了
  # `subAgentModels` / `fallbackModel: ali-deepseek-v4-flash` ——
  # 日志里那 4 条 `模型 "ali-deepseek-v4-flash" 未在 availableModels 中找到` 就是它。
  #
  # 所以 settings.json **必须自己写全这些顶层键**：迁移只补"用户缺失的顶层键"，
  # 我们显式给了值它就不会覆盖。这比"跑完再删"可靠 ——
  # 后者要赌迁移的执行时机，而顶层键是否存在是确定的。
  #
  # ### ④ 占位必须覆盖模板的**全部**顶层键，漏掉的会静默改变这一轮
  #
  # ③ 那份修法只堵了 5 个键，实测（2026-08-26，照抄这里的 PYCFG 跑真二进制）
  # 迁移**仍然**补进 12 个：
  #     language, permissionMode, allowedTools, disallowedTools, quota, costLimit,
  #     search, disabledSkills, trustProjectExtensions, allowedDirectories,
  #     blockedDirectories, effortLevel
  # 其中三个有实质后果，且都是"不报错、只让分数变差或不可比"的形态：
  #
  #   - **`costLimit: 100` + `quota.costLimit: 100`** —— `loop.ts` 在
  #     `quotaResult.level === "exceeded"` 时 `yield done; return`，**整轮静默结束**。
  #     10 题 × 40 轮撞 $100 完全可能，撞上了会被记成 `no_patch`，读起来像能力问题。
  #     显式设 0：`quota.ts` 的判据是 `costLimit <= 0` 直接 return null（= 不限）。
  #     ⚠️ 顶层 `costLimit` 与 `quota.costLimit` 是**两个互不影响的字段**
  #     （见 `config/schema.ts` 那条注释），必须都占住。
  #   - **`effortLevel: "max"`** —— 直接决定推理预算与成本，是必控变量。
  #     此前完全没记，也就是说前几轮跑的是**谁也没选过**的值。现在由
  #     `SWE_EFFORT_LEVEL` 显式给定并记进 run-meta。
  #   - **`permissionMode: "default"`** —— CLI 参数优先级更高所以没真生效，
  #     但那是运气不是设计（同 fallbackModel 那条）。显式占住。
  #
  # 判据教训：**"补了 5 个键"与"模板不会再 merge"是两回事**。
  # 唯一可靠的验证是跑一次真二进制、看它还打不打
  # 「已补全团队默认配置字段: …」那一行 —— 打出来就说明还有漏的。
  # 反漂移门禁在 `tests/eval/swe-bench-runner.test.ts`：它从
  # `scripts/team-defaults.template.json` **现取**顶层键清单来比对，
  # 不是手写一份 —— 手写的清单会在模板加键时静默过期。
  # ## ⑤ heredoc 必须**加引号**（`<<'SCRIPT'`），宿主变量走 printf 注入
  #
  # 这里原先是 `cat <<SCRIPT`（未加引号），于是**整个脚本体都在宿主 bash 里做一次展开**
  # —— 包括下面 Python 注释里的反引号。实测每题固定刷 5 行（smoke-9）：
  #
  #     exec-swebench.sh: 行 955: yield: 未找到命令
  #     exec-swebench.sh: 行 955: quota.ts: 未找到命令
  #     exec-swebench.sh: 行 955: ≥0: 未找到命令
  #
  # 成因是三行 Python 注释里写了 `` `yield done; return` `` 这类反引号。
  # smoke-9 那轮**侥幸没造成损坏**（settings.json 20 键实测齐全），但最小复现证实
  # 同一形态能做到两件事：
  #
  #     cat <<SCRIPT                      # 未加引号
  #     # 注释里带反引号：`echo INJECTED`
  #     SCRIPT
  #     → 输出 "# 注释里带反引号：INJECTED"   ← 命令真的被执行了
  #     # 注释：判 `costLimit <= 0` 为错
  #     → 输出 "# 注释：判  为错"             ← 整段被静默吞掉
  #
  # 第二种形态是真正危险的那个：**它会静默改写 settings.json 的内容**
  # （吞掉的若不是注释而是一行配置，就是一个未记录的必控变量）。
  #
  # ⛔ 不要用"把那几处反引号改成单引号"来修 —— 那修的是**症状**，
  # 下一个人（或下一个 agent）在这个 heredoc 里写注释时会再踩一次。
  # 本文件的注释密度极高，这条几乎必然复发。加引号才是修病因。
  # 反漂移门禁在 `tests/scripts/shell-heredoc-backtick.test.ts`。
  #
  # 代价：加引号后宿主变量不再展开，所以 $MAX_TURNS / $PERMISSION_FLAG 改为 printf 注入
  # （见函数末尾）。同时 `\$SID_CONFIG_DIR` 这类**给容器用**的变量不必再转义 ——
  # 少一层转义规则，也就少一个"转义漏了但不报错"的入口。
  cat <<'SCRIPT'
set -e
source /opt/miniconda3/bin/activate
conda activate testbed
cd /testbed
export SID_CONFIG_DIR=/tmp/sid-cfg
# ⚠️ 末级目录名必须是 trajectories（见 ② 那段：collector 不再拼这一层，而 digest 硬拼它）
mkdir -p "$SID_CONFIG_DIR" /tmp/sid-traj/trajectories
python - <<'PYCFG'
import json, os
m = os.environ["SC_MODEL"]
cfg = {
    "model": m,
    "availableModels": [{
        "name": m,
        "model_id": os.environ.get("SC_MODEL_ID") or m,
        "provider": os.environ.get("SC_PROVIDER", "openai"),
        "api_key": os.environ["SC_API_KEY"],
        "base_url": os.environ["SC_BASE_URL"],
    }],
    # ── 下面这些键存在的唯一目的：占住位置，别让团队默认模板 merge 进来 ──
    #
    # 缺哪个，backfill-team-defaults 就会把模板里那个键补进来。清单必须与
    # scripts/team-defaults.template.json 的顶层键**逐一对齐** ——
    # 漏一个就是一个未记录的必控变量（见 build_agent_script ④ 的三个实例）。
    # 反漂移门禁：tests/eval/swe-bench-runner.test.ts 从模板现取键清单比对。
    #
    # D17 必控变量表不允许评测里出现第二个模型，所以 fallbackModel 必须显式为空。
    "fallbackModel": "",
    "fallbackSwitchMode": "off",
    "subAgentModels": {},
    "mcpServers": {},
    "hooks": {},
    "language": "zh",
    # permissionMode 由 CLI 的 --dangerously-skip-permissions 决定（优先级更高），
    # 这里只是占位防 merge。写 default 而不是别的值：它是"不额外放行"的那一端，
    # 万一哪天 CLI 那条失效了，失败形态是"被拒"而不是"静默全放行"。
    "permissionMode": "default",
    "allowedTools": [],
    # ## 禁掉外网工具 —— 这是 smoke-9 唯一那条退步的直接成因
    #
    # 容器无外网（只放行网关），但 web 工具一直是可用的。smoke-9 的 django-13964
    # **40 轮全部用完、零编辑**，80 步里 7 步（8.8%）打在 web_search / web_fetch 上：
    # 模型在反复找 Django 上游 ticket 的修复 diff，连试了 32335/32340/32360/32365/32369
    # 五个编号，还试了 pip download django==3.2.13。这不是能力问题，是**它不知道自己没网**。
    #
    # ⚠️ smoke-8 这条题反而是 solved —— 因为那时 113 次权限拒绝把它逼回了只读代码库
    # 这条正确路径。**权限一放开，浪费也放开了**：一个约束在被解除之前，
    # 可能正意外地承担着另一个约束的职责。
    #
    # ## 第二条理由（比"省轮数"更硬）：查上游 = 看答案
    #
    # SWE-bench 的题面本来就不该允许查上游 fix diff。现在查不到只是因为容器无外网 ——
    # **那是运气不是设计**（同 permissionMode 那格）。allowlist 代理哪天放宽一点，
    # 它就变成数据泄漏，而且泄漏时没有任何东西会红。所以这里要的是硬约束。
    #
    # ## ⚠️ 这个键在 2026-08-26 之前是个静默空操作
    #
    # `disallowedTools` 原先唯一落点是权限层（`checker.ts` Step 3），而 `check()` 对
    # `skipPermissions` 的早退发生在 Step 3 **之前** —— 我们跑的正是
    # `--dangerously-skip-permissions`，于是这一格填什么都不生效、且零日志。
    # 实测：`{disallowedTools:["web_search"], skipPermissions:true}` → `{allowed:true}`。
    # 已在产品侧修掉（`registry.ts` removeByNames + register 拒收，见那里的注释），
    # 判据是**工具不进 schema**，不是"调了会被拒" —— 后者每次都要烧一轮才知道。
    #
    # 验收判据（smoke-10）：逐题 web_search / web_fetch 调用数**全 0**。
    # 不为 0 说明产品侧那条裁剪没生效，别去改提示词凑数。
    "disallowedTools": ["web_search", "web_fetch"],
    "disabledSkills": [],
    "trustProjectExtensions": False,
    "allowedDirectories": [],
    "blockedDirectories": [],
    # search 后端指向线上 searxng（容器无外网）。占住它没让 web_search 变可用
    # —— 那条路由由 allowlist 代理拦，且上面 disallowedTools 已把工具整个裁掉。
    "search": {},
    # ## 成本闸门：0 = 不限
    #
    # 模板值 100 会让整轮在 exceeded 处静默 `yield done; return`，
    # 被记成 no_patch —— **一个预算闸门伪装成能力问题**。所以必须占住它。
    # 顶层 costLimit 与 quota.costLimit 是两个互不影响的字段（config/schema.ts），
    # 只占一个另一个照样被塞 100。
    #
    # ⚠️ 顺带修了产品侧一个矛盾：校验器原来判 `<= 0` 为错，
    # 而运行时 `quota.ts` 判 `<= 0` 为不限、文档写的是 `≥0` ——
    # 于是"显式关掉闸门"这个正当配置每次启动都产出一条自己造的假红。
    # 现已改成只拒负数（见 schema.ts 那段注释）。
    "costLimit": float(os.environ.get("SC_COST_LIMIT", "0")),
    "quota": {"costLimit": float(os.environ.get("SC_COST_LIMIT", "0"))},
    # 推理档位：必控变量，由 SWE_EFFORT_LEVEL 给定并记进 run-meta。
    "effortLevel": os.environ.get("SC_EFFORT_LEVEL", "max"),
    # 轨迹：本地留存（要它来排查），上传关掉（容器无外网，传了只会白跑重试队列）。
    # outputDir 末级 = trajectories，取回后 SID_CODE_HOME 指过去即可跑 trace-digest。
    "trace": {"enabled": True, "outputDir": "/tmp/sid-traj/trajectories"},
}
json.dump(cfg, open(os.environ["SID_CONFIG_DIR"] + "/settings.json", "w"))
PYCFG
SCRIPT
  # 宿主变量注入（heredoc 已加引号，见上面 ⑤）。只有这两个是刻意要在宿主侧展开的：
  # MAX_TURNS 是必控变量、PERMISSION_FLAG 写死成布尔 flag（见文件头那段）。
  # 用 printf '%s' 而不是 echo：值里若含反斜杠，echo 在部分 shell 下会做转义解释。
  printf '/usr/local/bin/sid-code -p --max-turns %s %s -- "$(cat /tmp/prompt.txt)"\n' \
    "$MAX_TURNS" "$PERMISSION_FLAG"
}

build_extract_script() {
  cat <<'SCRIPT'
cd /testbed
# ## ⚠️ 先清掉进程崩溃残留物，再 git add
#
# 实测踩到（2026-08-25）：sid-code 在 qemu 下 SIGILL 崩溃，qemu 把 core dump
# 写在 cwd（`/testbed`）里 —— `core` 和 `qemu_sid-code_<ts>_<pid>.core`。
# `git add -A` 把它们收了进去，于是产出的「patch」是：
#
#   diff --git a/core b/core
#   new file mode 100644
#   Binary files /dev/null and b/core differ
#   diff --git a/qemu_sid-code_20260824-215830_15.core b/...core
#   Binary files /dev/null and b/...core differ
#
# `patch_bytes=326`、outcome=`patch_produced` —— **一次崩溃被记成「产出了 patch」**。
# 判分时它当然解不出题，于是最终落在 `wrong_patch`：
# **一个 harness 侧的崩溃被记成了模型改错了。**
#
# 所以清理不是「顺手做的整洁」，是**防止环境故障伪装成能力差**。
# 只删已知的崩溃残留模式，不做通配清理 —— 真删掉了 agent 的产出就成了反向错误。
rm -f core core.[0-9]* qemu_*.core vgcore.* 2>/dev/null || true
git add -A >/dev/null 2>&1 || true
echo '===NUMSTAT==='
# ## ⚠️ NUL 必须在容器内就转成 RS(\x1e)，否则记录分隔符会被 shell 吃掉
#
# 实测踩到（2026-08-25，复核 smoke-2 数据时）：外层拿输出用的是
# `extract_out="$(docker exec ...)"`，而**bash 命令替换会丢弃 NUL 字节**
# （POSIX 行为；bash 会打 warning，但被 2>&1 一起吞了）。
# 于是 `--numstat -z` 的多条记录在落盘时**首尾相接、没有任何分隔符**：
#
#   5<TAB>0<TAB>src/foo.py3<TAB>1<TAB>tests/test_foo.py2<TAB>0<TAB>src/bar.py
#
# 后果不是「少报几个文件名」而是**一道防作弊门禁被静默架空**：
# 按 NUL 切只得到 1 条记录，path 是把后面全部记录粘成的怪串，
# `isTestPath` 对它匹配不上 → **`patch_touches_tests` 恒为 false**。
# 实测同一份输入：NUL 完好判 true，NUL 丢失判 false。
# 全程 exit 0、字段自洽、报告挑不出毛病 —— 又一例「绿了但没测到」。
#
# ⛔ 不要改成不带 `-z` 来绕：那会把含空格/中文的路径 quote 成 "a\tb"，
# 按 TAB 切就切错了 —— `-z` 本来就是为此而用的。
# RS(\x1e) 能活过命令替换，且它不可能出现在 git 的路径里。
# （TS 侧 `parseNumstatZ` 两种分隔符都收，所以这一改不破旧数据。）
git --literal-pathspecs diff --cached --no-renames --numstat -z | tr '\0' '\036'
echo ''
echo '===DIFF==='
git --literal-pathspecs diff --cached --no-renames
SCRIPT
}

# ─────────────────────────────────────────────────────────────────────────────
# ③ 判分（§4.6：不自己判）
# ─────────────────────────────────────────────────────────────────────────────
cmd_grade() {
  need_docker
  local run_id="${1:?需要 run_id}"
  local out_dir="$SWE_DIR/runs/$run_id"
  local preds="$out_dir/predictions.jsonl"
  [[ -s "$preds" ]] || {
    bad "$preds 不存在或为空 —— 先跑 run"
    exit 1
  }
  info "官方 harness 判分: run_id=$run_id"
  # ⚠️ **同一 run_id 重跑会复用缓存**（§4.6）—— 换了 patch 必须换 run_id，
  # 否则读回的是上一次的结论，那是个假结果而不是重跑。
  set +e
  # ## 判分并发：`SWE_GRADE_JOBS`（默认 1）
  #
  # 判分与跑 agent 有一个关键区别：**它不碰模型网关，只跑测试**。
  # 所以并发在这里没有"限流风险"，也不改变任何一条 patch 的内容 ——
  # 判分是纯函数（同一份 predictions 判两次结论必须一样），
  # 因此**并发不影响可比性**，不像 SWE_JOBS 那样要记进 run-meta。
  #
  # 默认仍是 1：官方 harness 每条起一个容器跑完整测试套件，
  # 并发 N 份会同时吃 N 倍内存，OOM 的失败形态是那条被记成
  # `grader_error`（ZZZ.3 踩过一次工具链 bug 吃掉真实修复，同型）。
  # 内存够（>=16G 给 docker）时 `SWE_GRADE_JOBS=4` 是安全的提速。
  local grade_jobs="${SWE_GRADE_JOBS:-1}"
  if [[ ! "$grade_jobs" =~ ^[0-9]+$ ]] || ((grade_jobs < 1)); then
    bad "SWE_GRADE_JOBS 必须是 >=1 的整数（收到 '$grade_jobs'）"
    exit 1
  fi
  # 同上：`${grade_jobs}` 带花括号，否则全角括号被吃进变量名
  ((grade_jobs > 1)) && info "判分并发 -j ${grade_jobs}（判分是纯函数，不影响可比性；但吃 N 倍内存）"
  # ## ⚠️ 判分也必须 HF 离线，否则卡死在 SYN_SENT
  #
  # `HF_HUB_OFFLINE=1` 原先只加在取题面那一处（run_one 里的 fetch-instance.py），
  # 判分这条 `$SWEBENCH eval` 没有 —— 于是 harness 去打 HuggingFace 拿 dataset，
  # 而 dataset **本地早就缓存好了**（~/.cache/huggingface/datasets/SWE-bench___swe-bench_verified）。
  # 实测（smoke-9）：25 分钟零输出、零 eval 容器，`lsof` 显示进程停在
  # `TCP …->104.244.43.229:https (SYN_SENT)`。加上这两个变量后 8 分钟跑完。
  #
  # ⚠️ 用 `${VAR:-1}` 而不是硬编码 1：留一个逃生舱给"确实需要更新 dataset"的场合
  # （`HF_HUB_OFFLINE=0 ./exec-swebench.sh grade …`），否则下一个人会直接删掉这两行。
  #
  # ## 输出走 tee 而不是裸 `| tail -30`
  #
  # 上面那个故障之所以难归因，是 `| tail -30` 在 buffer 满之前**一个字都不出来** ——
  # 于是"卡在网络"看起来像"判分很慢"。tee 到文件后，卡住时可以另开一个终端 tail 那个文件，
  # 立刻看得出它停在哪一步。终端仍只显示末 30 行（判分正常输出很长，全刷屏没意义）。
  local grade_log="$out_dir/grade.log"
  # `${grade_log}` 带花括号：裸 $VAR 后紧跟全角括号会被吞进变量名（set -u 下直接退出）。
  # 门禁 tests/scripts/shell-fullwidth-var.test.ts 刚拦下这一行 —— 写的时候又踩了第四次。
  info "判分日志: ${grade_log}（卡住时可另开终端 tail 它）"
  HF_HUB_OFFLINE="${HF_HUB_OFFLINE:-1}" HF_DATASETS_OFFLINE="${HF_DATASETS_OFFLINE:-1}" \
    "$SWEBENCH" eval verified -p "$preds" --run-id "$run_id" -j "$grade_jobs" \
    --report-dir "$out_dir" --timeout "$TIMEOUT_SEC" 2>&1 | tee "$grade_log" | tail -30
  set -e
  # 映射成验收字段 —— report 缺失时 grade.ts 会 exit 3 而**不是**报 0 分
  bun run "$SWE_DIR/grade.ts" --run-id "$run_id" --report-only
}

case "${1:-}" in
gold)
  shift
  cmd_gold "$@"
  ;;
run)
  shift
  cmd_run "$@"
  ;;
grade)
  shift
  cmd_grade "$@"
  ;;
*)
  sed -n '1,40p' "${BASH_SOURCE[0]}" | grep -E '^#' | sed 's/^# \{0,1\}//'
  exit 2
  ;;
esac
