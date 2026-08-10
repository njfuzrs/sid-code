#!/bin/sh
# pre-commit hook —— B6-10 数据污染防护 + B7-7 SKILL holdout 回归护栏 + P1-4 lint 门禁
#
# 行为：
#   1. 扫 staged 的 evals/real-tasks/**.yaml 是否含 §9.1.1 黑名单关键词
#      （tool_result_content / response_content / patch_content / observation_content / completion_text）
#      命中即 reject commit（B6-10）
#   2. 扫 staged 的 SKILL.md（src/skill/builtin/**/SKILL.md 或 .sid-code/skills/**/*.md）
#      调用 holdout 回归扫描器：holdout 暂无 execution case → INFO skip；有则提示应跑回归
#      （B7-7 §13.4.4 蒸馏护栏 2，holdout case 入库后会自动激活）
#   3. oxlint 检查 staged 的 .ts/.tsx（P1-4）
#
# 安装：
#   bun run install-hooks
# 或手动：
#   cp scripts/git-hooks/pre-commit.sh .git/hooks/pre-commit && chmod +x .git/hooks/pre-commit
#
# 跳过单次（不推荐，仅在确认误报时用）：
#   git commit --no-verify

set -e

REPO_ROOT=$(git rev-parse --show-toplevel)

# ============================================================================
# B6-10: real-tasks yaml 污染扫描
# ============================================================================
STAGED_REAL_TASKS=$(git diff --cached --name-only --diff-filter=ACM | grep -E '^evals/real-tasks/.*\.ya?ml$' || true)

if [ -n "$STAGED_REAL_TASKS" ]; then
  echo "[pre-commit] B6-10 扫描 staged real-tasks yaml ($(echo "$STAGED_REAL_TASKS" | wc -l | tr -d ' ') 个文件)..."

  ABS_FILES=""
  for f in $STAGED_REAL_TASKS; do
    ABS_FILES="$ABS_FILES $REPO_ROOT/$f"
  done

  # shellcheck disable=SC2086
  if ! bun run "$REPO_ROOT/scripts/eval/check-real-tasks-pollution.ts" $ABS_FILES; then
    echo "[pre-commit] ❌ B6-10 数据污染扫描失败，commit 中止"
    echo "             如确认误报，可加 --no-verify 跳过单次（不建议）"
    exit 1
  fi
fi

# ============================================================================
# T-3.8: 参考页反漂移门禁（官网方案 §4.5.2 机制一）
#
# 改了参考页的 6 个数据源之一（help.ts / tool/ / command/ / config/ / hook/），
# 就必须重新生成 website/ref/ 下的参考页。不一致则**阻止提交**。
#
# 这道门禁的保证是：源码改了但文档没跟着改，物理上进不了仓库。
# 参考表一旦漂移就是骗人——用户照着文档写了一个不存在的参数，比没有文档更糟。
#
# 注意只在数据源变动时才跑：--check 要起一次 bun 进程 dump 工具定义（约 1s），
# 每次提交都跑会让无关提交也变慢，久了就会被 --no-verify 绕过。
# ============================================================================
STAGED_REF_SOURCES=$(git diff --cached --name-only --diff-filter=ACMR | grep -E '^src/(help\.ts|cli\.ts|tool/|command/|config/|hook/)' || true)
STAGED_REF_PAGES=$(git diff --cached --name-only --diff-filter=ACMRD | grep -E '^website/(ref/|public/llms\.txt)' || true)

if [ -n "$STAGED_REF_SOURCES" ] || [ -n "$STAGED_REF_PAGES" ]; then
  echo "[pre-commit] T-3.8 参考页与源码对账（改动涉及参考页数据源）..."
  if ! bun run "$REPO_ROOT/scripts/docs-gen-reference.ts" --check; then
    echo "[pre-commit] ❌ 参考页与源码不一致，commit 中止"
    echo "             修复：bun run docs:gen-reference && git add website/ref website/public/llms.txt"
    echo "             如确认误报，可加 --no-verify 跳过单次（不建议）"
    exit 1
  fi
