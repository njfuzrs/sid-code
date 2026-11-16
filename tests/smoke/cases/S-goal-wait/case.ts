/**
 * S（修复方案 §7.3）：模型挂上显式等待源后 end_turn，Goal Gate 判「在等」而不是调评估器。
 *
 * 期望来源：修复方案 §4.2 / §7.3（2026-11-16）——
 * 「有显式外部等待（monitor / wakeup / 带 wait_until 的后台 shell）时放行 end_turn，
 * 不调评估器、goal 保持 active、给出用户可见回执」。
 * 真实轨迹零样本（本机 1202 个会话里 `wait_ids` 0 条、`reason:"waiting"` 0 条），
 * 所以期望按方案要求写，**不从实现反推**。
 *
 * 场景：`/goal set` 后模型挂一个 monitor（模拟等 CI），下一轮 end_turn。
 * 第 2 轮 `turnsUsed=2 >= minTurnsBeforeEval` → 进入等待判据 →
 * 放行并落 `GoalGateDecision{reason:"waiting"}`，评估器**一次都不该被调用**。
 *
 * 判据用「`reason:"continue"` 0 条」来守「没调评估器」：评估器跑完必然落一条
 * continue / satisfied / impossible；三条都没有 = 根本没评估（比断言轮数更直接）。
 *
 * ⚠️ 为什么是 `-p` 单轮而不是 `streamInput`：
 * 等待放行后 monitor 到终态会触发**通知续跑**，续跑那轮会多产生一条 `result`，
 * 与运行器「stream-json 输入数 === result 数」的断言直接冲突（实测 1 条输入 → 2 条
 * result）。`-p` 单轮不看 result 条数，只断言事件与退出码。
 * 而 `/goal set` 返回的是 `submit_prompt`（`goal.ts` 的 `doSetGoal`），会**立即启动
 * 一轮执行**，所以一条 `-p` prompt 就够了，不需要第二条输入。
 *
 * ⚠️ `timeoutMs` 必须放宽：用例里挂的是真实的 monitor 后台任务，进程要等它的终态
 * 走完才退出。与 N4-quiescent-declared-wait 同一形态，它同样用 `timeoutMs: 150_000`。
 */
import type { SmokeCase } from "../../lib/types.ts";

const def: SmokeCase = {
  id: "S-goal-wait",
  ledger: "S",
  feature: "goal 等待态放行 end_turn（有显式等待源时不调评估器）",
  kind: "guard",
  repo: {},
  // `-p` 的 prompt 以 `/` 开头会被 headless 命令分发识别为 /goal（goal/index.ts 声明了
  // `headless: true`），`/goal set` 返回 submit_prompt 直接启动执行。
  argv: ["-p", "/goal set 完成迁移工作"],
  timeoutMs: 150_000,
  // settings 整体替换（runner 的 `def.settings(...)` 不再与默认值合并），必须手动展开。
  // maxTurns=3 是给「通知续跑」留的出口：等待放行后 monitor 到终态会触发一轮续跑，
  // 若那一轮 goal 仍 active 且没有等待源，gate 会继续推回 → replay 耗尽 → 空响应重试，
  // 实测卡到超时（日志里是「后台任务已返回，继续处理 → 目标未达成，继续推进」循环）。
  // 让续跑轮（turnsUsed=3）直接撞 turns_limited 收尾，进程才能退出。
  settings: ({ defaults }) => ({
    ...defaults,
    goal: { defaultMaxTurns: 3 },
  }),
  expect: {
    exitCode: 0,
    events: [
      // 判「在等」：恰好一条 waiting，且 goal 保持 active（没有 satisfied / impossible）
      { event: "GoalGateDecision", where: { reason: "waiting" }, count: 1 },
      // 评估器没被调用：它的结论一条都不该出现
      { event: "GoalGateDecision", where: { reason: "continue" }, count: 0 },
      { event: "GoalGateDecision", where: { reason: "satisfied" }, count: 0 },
    ],
  },
  mutations: [
    {
      file: "packages/core/src/query/goal-gate.ts",
      find: "  if (waitSuspend.release) {",
      replace: "  if (false && waitSuspend.release) {",
      why: "等待判据失效：挂上 monitor 后 end_turn 仍去调评估器，把模型打回下一轮空转（G2 要修的原缺陷）",
    },
  ],
};

export default def;
