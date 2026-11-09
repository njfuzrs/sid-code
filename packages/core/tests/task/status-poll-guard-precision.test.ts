/**
 * FIX-5：P1 拦截精度（D12 / D13 / D14）。
 *
 * 三个缺陷的共同点：**拦截的前提与回执里的说法，都必须与「谁真的在等、等的是什么」一致**。
 * - D12：判据 1 用的是 `hasPromisedWait()`，把派生的子代理 / 普通后台 shell 也算「在等」，
 *   回执还 fallback 到无关等待源并谎称「状态变化会通知」（实测 R10）；
 * - D13：`covered` 只看 subject（对象粒度），monitor 没报告的字段也被当成覆盖了，拦到底；
 * - D14：E1 的首行说明破坏了 `gh pr checks` 的 TSV 归一化，拦截回执丢掉「几项 pending / pass」。
 *
 * 本文件按方案 §2 的验收写：判据用**真实构造**（registerTask / registerWait / scheduler），
 * 不直调内部函数伪造等待源；D14 走 `BashTool.execute` + `executeSingleTool` 的真实入口。
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import {
  checkStatusQueryPoll,
  recordStatusQueryResult,
  __resetStatusPollGuardForTest,
  STATUS_POLL_PROBE_INTERVAL_MS,
  type StatusPollContext,
} from "@sid-code/core/task/status-poll-guard.ts";
import {
  extractStatusQueryFamilies,
  normalizeStatusOutput,
  summarizeStatusOutput,
  type StatusQueryFamily,
} from "@sid-code/core/task/status-query-commands.ts";
import {
  __resetWaitRegistryForTest,
  hasDeclaredExternalWait,
  hasPromisedWait,
  listWaits,
  registerWait,
  setWakeupRegistrationEnabled,
} from "@sid-code/core/task/wait-registry.ts";
import { clearAllTasks, registerTask } from "@sid-code/core/task/registry.ts";
import { getScheduler, resetScheduler } from "@sid-code/core/cron/scheduler.ts";
import { GH_CHECKS_PENDING_HEADER } from "@sid-code/core/tool/bash/command-semantics.ts";
import { BashTool } from "@sid-code/core/tool/bash.ts";
import { executeTools, type ToolExecutorDeps } from "@sid-code/core/query/tool-executor.ts";
import type { ToolUseBlock } from "@sid-code/core/llm/types.ts";
import type { CronTask } from "@sid-code/core/cron/types.ts";
import type {
  LocalAgentTaskState,
  LocalMonitorTaskState,
  LocalShellTaskState,
  LocalWorkflowTaskState,
} from "@sid-code/core/task/types.ts";

const T0 = 1_700_000_000_000;

/** `gh pr checks` 的真实 TSV 形态：1 项 pending + 2 项 pass */
const CHECKS_TSV = [
  "test (ubuntu-latest, 1/3)\tpending\t0\thttps://github.com/o/r/actions/runs/1/job/1\t",
  "test (ubuntu-latest, 2/3)\tpass\t2m49s\thttps://github.com/o/r/actions/runs/1/job/2\t",
  "self-check\tpass\t9s\thttps://github.com/o/r/actions/runs/2/job/3\t",
].join("\n");

const CMD_CHECKS = "gh pr checks 662 2>&1";

let originalConfigDir: string | undefined;
let tmpHome: string;

// ───────────────────────────── 真实构造：任务与等待源 ─────────────────────────────

function shellTask(id: string, command = "bun test"): LocalShellTaskState {
  return {
    id,
    type: "local_shell",
    status: "running",
    description: command,
    startTime: Date.now(),
    outputFile: join(tmpHome, "tasks", `${id}.output`),
    outputOffset: 0,
    notified: false,
    interrupted: false,
    isBackgrounded: true,
    command,
  };
}

