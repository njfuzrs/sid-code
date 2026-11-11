/**
 * N4 声明的等待不该收到「已静默、不会再自动回报」（事故 20261109-191904-962011a6）。
 *
 * 事故形状（真实轨迹，人工核过）：
 * - 11:47:53 模型起 `gh pr checks 701 --watch 2>&1 | tail -30`，带 `wait_until_seconds=1800`，
 *   回执明说「期间不按静默判定，到期仍在跑会被终止并以通知告知（不需要你轮询）」；
 * - 11:48:29 end_turn（做对了）；
 * - 11:48:29 / 85s / 220s 三次收到 `<task-notification>`「仍在运行，但已 Ns 没有新输出，
 *   不会再自动回报」；
 * - 模型每次收到都去前台查一次，11:49:32–11:53:33 连查 32 次（8.45M 输入 token）。
 *
 * 根因不是「通知写错了」，而是两套口径打架：`isAwaitedBackgroundTask` 判它「值得等」
 * （憋输出 / 有期限，退出或到期必有通知），`takeQuiescentWake` 却只看静默时长。
 *
 * 判据（来自真实轨迹的反面）：**会话里不得出现那句静默文案**。
 * `describeQuiescentWake` 是它唯一的产生点（全仓 grep 只在 `background-await.ts`），
 * 所以「模型上下文里没有这句话」= 没有发出这条通知。
 *
 * 时长说明：静默阈值 `SHELL_QUIESCENT_MS = 60s` 本身就是被测对象，命令要跑到 70s
 * 才能跨过它（`wait_until_seconds` 下限也是 60s，压不下去），因此本条用
 * `timeoutMs: 150_000` 覆盖运行器缺省的 60s 单例超时。
 */
import type { SmokeCase } from "../../lib/types.ts";

const def: SmokeCase = {
  id: "N4-quiescent-declared-wait",
  ledger: "N4",
  feature: "等待态：声明的后台等待",
  kind: "guard",
  repo: { "README.md": "N4：声明的等待不该收到静默通知\n" },
  argv: ["-p", "等 never-done.txt 出现后告诉我结果"],
  timeoutMs: 150_000,
  expect: {
    events: [
      // 锁住前提：这条命令确实按「声明了期限的等待」登记了（不是普通后台 shell）
      { event: "WaitRegistered", where: { kind: "shell", promise_kind: "deadline" }, count: 1 },
    ],
    output: (out) => {
      // 真实轨迹里模型收到的原话是「…已 Ns 没有新输出，不会再自动回报。」
      // 它在下一次请求的 new_messages 里进入模型上下文，所以对 request 全量做匹配。
      if (JSON.stringify(out.requests).includes("不会再自动回报")) {
        return (
          "声明了 wait_until 的后台命令仍收到「已静默、不会再自动回报」的静默通知——" +
          "与启动回执承诺的「期间不按静默判定」自相矛盾，模型只能自己前台轮询"
        );
      }
      return null;
    },
  },
  mutations: [
    {
      file: "packages/core/src/task/background-await.ts",
      // 这一处同时废掉 endMainLoopTurn 的提前排除与 takeQuiescentWake 的短路
      // （两处共用 reportsOnItsOwn），所以一条配方足以让用例变红。
      find: '  if (!isShellTask(task)) return false;\n  if (outputBufferedUntilExit(task.command ?? "")) return true;\n  return hasDeadlineWait(task.id);\n',
      replace:
        '  if (!isShellTask(task)) return false;\n  if (outputBufferedUntilExit(task.command ?? "")) return true;\n  return false;\n',
      why: "唤醒器不再认「有期限承诺」的后台 shell，静默 60s 后放出「不会再自动回报」",
    },
  ],
};

export default def;
