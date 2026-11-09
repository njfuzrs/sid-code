/**
 * T-W1-7：压缩摘要补「当前等待」行（FIX-9）。
 *
 * 为什么要它：压缩把对话换成摘要，模型从此看不到「我在等 monitor m7 盯 PR #662」。
 * 登记表在进程内、不受压缩影响（`listWaits()` 照常返回、`hasPromisedWait()` 照常为真），
 * 但**模型的认知**受影响：压缩后它可能重复起一个盯同一对象的 monitor，或在 `task_stop`
 * 前不知道自己还在等什么。所以两条 LLM 摘要压缩路径（自动 `autoCompact`、手动
 * `/compact` 的 `partialCompact`）都要把当前等待源写进摘要正文。
 *
 * 用例从真实入口进（`autoCompact()` / `partialCompact()`），不直调内部拼装函数。
 * 落盘隔离：`SID_CONFIG_DIR` 重定向到 tmpdir（压缩会写 events / trace）。
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { autoCompact, resetCircuitBreaker } from "../../src/query/auto-compact.ts";
import { partialCompact } from "../../src/query/compact/partial-compact.ts";
import { PARTIAL_COMPACT_PREFIX } from "../../src/query/compact/partial-compact.ts";
import { Manager as ContextManager } from "../../src/context/manager.ts";
import type { Message, StreamEvent } from "../../src/llm/types.ts";
import type { Provider } from "../../src/llm/provider.ts";
import {
  __resetWaitRegistryForTest,
  describeWaitSource,
  listWaits,
  registerWait,
} from "../../src/task/wait-registry.ts";
import { clearAllTasks, registerTask } from "../../src/task/registry.ts";
import { dequeuePendingNotifications } from "../../src/task/notification.ts";
import { __clearActiveMonitorsForTest } from "../../src/task/monitor-task.ts";
import { resetScheduler } from "../../src/cron/scheduler.ts";
import { setWakeupRegistrationEnabled } from "../../src/task/wait-registry.ts";
import type { LocalMonitorTaskState } from "../../src/task/types.ts";

const T0 = 1_700_000_000_000;
const MONITOR_DESC = "PR #662 CI";

/** 压缩会写 events / trace：落盘重定向到 tmpdir（存/恢复原值） */
let originalConfigDir: string | undefined;
let tmpHome = "";

/** 最小 HookSystem 桩：pre / post compact 均不阻止 */
const noopHookSystem: any = {
  firePreCompactEvent: async () => ({ finalOutput: null }),
  firePostCompactEvent: async () => ({ finalOutput: null }),
  fireSessionRestartEvent: async () => ({ finalOutput: null }),
};

/** 返回一段纯文本摘要的 provider（压缩两条路径共用） */
function summaryProvider(text: string): Provider {
  return {
    name: () => "mock",
    async *sendMessageStream(): AsyncIterable<StreamEvent> {
      yield {
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text },
      } as StreamEvent;
      yield { type: "message_stop" } as StreamEvent;
    },
  } as Provider;
}

function buildMessages(n: number): Message[] {
  const msgs: Message[] = [];
  for (let i = 0; i < n; i++) {
    msgs.push({
      role: i % 2 === 0 ? "user" : "assistant",
      content: [{ type: "text", text: `消息 ${i} `.repeat(20) }],
    });
  }
  return msgs;
}

function buildCtx(n: number): ContextManager {
  const ctx = new ContextManager({ maxTokens: 100_000 });
  ctx.setMessages(buildMessages(n));
  return ctx;
}

function buildDeps(ctx: ContextManager, text = "一份看起来很完整的摘要") {
  return {
    provider: summaryProvider(text),
    config: { model: "mock-model", provider: "mock" },
    ctxMgr: ctx,
    hookSystem: noopHookSystem,
    getAbortSignal: () => undefined,
    // 不污染全局熔断器
    isMainAgent: false,
  } as any;
}

function monitorTask(id: string, overrides: Partial<LocalMonitorTaskState> = {}) {
  return {
    id,
    type: "local_monitor" as const,
    status: "running" as const,
    description: MONITOR_DESC,
    startTime: T0,
    outputFile: `/tmp/${id}.out`,
    outputOffset: 0,
    notified: false,
    command: "gh pr checks 662 --watch",
    isBackgrounded: true,
    timeoutMs: 600_000,
    ...overrides,
  };
}

/** 登记一个「正在盯 PR #662」的 monitor 等待源（等价于 MonitorTool 成功后的登记表状态） */
function registerMonitorWait(id = "m7", deadlineAt = Date.now() + 600_000): void {
  registerTask(monitorTask(id) as any);
  registerWait({
    id,
    kind: "monitor",
    promise: { kind: "deadline", deadlineAt },
    description: MONITOR_DESC,
    registeredAt: Date.now(),
  });
}

/** 压缩后注入上下文的那条摘要消息正文（用于断言「摘要含/不含某行」） */
function summaryMessages(ctx: ContextManager): string[] {
  return ctx
    .getMessages()
    .filter(
      (m) =>
        m.role === "user" && m.content.some((b) => b.type === "text" && b.text.includes("摘要")),
    )
    .map((m) =>
      m.content
        .filter((b) => b.type === "text")
        .map((b) => (b as { type: "text"; text: string }).text)
        .join("\n"),
    );
}