fi

# ============================================================================
# 叙述覆盖度门禁：新增命令不能只进 ref/ 参考表
#
# 上面 T-3.8 保证的是「参考页不漂移」，但参考页是脚本生成的——新增一个命令，
# ref/slash-commands.md 会自动多一行，指南页却不会自动变。结果是功能"进了字典，
# 没进教程"：用户不会读一张 60 行的表来发现能力。2026-07 覆盖度核对实测
# 62 个命令里 21 个处于这个状态（详见 docs/reference/官网文档覆盖度核对报告.md）。
#
# 触发条件复用命令注册表相关改动（src/command/），与 T-3.8 同源，不额外拖慢无关提交。
#
# ⚠ 当前是**告警模式**（--coverage，恒退 0），因为存量 18 个未清完；
#    存量清零后把下面的 --coverage 改成 --coverage-strict 并去掉 `|| true`，
#    "做了功能不写文档"就在物理上进不了仓库。
# ============================================================================
STAGED_CMD_SOURCES=$(git diff --cached --name-only --diff-filter=ACMR | grep -E '^src/command/' || true)
STAGED_GUIDE_PAGES=$(git diff --cached --name-only --diff-filter=ACMRD | grep -E '^website/(start|use|extend|team)/' || true)

if [ -n "$STAGED_CMD_SOURCES" ] || [ -n "$STAGED_GUIDE_PAGES" ]; then
  echo "[pre-commit] 叙述覆盖度检查（命令是否只存在于 ref/ 参考表）..."
  bun run "$REPO_ROOT/scripts/docs-gen-reference.ts" --coverage || true
fi

# ============================================================================
# 源码裸 NUL 字节门禁（负收益防线审计 发现 6，2026-07-30）
#
# 为什么这值得一道 pre-commit 门禁：源码里出现**裸 NUL 字节（0x00）**会让 grep 把
# 整个文件判为二进制而**静默跳过**——不是"漏掉 NUL 之后的部分"，是全文件所有符号都
# 搜不到，且 exit=1 与"真的没有匹配"不可区分。实测 repeated-readonly-guard.ts 就因
# 一个用作复合键分隔符的裸 `\0` 对 grep 完全失明，而它是唯一默认开启且能强制收尾的
# 止损阀——审计开局差点因此写出"16 条死防线"的假结论。
#
# 合法需求（拿控制字符做键分隔符）用**转义写法**满足即可：`"\x1f"`（US，单元分隔符）
# 运行时等价，源码字节不含控制字符。故本门禁只拦裸字节，不限制语义。
#
# 刻意只查 NUL(0x00)，不查其它控制字符：run-statusline.ts 里的 SOH(0x01) 实测对
# grep 无影响，扩大到全部控制字符只会制造无收益的误报。
# ============================================================================
STAGED_SOURCES=$(git diff --cached --name-only --diff-filter=ACMR \
  | grep -E '\.(ts|tsx|js|jsx|mjs|cjs|sh|json|md)$' \
  | grep -v -E '^(vendor/|src/ink/_vendor/)' || true)