function agentTask(id: string): LocalAgentTaskState {
  return {
    id,
    type: "local_agent",
    status: "running",
    description: `子代理 ${id}`,
    startTime: Date.now(),
    outputFile: join(tmpHome, "tasks", `${id}.output`),
    outputOffset: 0,
    notified: false,
    isBackgrounded: true,
    agentId: id,
    agentType: "general-purpose",
    prompt: "查一下 PR",
  };
}

function workflowTask(id: string): LocalWorkflowTaskState {
  return {
    id,
    type: "local_workflow",
    status: "running",
    description: `workflow ${id}`,
    startTime: Date.now(),
    outputFile: join(tmpHome, "tasks", `${id}.output`),
    outputOffset: 0,
    notified: false,
    isBackgrounded: true,
    workflowName: id,
    runId: `wf_${id}`,
    source: "inline",
  };
}

function monitorTask(id: string): LocalMonitorTaskState {
  return {
    id,
    type: "local_monitor",
    status: "running",
    description: "PR #662 CI",
    startTime: Date.now(),
    outputFile: join(tmpHome, "tasks", `${id}.output`),
    outputOffset: 0,
    notified: false,
    isBackgrounded: true,
    command: "gh pr checks 662",
    deadlineAt: T0 + 600_000,
    eventCount: 0,
    outputLines: 0,
  };
}

/** 登记一台**真实** monitor：任务在 registry 里 running，等待登记带 subject / 命令族 */
function addMonitor(
  id = "m1",
  opts: { subjects?: string[]; commandFamilies?: StatusQueryFamily[] } = {},
): void {
  registerTask(monitorTask(id));
  registerWait({
    id,
    kind: "monitor",
    promise: { kind: "deadline", deadlineAt: T0 + 600_000 },
    description: "PR #662 CI",
    registeredAt: T0,
    subjects: opts.subjects ?? ["gh:pr:662"],
    commandFamilies: opts.commandFamilies ?? ["gh_pr_checks"],
  });
}

/** 登记一条**真实**的定时唤醒（调度器里有它，登记表里也有它） */
function addWakeup(id = "wk1", subjects?: string[]): void {
  setWakeupRegistrationEnabled(true);
  const fireAt = Date.now() + 1_500_000;
  const task: CronTask = {
    id,
    cron: "",
    prompt: "25 分钟后再看 CI",
    createdAt: T0,
    recurring: false,
    durable: false,
    fireAt,
    origin: "schedule_wakeup",
  };
  getScheduler().addSessionTask(task);
  registerWait({
    id,
    kind: "wakeup",
    promise: { kind: "deadline", deadlineAt: fireAt },
    description: "25 分钟后再看 CI",
    registeredAt: T0,
    subjects,
  });
}

/** 生产路径同款的 ctx：判据与清单都来自真实 registry，只有时钟可注入 */
function realCtx(clock: { now: number }): StatusPollContext {
  return {
    hasDeclaredExternalWait: () => hasDeclaredExternalWait(),
    listWaits: () => listWaits(),
    memo: { entries: new Map() },
    now: () => clock.now,
  };
}

/** 连查三次：前两次放行并记录，返回第三次的判定 */
function queryThreeTimes(cmd: string, ctx: StatusPollContext, output = CHECKS_TSV) {
  for (let i = 0; i < 2; i++) {
    expect(checkStatusQueryPoll("bash", { command: cmd }, ctx).intercept).toBe(false);
    recordStatusQueryResult(cmd, output, ctx);
  }
  return checkStatusQueryPoll("bash", { command: cmd }, ctx);
}

beforeEach(() => {
  // BashTool 的真实入口会写 tasks 目录：按 CONTRIBUTING 的测试约定重定向到 tmpdir
  originalConfigDir = process.env.SID_CONFIG_DIR;
  tmpHome = mkdtempSync(join(tmpdir(), "sid-status-poll-precision-"));
  process.env.SID_CONFIG_DIR = tmpHome;
  __resetWaitRegistryForTest();
  __resetStatusPollGuardForTest();
  clearAllTasks();
  resetScheduler();
  getScheduler({ onFire: () => {}, isLoading: () => false, sessionId: "t", workspaceDir: tmpHome });
});

