/**
 * P1-intervened-true：等待期状态查询守卫**真的拦住**时，`UnchangedObservationRun.intervened`
 * 要如实记 true。
 *
 * ## 为什么必须造数据
 *
 * `intervened` 需要两件事同时成立：① 同工具同参的返回值连续 3 次完全相同；
 * ② 触发阈值的那次调用恰好被 P1 拦截。真实轨迹里 24 次 `UnchangedObservationRun`
 * 全部 `intervened=false`（2026-11-13 统计）—— 日常使用中模型不会自发连续 5 次
 * 调同一条查询，这个样本等不到。所以用回放把这条链固定下来，而不是继续等真实流量。
 *
 * ## 构造方式（同一序列已在 G1 层用生产代码复算过）
 *
 * 回放固定 5 次同命令调用：
 * `gh pr checks 1 --repo '///' 2>/dev/null || echo "no checks"`。
 * 两处细节都是必需的（第一版各踩了一次）：
 * - `--repo '///'` 让 gh 在**本地参数校验**阶段失败，不联网、不依赖 PR 状态；
 * - `|| echo "no checks"` 让整条命令 **exit 0**：`recordStatusQueryResult` 只在
 *   `!result.isError` 时记录（`tool-executor.ts` 的 P1 记忆分支），命令失败则 memo
 *   永远没有 entry，P1 一次都不会拦（首版实测 `UnchangedObservationRun.intervened=false`）。
 *
 * 等待源用后台 `sleep 20` + `wait_until_seconds=60` 造（N4 同款）：`schedule_wakeup`
 * 是长尾工具，回放里不先 tool_search 激活就调不到，而 P1 判据 1 只要求
 * 「有显式声明的等待源」，`isDeclaredExternalWait` 认 `shell + deadline`。
 * 用 `sleep 20` 而不是无限循环：CLI 在 end_turn 后会等后台任务结束，
 * 无限循环会撑到 `wait_until_seconds` 的 60s 上限（首版实测 exit=137 超时）。
 * - 第 1、2 次真实执行（输出 O）→ memo `sameRun` 到 2；
 * - 第 3 次起 P1 拦截（回执 R；被拦不更新 memo，所以 R 恒定）；
 * - `observeToolResult` 看到的序列是 O,O,R,R,R → 第 5 次 `run=3` 触发埋点，
 *   且该次被拦截 → `intervened=true`。
 *
 * 等待源用后台 bash + `wait_until_seconds` 造（N4 同款）：`schedule_wakeup` 是长尾工具，
 * 回放里不先 tool_search 激活就调不到，而 P1 判据 1 只要求「有显式声明的等待源」，
 * shell deadline 同样满足。
 *
 * 判据：`UnchangedObservationRun` 里 `intervened: true` 恰好 1 条；两条前置断言
 * （等待源真的登记、真的拦了 ≥3 次）缺一不可，否则这个 true 没有意义。
 */
import type { SmokeCase } from "../../lib/types.ts";

const def: SmokeCase = {
  id: "P1-intervened-true",
  ledger: "P1",
  feature: "等待期状态查询守卫：intervened 真实置位",
  kind: "guard",
  repo: { "README.md": "P1：守卫真的拦住时 intervened 记 true\n" },
  argv: ["-p", "帮我盯着这个 CI，结果出来了告诉我"],
  timeoutMs: 90_000,
  expect: {
    events: [
      // 前置 1：等待源真的登记上了（P1 判据 1 的前提；没有它一次都不会拦）
      { event: "WaitRegistered", where: { kind: "shell" }, count: 1 },
      // 前置 2：第 3、4、5 次调用真的被拦（3 次）
      {
        event: "BackgroundPollIntercepted",
        where: { kind: "external_status_poll" },
        count: ">=3",
      },
      // 本用例的判据：触发阈值的那次被拦 → intervened 记 true
      { event: "UnchangedObservationRun", where: { intervened: true }, count: 1 },
    ],
  },
  mutations: [
    {
      file: "packages/core/src/query/tool-executor.ts",
      find: "    markStatusPollIntervened(block.id);\n",
      replace: "",
      why: "拦截不再按 block 标记 → UnchangedObservationRun.intervened 恒 false",
    },
  ],
};

export default def;