if [ -n "$STAGED_SOURCES" ]; then
  NUL_HITS=""
  for f in $STAGED_SOURCES; do
    # 读 staged 内容（而非工作区）——门禁必须校验真正要进仓库的字节。
    #
    # 检测手段刻意用 `tr -d` 前后字节数差，而不是 `grep`：
    #   - `grep -q "$(printf '\000')"` 是**陷阱**——shell 的命令替换会剥掉 NUL，模式退化成
    #     空串，于是它匹配所有干净文件、漏掉真含 NUL 的文件（判定完全反转，已实测）。
    #   - grep 本身对二进制文件的行为又正是本门禁要防的东西，用它自查等于用坏尺子量尺子。
    # tr 逐字节删除、wc -c 数字节，两者都不受 NUL / locale 影响。
    _staged_bytes=$(git show ":$f" 2>/dev/null | wc -c | tr -d ' ')
    _stripped_bytes=$(git show ":$f" 2>/dev/null | LC_ALL=C tr -d '\000' | wc -c | tr -d ' ')
    if [ -n "$_staged_bytes" ] && [ "$_staged_bytes" != "$_stripped_bytes" ]; then
      NUL_HITS="$NUL_HITS $f"
    fi
  done

  if [ -n "$NUL_HITS" ]; then
    echo "[pre-commit] ❌ 检测到源码含裸 NUL 字节（0x00），commit 中止："
    for f in $NUL_HITS; do echo "               - $f"; done
    # 下面几行必须用 `printf '%s\n'` + 单引号，不能用 echo：/bin/sh（dash）的 echo 会
    # **解释** \xNN 转义，把提示文案里的 \x1f / \x00 就地变成真的控制字节输出——一道防
    # 控制字节的门禁自己吐控制字节，荒谬且会污染终端。
    printf '%s\n' "             后果：grep 会把整个文件当二进制静默跳过，全文件符号都搜不到"
    printf '%s\n' "                   （exit=1 与'真的没匹配'不可区分，排查时极易误判成死代码）。"
    printf '%s\n' '             修复：把字符串里的裸控制字节改成转义写法，如 \x1f（US，单元分隔符）'
    printf '%s\n' "                   —— 运行时等价，源码字节干净。参考 src/query/repeated-readonly-guard.ts"
    printf '%s\n' '                   的 makeSignature。定位：perl -ne '"'"'print "line $.\n" if /\x00/'"'"' <文件>'
    echo "             如确认误报，可加 --no-verify 跳过单次（不建议）"
    exit 1
  fi
fi

# ============================================================================
# B7-7: SKILL.md 改动 → 提示 holdout execution 回归（§13.4.4 v1.3 蒸馏护栏 2）
# ============================================================================
STAGED_SKILLS=$(git diff --cached --name-only --diff-filter=ACM | grep -E '(^src/skill/builtin/.*/SKILL\.md$|^.*\.sid-code/skills/.*\.md$)' || true)

if [ -n "$STAGED_SKILLS" ]; then
  ABS_FILES=""
  for f in $STAGED_SKILLS; do
    ABS_FILES="$ABS_FILES $REPO_ROOT/$f"
  done

  # shellcheck disable=SC2086
  bun run "$REPO_ROOT/scripts/eval/check-skill-holdout-regression.ts" $ABS_FILES
fi

# ============================================================================
# P1-4: oxlint（只对 staged 的 .ts/.tsx 跑，全仓也就 65ms，但限定 staged
# 更能精确定位是本次改动引入的问题，而不是让人对着一堆存量报错发懵）
#
# .oxlintrc.json 的 ignorePatterns 对显式传入的文件同样生效（已实测），
# 所以直接把 staged 路径喂给 oxlint 不会漏用 src/ink/ 等排除规则。
# ============================================================================
STAGED_TS=$(git diff --cached --name-only --diff-filter=ACM | grep -E '\.(ts|tsx)$' || true)

if [ -n "$STAGED_TS" ]; then
  echo "[pre-commit] oxlint 检查 staged 文件 ($(echo "$STAGED_TS" | wc -l | tr -d ' ') 个)..."

  ABS_FILES=""
  for f in $STAGED_TS; do
    ABS_FILES="$ABS_FILES $REPO_ROOT/$f"
  done

  # shellcheck disable=SC2086
  if ! (cd "$REPO_ROOT" && ./node_modules/.bin/oxlint $ABS_FILES); then
    echo "[pre-commit] ❌ oxlint 检查失败，commit 中止"
    echo "             如确认误报，可加 --no-verify 跳过单次（不建议）"
    exit 1
  fi
fi

exit 0