beforeEach(() => {
  originalConfigDir = process.env.SID_CONFIG_DIR;
  tmpHome = mkdtempSync(join(tmpdir(), "sid-compact-wait-line-"));
  process.env.SID_CONFIG_DIR = tmpHome;
  resetCircuitBreaker();
  __resetWaitRegistryForTest();
  __clearActiveMonitorsForTest();
  clearAllTasks();
  dequeuePendingNotifications();
  resetScheduler();
});

afterEach(() => {
  resetCircuitBreaker();
  __resetWaitRegistryForTest();
  __clearActiveMonitorsForTest();
  clearAllTasks();
  dequeuePendingNotifications();
  resetScheduler();
  if (originalConfigDir === undefined) delete process.env.SID_CONFIG_DIR;
  else process.env.SID_CONFIG_DIR = originalConfigDir;
  rmSync(tmpHome, { recursive: true, force: true });
});

describe("T-W1-7 · 压缩摘要补「当前等待」行", () => {
  test("自动压缩：登记 monitor 后压缩，摘要含该 monitor 的描述且登记表不变", async () => {
    registerMonitorWait("m7");
    const waitsBefore = listWaits().map((w) => `${w.kind}:${w.id}:${w.description}`);
    expect(waitsBefore).toEqual(["monitor:m7:PR #662 CI"]);

    const ctx = buildCtx(20);
    const outcome = await autoCompact(buildDeps(ctx));
    expect(outcome.kind).toBe("summarized");

    // 摘要消息里有「当前等待」行，且是 describeWaitSource 的那份标签文案
    const summary = summaryMessages(ctx).join("\n\n");
    expect(summary).toContain("当前等待：");
    expect(summary).toContain(describeWaitSource(listWaits()[0]!));
    expect(summary).toContain("PR #662 CI");
    expect(summary).toContain("最晚 ");

    // 压缩只读登记表，不改它：前后 listWaits() 结果相同（验收项）
    expect(listWaits().map((w) => `${w.kind}:${w.id}:${w.description}`)).toEqual(waitsBefore);
  });

  test("自动压缩：没有等待源时摘要不含这一行", async () => {
    expect(listWaits()).toHaveLength(0);
    const ctx = buildCtx(20);
    const outcome = await autoCompact(buildDeps(ctx));
    expect(outcome.kind).toBe("summarized");

    const summary = summaryMessages(ctx).join("\n\n");
    expect(summary).not.toContain("当前等待");
  });

  test("自动压缩：多个等待源（monitor + 定时唤醒）都列出，用「；」分隔", async () => {
    registerMonitorWait("m7");
    setWakeupRegistrationEnabled(true);
    registerWait({
      id: "wk1",
      kind: "wakeup",
      promise: { kind: "deadline", deadlineAt: Date.now() + 1_500_000 },
      description: "检查 PR #662 CI 结果",
      registeredAt: Date.now() - 1000,
    });
    // 唤醒的判据是「调度器里还在」：补一条会话级任务，否则 listWaits() 判它已失效
    const { getScheduler } = await import("../../src/cron/scheduler.ts");
    getScheduler({
      onFire: () => {},
      isLoading: () => false,
      sessionId: "t",
      workspaceDir: "/tmp",
    });
    getScheduler().addSessionTask({
      id: "wk1",
      cron: "",
      prompt: "检查 PR #662 CI 结果",
      createdAt: Date.now(),
      recurring: false,
      durable: false,
      fireAt: Date.now() + 1_500_000,
      origin: "schedule_wakeup",
    } as any);

    const ctx = buildCtx(20);
    const outcome = await autoCompact(buildDeps(ctx));
    expect(outcome.kind).toBe("summarized");

    const summary = summaryMessages(ctx).join("\n\n");
    const line = summary.split("\n").find((l) => l.startsWith("当前等待："));
    expect(line).toBeDefined();
    expect(line).toContain("监控 m7（PR #662 CI）");
    expect(line).toContain("定时唤醒 wk1（检查 PR #662 CI 结果）");
    // 多条用「；」分隔（与方案文案一致）
    expect(line!.split("；")).toHaveLength(2);
  });

  test("手动 /compact（partialCompact）：摘要消息含「当前等待」，登记表不变", async () => {
    registerMonitorWait("m7");
    const waitsBefore = listWaits().map((w) => `${w.kind}:${w.id}:${w.description}`);

    const result = await partialCompact(buildMessages(12), 6, {
      provider: summaryProvider("前段对话的背景摘要"),
      model: "mock-model",
    });
    expect(result.success).toBe(true);

    const summaryMsg = result.messages[0]!;
    const text = summaryMsg.content
      .filter((b) => b.type === "text")
      .map((b) => (b as { type: "text"; text: string }).text)
      .join("\n");
    expect(text.startsWith(PARTIAL_COMPACT_PREFIX)).toBe(true);
    expect(text).toContain("当前等待：");
    expect(text).toContain("监控 m7（PR #662 CI）");

    expect(listWaits().map((w) => `${w.kind}:${w.id}:${w.description}`)).toEqual(waitsBefore);
  });

  test("手动 /compact（partialCompact）：没有等待源时摘要不含这一行", async () => {
    const result = await partialCompact(buildMessages(12), 6, {
      provider: summaryProvider("前段对话的背景摘要"),
      model: "mock-model",
    });
    expect(result.success).toBe(true);
    const text = result.messages[0]!.content.filter((b) => b.type === "text")
      .map((b) => (b as { type: "text"; text: string }).text)
      .join("\n");
    expect(text).not.toContain("当前等待");
  });
});
