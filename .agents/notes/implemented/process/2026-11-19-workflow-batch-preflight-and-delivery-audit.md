---
Status: implemented
Date: 2026-11-19
Source: 批量并行编排两处静默失败（2026-11-19）
---
# 批量编排补两道确定性闸门：worktree 前置检查 + 交付审计

## 决定了什么

新增两个只读仓库脚本，并在 `package.json` 暴露入口：

- `scripts/worktree-batch-preflight.ts`（`bun run worktree:preflight`）：扫 `packages/` 下各包的
  `package.json` 里所有 `workspace:` 依赖，判它们能否解析。默认查主仓 `<root>/node_modules/<dep>`；
  `--worktree <path>` 查 `<wt>/packages/<声明者>/node_modules/<dep>` 或 `<wt>/node_modules/<dep>`，
  且 `<wt>/node_modules` 整体不存在时只报一条「未安装依赖」。退出码 0 通过 / 1 缺依赖 / 2 参数错误。
- `scripts/workflow-delivery-audit.ts`（`bun run workflow:audit`）：扫 `.sid-code/worktrees/wf_*`，
  每个单元给出 commits / dirty 两个数与 verdict（committed / uncommitted / empty / unknown），
  表后按 verdict 给补救命令；`--export-dir` 对 uncommitted 的 worktree 先 `git add -A` 再
  `git diff --binary HEAD` 导出 patch。退出码 0 全 committed 或无 wf_* / 1 有 uncommitted 或 unknown / 2 参数错误。
- 两个脚本都只读 git / fs，**不写 `~/.sid-code/`**、不自动修（修复命令打在输出里）。
- 两个纯函数导出 `preflight()` / `auditWorktree()` / `exportPatch()`，`main` 只做参数解析与打印。

判据的关键取舍：**「能解析」用 `existsSync`（跟随 symlink），不是 `lstat`**。悬空 symlink 时
lstat 看得见、模块解析照样失败，这正是 2026-11-19 那一类「看起来装好了」的现场。

## 放弃了什么（以及为什么不选）

- **没让 preflight 自动修复**（自动跑 `ln -sfn` / `bun install`）：缺链接的正确修法取决于现场
  （补一条链接 vs 主仓整体重装），脚本替人选一种会在错误前提下改坏可用环境。改成把命令打到输出里。
- **没做成 pre-commit / CI 门禁**：这两个是批量编排过程中的自查工具，不是每次提交都要付的代价。
  preflight 在主仓跑一次约几十毫秒，但把它挂进 CI 需要判断「缺链接」在干净 CI 环境下恒不成立，
  收益不足；交给编排方在开工前显式跑。
- **`--export-dir` 没有默认开启**：导出需要 `git add -A`，是**会改状态**的动作（把工作区改动挪进 index）。
  只读审计与救援动作分开，避免「只想看看」的人意外改变 worktree 状态。
- **verdict 里 committed 优先于 uncommitted**：既提交又有未提交改动时，committed 的补救路径
  （merge/cherry-pick）覆盖不了剩下的未提交部分，所以报告里额外打印「另有 N 处未提交改动，也要导出」，
  而不是新增一个第四态——多一个状态就多一处调用方要处理。
- **判定「空集 = 通过」被否决**：`packages/` 不存在时 preflight 判**不通过**（不是「0 个依赖全通过」）。
  空集冒充通过是这类脚本最常见的恒绿形态。

## 拿什么证明它生效了

- `bun test ./tests/scripts/worktree-batch-preflight.test.ts ./tests/scripts/workflow-delivery-audit.test.ts`
  → **31 pass / 0 fail**（90 个 expect）。B2 的用例在 tmpdir 里用真实 `git init` + `git worktree add` 跑真实 git 命令。
- 实跑：`bun run worktree:preflight` → `✓ 前置检查通过：5 个 workspace 依赖均可解析`，exit 0；
  `bun run worktree:preflight --worktree .` 同样通过；`bun run workflow:audit --base origin/main`
  → 本 worktree 下没有 `.sid-code/worktrees`，输出「无需审计」，exit 0。
- 变异自证三处（每处都是改坏 → 断言变红 → 改回 → 重跑绿）：
  1. `existsSync` → `lstatSync`（主仓模式）：悬空 symlink 用例变红
     `Expected: false / Received: true`（脚本报 ok=true，即悬空链接被当成可解析）；恢复后 16 pass。
  2. `verdict` 恒为 `"committed"`：用例「只改工作区文件（不 add）→ uncommitted」变红
     `Expected: "uncommitted" / Received: "committed"`；「空 worktree → empty」也红；恢复后 15 pass。
  3. `exportPatch` 去掉 `git add -A`：untracked 用例变红 `Expected: > 0 / Received: 0`
     —— 导出字节数为 0，复现的正是「只 diff 工作区漏掉新建文件」；恢复后 31 pass。
