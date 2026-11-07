/**
 * A5 跨会话定时任务（daemon 执行半边）：会话里 cron_create 建一次性 durable 任务 → 会话退出 →
 * `daemon start` 到点 fork headless job 执行。
 *
 * 期望来源：核心功能触发清单 A5 人工实测 ②（2026-11-05，任务 a95b3443）：
 * `daemon.log` 依次 `调度任务入队` → `headless job 启动 source=schedule` → `headless job 完成`；
 * 结果落 `trajectories/daemon-jobs/sched-<id>-*.json`（`exitCode=0`、`timedOut=false`）；
 * 一次性任务跑完后从 `scheduled_tasks.json` 移除。
 *
 * 与人工实测的两处差别，都是为了确定性：
 * - 人工是建「2 分钟后」的任务再等；这里在起 daemon 前把任务 `createdAt` 往前拨 3 分钟，
 *   走 daemon 启动时的 catch-up（一次性任务错过即补跑，`scheduler.ts` `runCatchUp`），不等真实时钟。
 *   改的是 `createdAt`：它不进授权指纹（`durable-grants.ts` `taskFingerprint`），拨了不会被当成篡改。
 * - 「模型会不会调 cron_create」是 G3 的 `A5-cron-create-live`，这里 cron_create 是回放的。
 *
 * job 子进程继承 daemon 的环境，所以它的模型响应来自 `job.jsonl`。
 */
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { HookEventName } from "@sid-code/core/hook/types.ts";
import type { SmokeCase } from "../../lib/types.ts";

const TASKS = ".sid-code/scheduled_tasks.json";

const def: SmokeCase = {
  id: "A5-daemon-schedule",
  ledger: "A5",
  feature: "跨会话定时任务",
  kind: "guard",
  repo: { "package.json": '{"dependencies":{"lodash":"4.17.20"}}\n' },
  argv: ["-p", "建一个一次性 durable 定时任务"],
  after: [
    {
      kind: "daemon",
      replay: "job.jsonl",
      intervalMs: 1000,
      prepare: ({ repoRoot }) => {
        const p = join(repoRoot, TASKS);
        const tasks = JSON.parse(readFileSync(p, "utf8"));
        for (const t of tasks) t.createdAt -= 180_000;
        writeFileSync(p, JSON.stringify(tasks, null, 2));
      },
      until: /headless job (完成|退出码非 0|超时)/,
      timeoutMs: 30_000,
    },
  ],
  expect: {
    events: [
      {
        event: HookEventName.PostToolUse,
        where: { tool_name: "cron_create", is_error: false },
        count: 1,
      },
    ],
    // 一次性任务执行后自删
    files: [{ path: TASKS, equals: "[]" }],
    output: ({ configDir }) => {
      const log = readFileSync(join(configDir, "logs/daemon.log"), "utf8");
      const order = ["调度任务入队", "headless job 启动 source=schedule", "headless job 完成"];
      let at = -1;
      for (const s of order) {
        const i = log.indexOf(s, at + 1);
        if (i < 0) return `daemon.log 缺「${s}」或顺序不对；末尾：${log.slice(-600)}`;
        at = i;
      }
      const dir = join(configDir, "trajectories/daemon-jobs");
      const files = readdirSync(dir).filter((f) => /^sched-.+\.json$/.test(f));
      if (files.length !== 1)
        return `daemon-jobs 期望 1 个 sched-*.json，实际 ${JSON.stringify(files)}`;
      const rec = JSON.parse(readFileSync(join(dir, files[0]), "utf8"));
      if (rec.job?.source !== "schedule")
        return `job.source 期望 schedule，实际 ${rec.job?.source}`;
      if (rec.exitCode !== 0 || rec.timedOut !== false) {
        return `job 期望 exitCode=0 timedOut=false，实际 ${rec.exitCode}/${rec.timedOut}`;
      }
      if (rec.output !== "依赖：lodash")
        return `job output 期望来自 job.jsonl，实际 ${JSON.stringify(rec.output)}`;
      return null;
    },
  },
  mutations: [
    {
      file: "packages/core/src/daemon/daemon.ts",
      find: "onFireTask: (task: CronTask) => this.enqueueTask(task),",
      replace: "onFireTask: (_task: CronTask) => {},",
      why: "调度器照常到点，但 daemon 不入队执行（任务被认领后静默丢失）",
    },
    {
      file: "packages/core/src/cron/scheduler.ts",
      find: "    registerDurableProject(projectDir);",
      replace: "    void projectDir;",
      why: "建任务时不登记 durable-projects，daemon 发现不了这个项目的任务",
    },
  ],
};

export default def;