afterEach(() => {
  __resetWaitRegistryForTest();
  __resetStatusPollGuardForTest();
  clearAllTasks();
  resetScheduler();
  if (originalConfigDir === undefined) delete process.env.SID_CONFIG_DIR;
  else process.env.SID_CONFIG_DIR = originalConfigDir;
  rmSync(tmpHome, { recursive: true, force: true });
});

// ───────────────────────────────── D12 ─────────────────────────────────

describe("D12 判据 1：只认模型显式声明的等待", () => {
  test("D12-1 派生等待源有承诺但不构成「声明在等外部状态」", () => {
    registerTask(shellTask("s1"));
    registerTask(agentTask("a1"));
    registerTask(workflowTask("w1"));
    // 三个派生源：T2 闸门口径（要宽）为真
    expect(hasPromisedWait()).toBe(true);
    // P1 口径（要窄）为假 —— 它们承诺的是「自己结束时会回报」
    expect(hasDeclaredExternalWait()).toBe(false);
  });

  test("D12-2 monitor / 唤醒 / wait_until 三条显式路径分别成立", () => {
    addMonitor("m1");
    expect(hasDeclaredExternalWait()).toBe(true);

    __resetWaitRegistryForTest();
    clearAllTasks();
    addWakeup("wk1");
    expect(hasDeclaredExternalWait()).toBe(true);

    __resetWaitRegistryForTest();
    clearAllTasks();
    registerTask(shellTask("s2", "until curl -sf localhost:3000/health; do sleep 1; done"));
    registerWait({
      id: "s2",
      kind: "shell",
      promise: { kind: "deadline", deadlineAt: Date.now() + 300_000 },
      description: "等本地服务就绪",
      registeredAt: Date.now(),
    });
    expect(hasDeclaredExternalWait()).toBe(true);
  });

  test("D12-3 R10 反转：只有普通后台 shell 时同命令连查三次**都执行**", () => {
    registerTask(shellTask("s1", "bun test"));
    const clock = { now: T0 };
    const ctx = realCtx(clock);
    for (let i = 0; i < 3; i++) {
      expect(checkStatusQueryPoll("bash", { command: CMD_CHECKS }, ctx).intercept).toBe(false);
      recordStatusQueryResult(CMD_CHECKS, CHECKS_TSV, ctx);
    }
  });

  test("D12-4 全组合表：判据 + 回执是否引用无关等待源", () => {
    const cases: Array<{
      name: string;
      setup: () => void;
      intercept: boolean;
      /** 回执里必须出现的片段（不拦时为 undefined） */
      mustContain?: string;
      /** 回执里**不得**出现的片段 */
      mustLack?: string[];
    }> = [
      { name: "仅普通 shell", setup: () => registerTask(shellTask("s1")), intercept: false },
      { name: "仅子代理", setup: () => registerTask(agentTask("a1")), intercept: false },
      { name: "仅 workflow", setup: () => registerTask(workflowTask("w1")), intercept: false },
      {
        name: "仅 monitor（同 subject）",
        setup: () =>
          addMonitor("m1", { subjects: ["gh:pr:662"], commandFamilies: ["gh_pr_checks"] }),
        intercept: true,
        mustContain: "监控 m1（PR #662 CI）",
      },
      {
        name: "仅 monitor（异 subject）",
        setup: () =>
          addMonitor("m1", { subjects: ["gh:pr:661"], commandFamilies: ["gh_pr_checks"] }),
        intercept: true,
        mustContain: "它不盯这个对象",
        // 只有 monitor 覆盖了本对象才可以说「状态变化会以通知送达」
        mustLack: ["状态变化会以通知送达"],
      },
      {
        name: "仅唤醒",
        setup: () => addWakeup("wk1"),
        intercept: true,
        mustContain: "它只是一个定时器，到点才会再看",
        mustLack: ["状态变化会以通知送达"],
      },
      {
        name: "仅 wait_until",
        setup: () => {
          registerTask(shellTask("s2", "until curl -sf localhost:3000/health; do sleep 1; done"));
          registerWait({
            id: "s2",
            kind: "shell",
            promise: { kind: "deadline", deadlineAt: T0 + 300_000 },
            description: "等本地服务就绪",
            registeredAt: T0,
          });
        },
        intercept: true,
        mustContain: "它只是一个定时器，到点才会再看",
        mustLack: ["状态变化会以通知送达"],
      },
    ];

    for (const c of cases) {
      // 每格独立：清掉上一格的任务与登记
      __resetWaitRegistryForTest();
      clearAllTasks();
      c.setup();
      const clock = { now: T0 };
      const ctx = realCtx(clock);
      const r = queryThreeTimes(CMD_CHECKS, ctx);
      expect({ name: c.name, intercept: r.intercept }).toEqual({
        name: c.name,
        intercept: c.intercept,
      });
      if (!r.intercept) continue;
      // 回执里绝不能出现普通后台 shell 的 id（E2E-16 的判据）
      expect(r.output).not.toContain("后台命令 s1");
      expect(r.output).not.toContain("子代理 a1");
      expect(r.output).not.toContain("workflow w1");
      if (c.mustContain) expect(r.output).toContain(c.mustContain);
      for (const bad of c.mustLack ?? []) expect(r.output).not.toContain(bad);
    }
  });

  test("D12-5 首次相同的提示同样不 fallback 到无关等待源", () => {
    registerTask(shellTask("s1", "bun test"));
    addWakeup("wk1");
    const clock = { now: T0 };
    const ctx = realCtx(clock);
    recordStatusQueryResult(CMD_CHECKS, CHECKS_TSV, ctx);
    clock.now = T0 + 5_000;
    const hint = recordStatusQueryResult(CMD_CHECKS, CHECKS_TSV, ctx);
    expect(hint).toContain("[等待中] 结果与上次相同");
    // 引用的是模型声明的唤醒，而不是那条无关的 bun test
    expect(hint).toContain("定时唤醒 wk1");
    expect(hint).not.toContain("后台命令 s1");
    expect(hint).not.toContain("状态变化会以通知送达");
  });
});

