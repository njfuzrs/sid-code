/**
 * A4 会话内循环（G4，**仅本机**）：真 TUI 里 `/loop 1m <任务>` → 等一次真实的 cron 到点
 * → 调度器 `ScheduledFire` → 宿主 `ScheduledInject` → 当作一次用户输入跑完一轮。
 *
 * 期望来源：核心功能触发清单 A4 的人工实测（2026-11-05，`sc-dev` HEAD `de2ffc16`，TUI 会话
 * `20261105-191734-b2249982`，`/loop 5m 检查一下 git status`）：
 *   ① 回显「已创建循环任务（每5 分钟，会话级，7 天后过期），ID: …」；
 *   ② 无人输入时自动跑了一轮：`UserPromptSubmit` → `bash git status` → `TurnComplete`；
 *   ③ 每轮一对 `ScheduledInject{task_id, queue_wait_ms:0, queued:false}` +
 *      `ScheduledFire{task_id, origin:"loop", dispatch:"inject", outcome:"fired"}`，`task_id` 对得上，
 *      `ScheduledInject` 紧邻（早于）那一轮的 `UserPromptSubmit`。
 * 本例把 5m 换成 1m（cron 最小粒度），任务文本不变；模型回复换成回放夹具。
 * `ScheduledInject.outcome` 是 11-05 之后加的字段（W3），人工实测时还没有，所以不断言它。
 *
 * **为什么只在本机跑**（后续规划 §6 裁决 2）：cron 最小粒度 1 分钟 + 确定性抖动（≤ 周期 10%）
 * + 调度器 30s 轮询（相位跟启动时刻走），真等一次触发要 30–96s，放进 PR 门禁会吃掉
 * G2+G4 CI 时长上限的约 1/3；又不许为了冒烟给调度器加测试开关（总纲「不做什么」）。
 * 进程内这段链路由 G1 单测守（`scheduled-fire-telemetry` / `scheduled-inject` / `loop-every`），
 * 本例只多守「TUI 里真实注入」这段接线；保鲜靠本机每周调度（后续规划 PR-9）。
 */
import {
  SCHEDULED_FIRE_EVENT_NAME,
  SCHEDULED_INJECT_EVENT_NAME,
} from "@sid-code/core/cron/cron-telemetry.ts";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parseEvents, type TraceEvent } from "../../lib/assert.ts";
import type { SmokeCase } from "../../lib/types.ts";

const TASK = "检查一下 git status";

const def: SmokeCase = {
  id: "A4-loop-tui",
  ledger: "A4",
  feature: "会话内循环 /loop（TUI 真实触发）",
  kind: "guard",
  localOnly:
    "真等一次 cron 触发要 30–96s（1 分钟粒度 + 抖动 + 30s 轮询），CI 不守；保鲜靠本机每周调度（后续规划 §6 裁决 2）",
  timeoutMs: 180_000,
  repo: { "README.md": "a4\n" },
  argv: [],
  tui: [
    { kind: "wait", screen: "输入消息或 /help 查看命令", label: "TUI 就绪" },
    { kind: "type", text: `/loop 1m ${TASK}` },
    { kind: "key", key: "enter" },
    { kind: "wait", screen: "已创建循环任务（每1 分钟", label: "循环任务已创建" },
    // 从这里起没有任何输入：下一轮只能来自调度器注入。上限 = 60s 周期 + 6s 抖动 + 30s 轮询 + 余量
    {
      kind: "wait",
      screen: "循环检查完成：工作区干净。",
      timeoutMs: 120_000,
      label: "到点自动跑完一轮",
    },
  ],
  expect: {
    events: [
      {
        event: SCHEDULED_FIRE_EVENT_NAME,
        where: {
          origin: "loop",
          recurring: true,
          durable: false,
          dispatch: "inject",
          outcome: "fired",
        },
      },
      { event: SCHEDULED_INJECT_EVENT_NAME, where: { queued: false } },
    ],
    // 配对与顺序：同一个 task_id 的 Fire / Inject 各至少 1 条，且第一条 Inject 早于任务文本的
    // UserPromptSubmit——否则那一轮可能是别的路径（比如回车被当成提交）跑出来的，而不是注入
    output: (out) => {
      const dir = join(out.configDir, "trajectories/sessions");
      const [sid] = readdirSync(dir);
      const evs: TraceEvent[] = parseEvents(readFileSync(join(dir, sid!, "events.jsonl"), "utf8"));
      const fire = evs.find(
        (e) => e.event === SCHEDULED_FIRE_EVENT_NAME && e.data?.origin === "loop",
      );
      const taskId = fire?.data?.task_id;
      if (typeof taskId !== "string") return "没有 origin=loop 的 ScheduledFire";
      const injectIdx = evs.findIndex(
        (e) => e.event === SCHEDULED_INJECT_EVENT_NAME && e.data?.task_id === taskId,
      );
      if (injectIdx < 0)
        return `ScheduledInject 里没有 task_id=${taskId}（与 ScheduledFire 对不上）`;
      const submits = evs
        .map((e, i) => ({ e, i }))
        .filter(({ e }) => e.event === "UserPromptSubmit" && e.data?.prompt === TASK);
      if (submits.length !== 1)
        return `任务文本的 UserPromptSubmit 应恰 1 条（只有注入这一轮），实际 ${submits.length}`;
      if (submits[0]!.i < injectIdx)
        return "任务文本的 UserPromptSubmit 早于 ScheduledInject：那一轮不是注入出来的";
      return null;
    },
  },
  mutations: [
    {
      file: "packages/cli/src/cli.ts",
      find: "          void app.enqueueScheduledPrompt?.(prompt, task);",
      replace: "          void prompt;",
      why: "调度器照常到点、ScheduledFire 照报 fired，但宿主根本没收到——TUI 里什么也不发生",
    },
    {
      file: "packages/cli/src/app.ts",
      find: "      await tuiAgentLoop(text, undefined, source);",
      replace: "      void text;",
      why: "ScheduledInject 照发，但注入器不跑主循环（只看事件会假绿）",
    },
    {
      file: "packages/cli/src/cli.ts",
      find: "      scheduler.start();",
      replace: "      void scheduler;",
      why: "TUI 会话没启动调度器：/loop 照常回显「已创建」，任务永远不触发",
    },
  ],
};

export default def;
