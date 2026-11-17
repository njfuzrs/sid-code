---
Status: implemented
Date: 2026-11-17
Source: goal 轮次终态与等待脚本-二次确认排查（2026-11-17）
---
# goal 终态要可见且 resume 不得假成功；等待脚本正文按各自 cd 前缀解析

## 决定了什么

一批修三处缺陷（同一份排查文档的 A/B/C），它们都属于「静默失效」：用户与模型都
得不到任何反馈，只能从轨迹里事后发现。

**A1 `/goal resume` 的终态守卫**（`packages/cli/src/command/commands/goal/goal.ts`）：
`turns_limited` / `budget_limited` 时不再把 `status` 改回 `active`，而是返回可执行指令
（`/goal turns` / `/goal budget` / `/goal clear`）。判据是**约束是否仍然成立**
（`turnsUsed >= maxTurns`、`tokensUsed >= tokenBudget`），不是只看 status ——
用户先放宽上限后 resume 必须放行，那条路才是真正的出路。

**A4 状态栏终态可见**（`packages/cli/src/ui/hooks/useStatusLineData.ts`）：
`deriveGoal` 对 `turns_limited` / `budget_limited` 输出 `⚠ 目标已终止（轮次 N/M）` /
`⚠ 目标已终止（Token 预算）`，颜色走 `theme.status.warning`，字形取 `figures.ts` 的
`WARNING_MARK`。此前这两个状态与 `complete` 一起落到 `null`，目标从屏幕上凭空消失。

**B1 等待脚本的 cd 感知**（`packages/core/src/task/wait-subjects.ts`）：
新增 `scriptPathsWithBaseDirs`，按子命令逐段跟踪 `cd <dir>`，每个脚本路径用**它自己那段
的基准目录**解析。解析不出目录的形态（`cd -` / `cd "$DIR"` / 反引号）不猜，退回调用方
给的 cwd（与文档 §4.5 B-1 口径一致）；`cd` 到不存在的目录自然读不到，不报错。

**C1/C2 trace 口径**（`packages/core/src/query/goal-waiting.ts` + `goal-gate.ts`）：
`WaitSuspendDecision` 增加 `exhausted` / `notificationOnly` 两个判别位；
到顶那一轮补发 `waiting_exhausted` 事件（带 `wait_ids` / `wait_pass_count`），
纯通知放行的 `waiting` 事件带 `wait_kind: "notification"`。

## 放弃了什么（以及为什么不选）

- **A2「恢复会话时把 `*_limited` 也排除在 goal 状态之外」**：不选。排除确实能消掉
  「载入了一个不评估的目标」这条路径，但代价是用户连 `/goal status` 都查不到它了——
  从「静默僵尸」变成「凭空消失」，同样是不可解释的状态。A4 让它可见 + A1 给出口，
  两条加起来才闭合，不需要牺牲可查性。
- **A5「`setMaxTurns` 放宽后自动把 status 改回 active」**：不选。那会让
  `/goal turns` 变成一条**隐式 resume**，而「放宽约束」与「继续执行」是两件事：
  用户可能只想调高上限留到下次 `/goal resume`。显式两步（放宽 → resume）比隐式跳转
  更容易解释，也让 resume 的语义保持单一。
- **B2「`normalizeWaitCommand` 保留 cd 目录」**：不选。它改的是 P4 去重判据的
  归一化口径，副作用是把 `bash /tmp/x.sh` 与 `cd /tmp && bash /tmp/x.sh` 判成两件事，
  duplicate 判据整体变松。B1 只动 `readWaitScriptBodies` 一个函数，语义更正、
  影响面更小（文档 §4.5 也这么推荐）。
- **B3「读不到正文时给 `scriptHash` 设第三种状态」**：不选。`undefined` 已经表达
  「无脚本」，再加一态会让 `comparableScript` 的分支成倍增长；本次只修「读错目录」，
  读不到（文件真不存在）维持现有退化行为。
- **A6 / A7（终态系统消息、状态栏显示恢复代价）**：不选。作用在状态栏已经能显示
  终态之后，属于重复提示；按 L4-C「教过一次就别唠叨」，先不做。

## 拿什么证明它生效了

（命令与输出见 PR 正文；这里只记判据与变异自证结论）

- **变异自证**（新增断言必须能红）：
  - 去掉 `resumeGoal` 的两个终态守卫 → `goal-resume-terminal-guard.test.ts` 的
    「轮次耗尽 → 拒绝」与「预算耗尽 → 拒绝」两条变红；
  - `deriveGoal` 的终态分支改为 `if (false)` → `status-line-data.test.ts` 的 A4 四条变红；
  - `scriptPathsWithBaseDirs` 里 `baseDir` 恒等于 `cwd` → `wait-subjects.test.ts` 的
    B1「cd 绝对路径」「多级 cd」「两段脚本各自基准」与 `wait-admission.test.ts` 的
    「两个 cd 目录下的同名脚本 → replace」全部变红；
  - `exhausted` 恒 `false` → `goal-gate.test.ts` 的 C1 变红；去掉 `wait_kind` 分支 →
    C2 变红。
- **单测**：`bun test` 六组相关文件全绿（123 + 18 用例）。
- **B1 的夹具刻意在启动目录放一份同名 `wait.sh`**（正文指向 PR 111），修复前读到的
  就是它 —— 只测「cd 目录有、启动目录无」的话修复前后都是「读不到」，用例恒绿，
  等于没测。