// ───────────────────────────────── D13 ─────────────────────────────────

describe("D13 monitor 的覆盖判定：对象粒度 → 命令族粒度", () => {
  test("D13-1 复现：monitor 只跑 gh pr checks，模型查 reviewDecision 时到点放行", () => {
    // monitor 脚本只含 `gh pr checks 662`（commandFamilies 由真实脚本扫描得到，见 D13-4）
    addMonitor("m1", { subjects: ["gh:pr:662"], commandFamilies: ["gh_pr_checks"] });
    const clock = { now: T0 };
    const ctx = realCtx(clock);
    const cmdView = "gh pr view 662 --json reviewDecision";
    const outView = '{"reviewDecision":"REVIEW_REQUIRED"}';

    recordStatusQueryResult(cmdView, outView, ctx);
    clock.now = T0 + 5_000;
    recordStatusQueryResult(cmdView, outView, ctx);
    clock.now = T0 + 10_000;
    // 未被覆盖：前两次相同之后仍会拦（拦截本身没错）
    expect(checkStatusQueryPoll("bash", { command: cmdView }, ctx).intercept).toBe(true);
    // 但必须有上界：130s 后放行一次，模型能看到 review 通过 / 冲突出现
    clock.now = T0 + 10_000 + STATUS_POLL_PROBE_INTERVAL_MS;
    expect(checkStatusQueryPoll("bash", { command: cmdView }, ctx).intercept).toBe(false);
  });

  test("D13-2 反向：monitor 脚本含同一命令族时仍拦到底（锁住原设计收益）", () => {
    addMonitor("m1", { subjects: ["gh:pr:662"], commandFamilies: ["gh_pr_view"] });
    const clock = { now: T0 };
    const ctx = realCtx(clock);
    const cmdView = "gh pr view 662 --json reviewDecision";
    const outView = '{"reviewDecision":"REVIEW_REQUIRED"}';

    recordStatusQueryResult(cmdView, outView, ctx);
    clock.now = T0 + 5_000;
    recordStatusQueryResult(cmdView, outView, ctx);
    // 远超探测窗口：被 monitor 覆盖的查询不吃探测放行
    clock.now = T0 + 10 * 60_000;
    expect(checkStatusQueryPoll("bash", { command: cmdView }, ctx).intercept).toBe(true);
  });

  test("D13-3 commandFamilies 为空 = 扫不出 = 视为不覆盖", () => {
    addMonitor("m1", { subjects: ["gh:pr:662"], commandFamilies: [] });
    const clock = { now: T0 };
    const ctx = realCtx(clock);
    recordStatusQueryResult(CMD_CHECKS, CHECKS_TSV, ctx);
    clock.now = T0 + 5_000;
    recordStatusQueryResult(CMD_CHECKS, CHECKS_TSV, ctx);
    clock.now = T0 + 10_000;
    expect(checkStatusQueryPoll("bash", { command: CMD_CHECKS }, ctx).intercept).toBe(true);
    clock.now = T0 + 10_000 + STATUS_POLL_PROBE_INTERVAL_MS;
    expect(checkStatusQueryPoll("bash", { command: CMD_CHECKS }, ctx).intercept).toBe(false);
  });

  test("D13-4 extractStatusQueryFamilies 从真实 monitor 脚本扫出命令族", () => {
    // monitor.ts 工具描述里的示例脚本（`s=$(gh pr checks "$pr" ...)` 形态）
    const realScript = [
      'pr=662; interval=45; prev=""',
      "while true; do",
      '  s=$(gh pr checks "$pr" --json name,bucket 2>/dev/null) || { sleep "$interval"; continue; }',
      `  cur=$(jq -r '.[] | select(.bucket!="pending") | "\\(.name): \\(.bucket)"' <<<"$s" | sort)`,
      '  sleep "$interval"',
      "done",
    ].join("\n");
    expect(extractStatusQueryFamilies(realScript)).toContain("gh_pr_checks");

    // 同一条命令的多行写法：`gh pr view` 与 `gh pr checks` 是两个族
    expect(extractStatusQueryFamilies("gh pr checks 662\ngh pr view 662 --json state")).toEqual(
      expect.arrayContaining(["gh_pr_checks", "gh_pr_view"]),
    );

    // 自定义脚本扫不出 → 空数组（调用方据此视为「不覆盖」）
    expect(extractStatusQueryFamilies("while true; do ./my-check.sh; sleep 30; done")).toEqual([]);
    // 表外命令同样不产生族
    expect(extractStatusQueryFamilies("gh pr diff 662 && git status")).toEqual([]);
  });
});

