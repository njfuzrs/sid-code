/**
 * S（修复方案 §7.3）：goal 轮次上限在 tool_use 空转下**每轮**生效。
 *
 * 期望来源：修复方案 §4.1 / §7.3（2026-11-16）——
 * 「maxTurns 在每轮 AfterModel 之后检查，而不是只在 end_turn 的 Goal Gate 里检查」。
 * 真实轨迹里零样本（本机 1202 个会话中 `turns_limited` 0 条，且 G1 当天才合入），
 * 所以期望按方案要求写，**不从实现反推**。
 *
 * 场景：`/goal set` + `/goal turns 2` 后让模型连续两个 tool_use（各写一个新文件），
 * 第 2 轮 AfterModel 后 `turnsUsed=2 >= maxTurns` → 拒绝第 3 轮工作请求 → 强制总结。
 * 第 3 条 replay 响应是「第 3 轮工作若被放行就会写进去」的毒丸：它会被总结轮消费
 * 但不会执行工具，所以 `step3.txt` 必须不存在。
 *
 * 为什么每轮写新文件而不是覆盖同一个：`write` 对已存在文件要求先 `read`（write.ts 的
 * 前置约束），覆盖写法会在第 2 轮被工具自己的守卫拦掉，测到的就不是 goal 上限了。
 *
 * 为什么走 stream-json：`/goal` 声明了 `headless: true`，三种无头形态都放行。
 *
 * ⚠️ **不能用 `/goal turns 2` 单独设上限**：`/goal set` 返回的是 `submit_prompt`
 * （`goal.ts` 的 `doSetGoal`），它会**立即启动一轮执行**，第 2 条输入要等这轮跑完
 * 才轮到。所以轮次上限必须走 settings 的 `goal.defaultMaxTurns` 在建立目标时生效，
 * `streamInput` 只发一条 `/goal set`。首版用例按「先 set 再 turns」写，实测 goal
 * 以默认 300 轮跑满 replay、gate 一直推回，60s 超时被 kill（exit=137）。
 */
import type { SmokeCase } from "../../lib/types.ts";

const def: SmokeCase = {
  id: "S-goal-turn-limit",
  ledger: "S",
  feature: "goal 轮次上限每轮生效（tool_use 空转也拦）",
  kind: "guard",
  repo: {},
  argv: [],
  // settings 是整体替换（runner 的 `def.settings(...)` 不再与默认值合并），必须手动展开
  settings: ({ defaults }) => ({
    ...defaults,
    goal: { defaultMaxTurns: 2 },
  }),
  streamInput: ["/goal set 完成迁移工作"],
  expect: {
    exitCode: 0,
    events: [
      // 归因恰好一条，且口径是 turns_limited（不是 budget 族）
      { event: "GoalGateDecision", where: { reason: "turns_limited" }, count: 1 },
      // 方案 §7.3 要求 `TurnComplete` 上也带归因（`goal_limit_exceeded.source`），
      // 供离线统计直接按事件分桶；此前只有单测锁字段，真实二进制落盘没人验过。
      { event: "TurnComplete", where: { "goal_limit_exceeded.source": "turns" }, count: 1 },
      // 总模型调用数 = 2 轮工作 + 1 轮强制总结。锁住「第 3 轮工作请求没有发出去」：
      // 多一次就说明拦在了工具执行之后而不是请求之前。
      { event: "BeforeModel", count: 3 },
    ],
    files: [
      // 前两轮的工具照常执行
      { path: "step2.txt", equals: "2" },
      // 第 3 轮的工作请求被拦下：毒丸没有落盘
      { path: "step3.txt", absent: true },
    ],
  },
  mutations: [
    {
      file: "packages/core/src/query/loop.ts",
      find: "      if (state.goalLimitExit && !hasPendingToolUse) {",
      replace: "      if (false && state.goalLimitExit && !hasPendingToolUse) {",
      why: "轮次上限命中后不在循环顶部退出：第 3 轮工作请求照发，毒丸落盘（step.txt 变成 SHOULD_NOT_RUN）",
    },
    {
      file: "packages/core/src/goal/limits.ts",
      find: "  if (goal.turnsUsed >= goal.maxTurns) {",
      replace: "  if (false) {",
      why: "每轮硬约束不再认轮次上限（退回「只在 end_turn 的 Goal Gate 里检查」旧行为）：tool_use 轮一次都不会触发",
    },
  ],
};

export default def;
