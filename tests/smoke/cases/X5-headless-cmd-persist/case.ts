/**
 * X5 无头斜杠命令：放行的命令在真二进制 `-p` 下**真的生效**，写子命令**真的被拒**。
 *
 * 期望来源：无头斜杠命令方案 T5 / T4b 落地时的端到端实测（2026-11-07，worktree 构建产物 +
 * 隔离 `SID_CONFIG_DIR`）：`/effort high -p` 把 `effortLevel` 由 `low` 落盘为 `high`、
 * `/think off -p` 落盘 `thinkingEnabled: false`；`/cron delete x` exit 1，文案含
 * 「只放行子命令：list」。2026-11-08 构建产物探针复现同样结果。
 *
 * 只挑「有落盘副作用」的代表命令：纯只读命令的放行判定已由 G1
 * `headless-allowed-commands.test.ts`（104 例）逐个覆盖，G2 再建一遍是重复。
 * G1 那份门禁守的是判定与注入表，守不到「app.ts 真把 deps 接到了真实 setter」——
 * 那条接线断了，命令仍报「已切换」而磁盘不变（D6 假成功），正是这里要拦的。
 *
 * 主运行是一次普通提问：只跑斜杠命令的进程不调模型、不建轨迹目录，运行器的事件断言
 * 依赖那个目录。三条命令放在 `after` 里，同一隔离环境按序跑。
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { SmokeCase } from "../../lib/types.ts";

const def: SmokeCase = {
  id: "X5-headless-cmd-persist",
  ledger: "X5",
  feature: "无头斜杠命令 A 档",
  kind: "guard",
  repo: {},
  settings: ({ defaults }) => ({ ...defaults, effortLevel: "low" }),
  argv: ["-p", "回复 ok"],
  after: [
    { kind: "print", replay: "effort.jsonl", argv: ["-p", "/effort high -p"] },
    { kind: "print", replay: "think.jsonl", argv: ["-p", "/think off -p"] },
    { kind: "print", replay: "cron.jsonl", argv: ["-p", "/cron delete x"] },
  ],
  expect: {
    exitCode: 0,
    output: ({ steps, configDir }) => {
      const s = JSON.parse(readFileSync(join(configDir, "settings.json"), "utf8"));
      if (s.effortLevel !== "high")
        return `/effort high -p 没有落盘：effortLevel=${JSON.stringify(s.effortLevel)}`;
      const [effort, think, cron] = steps;
      if (!effort || effort.exitCode !== 0)
        return `/effort high -p 退出码 ${effort?.exitCode}，期望 0`;
      if (!think || think.exitCode !== 0) return `/think off -p 退出码 ${think?.exitCode}，期望 0`;
      if (s.thinkingEnabled !== false)
        return `/think off -p 没有落盘：thinkingEnabled=${JSON.stringify(s.thinkingEnabled)}`;
      if (!cron || cron.exitCode === 0)
        return "/cron delete x 退 0：写子命令在无头下被放行或假成功";
      if (!cron.stderr.includes("只放行子命令：list"))
        return `/cron delete x 的拒绝原因不对：${cron.stderr.slice(-300)}`;
      return null;
    },
  },
  mutations: [
    {
      file: "packages/cli/src/command/headless-command-context.ts",
      find: "    setEffort: deps.setEffort,",
      replace: "    setEffort: undefined,",
      why: "无头 cmdCtx 漏注入 setEffort：/effort 走可选链静默跳过，仍报「已切换」而磁盘不变（D6 假成功）",
    },
    {
      file: "packages/cli/src/command/headless-command-context.ts",
      find: "    setThinking: deps.setThinking,",
      replace: "    setThinking: undefined,",
      why: "无头 cmdCtx 漏注入 setThinking：/think off -p 假成功",
    },
    {
      file: "packages/cli/src/command/commands/cron/index.ts",
      find: 'headless: { subcommands: ["list"] },',
      replace: "headless: true,",
      why: "cron 退回整条放行（D13）：/cron delete 在无头下直接删 durable 任务",
    },
  ],
};

export default def;