// ───────────────────────────────── D14 ─────────────────────────────────

/** `executeTools` 的最小 deps：真实 registry 里只放 bash，其余依赖用空实现 */
function makeDeps(bash: BashTool): ToolExecutorDeps {
  return {
    config: { checkpoint: { enabled: false } } as any,
    toolRegistry: {
      get: (name: string) => (name === "bash" ? bash : null),
      isDeferred: () => false,
      isActivated: () => true,
      isToolSearchEnabled: () => false,
    } as any,
    sessionState: {
      sessionId: "test-session",
      addToolDuration: () => {},
      recordToolResult: () => {},
    } as any,
    hookSystem: {
      firePreToolUseEvent: async () => ({ finalOutput: undefined }),
      firePostToolUseEvent: async () => ({ finalOutput: undefined }),
      firePostToolUseFailureEvent: async () => ({ finalOutput: undefined }),
      firePermissionDeniedEvent: async () => ({ finalOutput: undefined }),
    } as any,
    permissionChecker: null,
    preToolUseCache: new Map(),
    getAbortSignal: () => undefined,
    requestUserConfirmation: async () => false,
  } as ToolExecutorDeps;
}

const use = (id: string, name: string, input: Record<string, unknown>): ToolUseBlock => ({
  type: "tool_use",
  id,
  name,
  input,
});

describe("D14 原始输出：首行说明不破坏 P1 的归一化", () => {
  test("D14-1 R7 迁入：header 版本与 plain 版本的摘要 / 归一化都相等", () => {
    const plain = CHECKS_TSV;
    const withHeader = `${GH_CHECKS_PENDING_HEADER}\n${CHECKS_TSV}`;

    // 归一化等价（防止「摘要对了、比较仍错」）
    expect(normalizeStatusOutput("gh_pr", withHeader)).toBe(normalizeStatusOutput("gh_pr", plain));
    // 摘要不再是首行截断，而是「几项 pending / pass」
    expect(summarizeStatusOutput("gh_pr", normalizeStatusOutput("gh_pr", withHeader))).toBe(
      "1 项 pending，2 项 pass",
    );
    expect(summarizeStatusOutput("gh_pr", normalizeStatusOutput("gh_pr", withHeader))).toBe(
      summarizeStatusOutput("gh_pr", normalizeStatusOutput("gh_pr", plain)),
    );
  });

  test("D14-2 真实入口：假 gh 退出码 8 → 三次查询，第三次回执保留结构化摘要", async () => {
    // 假 gh：`gh pr checks --json` 的形态 + 退出码 8（有检查 pending 的正常状态）。
    // 用 JSON 而不是 TSV：首行说明会让整段文本**不是合法 JSON**，剥首行容忍救不了它，
    // 只有 rawOutput（加 header 之前的原文）能让归一化走 JSON 路径——两道防线因此
    // 各自可被变异单独命中，不是装饰。
    const checksJson = JSON.stringify({
      checks: [
        {
          name: "test-a",
          status: "COMPLETED",
          conclusion: "success",
          startedAt: "2026-01-01T00:00:00Z",
        },
        { name: "test-b", status: "IN_PROGRESS", startedAt: "2026-01-01T00:00:01Z" },
      ],
    });
    const binDir = join(tmpHome, "bin");
    mkdirSync(binDir, { recursive: true });
    const ghPath = join(binDir, "gh");
    writeFileSync(ghPath, `#!/bin/sh\nprintf '%s\\n' '${checksJson}'\nexit 8\n`, "utf8");
    chmodSync(ghPath, 0o755);

    const cmd = "gh pr checks 662 --json name,status,conclusion";
    // 判据 1：真实 monitor 在等（命令族与查询同族），保证这条查询本该被拦
    addMonitor("m1", { subjects: ["gh:pr:662"], commandFamilies: ["gh_pr_checks"] });

    const oldPath = process.env.PATH;
    process.env.PATH = `${binDir}:${oldPath ?? ""}`;
    try {
      const bash = new BashTool();

      // ① 真实 bash 执行一次：首行是 header，meta.rawOutput 保留加工前的 JSON
      const raw = await bash.execute({ command: cmd });
      expect(String(raw.output)).toContain(GH_CHECKS_PENDING_HEADER);
      expect(typeof raw.meta?.rawOutput).toBe("string");
      expect(String(raw.meta!.rawOutput)).not.toContain(GH_CHECKS_PENDING_HEADER);
      expect(String(raw.meta!.rawOutput)).toContain('"test-b"');

      // ② 真实 tool-executor 连查三次：第三次被拦，且回执里的摘要来自结构化输出
      const deps = makeDeps(bash);
      let third = "";
      for (let i = 0; i < 3; i++) {
        const { results } = await executeTools([use(`u${i}`, "bash", { command: cmd })], deps);
        const block = results.find((b) => b.type === "tool_result") as any;
        expect(block).toBeDefined();
        if (i === 2) third = String(block.content);
      }
      expect(third).toContain("本次未执行");
      // 1 项 success（COMPLETED/conclusion）+ 1 项 IN_PROGRESS（status）
      expect(third).toContain("1 项 success");
      expect(third).toContain("1 项 IN_PROGRESS");
    } finally {
      process.env.PATH = oldPath;
    }
  });
});
