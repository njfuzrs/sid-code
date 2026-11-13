/**
 * R5：已声明等待时，催促通道让位 —— 判据单测 + queryLoop 接线验证
 *
 * 缺陷形态（事故 20261112 的 10:48:21 形态，真实轨迹人工核过）：
 * 模型已用 `bash --wait_until_seconds` 挂上对 PR CI 的等待，清单只剩 1 项
 * `in_progress` 的「等 CI 结果」，harness 仍每 8 轮催「仍有 1 项未完成。**请继续推进**」。
 * 模型此刻唯一能做的是等 —— 催它推进只会换来一轮状态空查（P1 守卫要拦的同一件事），
 * 或者被它把项标成 blocked 来让催停（T2 已点破「闸门在逼它对清单撒谎」）。
 *
 * 本文件分两层：
 *   1. `isWaitingOnlyState` 纯函数：四条判据的边界（对应方案验收 4）；
 *   2. queryLoop 接线：判据正确但没接进主循环，是这个仓库反复出现的失败形态
 *      （todo-realtime-integration.test.ts 文件头记录过同一教训），所以必须验接线。
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { queryLoop } from "@sid-code/core/query/loop.ts";
import type { QueryLoopConfig } from "@sid-code/core/query/loop.ts";
import type { QueryDeps } from "@sid-code/core/query/types.ts";
import { isWaitingOnlyState } from "@sid-code/core/query/wait-only-state.ts";
import { Manager as ContextManager } from "@sid-code/core/context/manager.ts";
import { Registry as ToolRegistry } from "@sid-code/core/tool/registry.ts";
import { ModelFallback } from "@sid-code/core/llm/fallback.ts";
import { SessionState } from "@sid-code/core/session/state.ts";
import type { Config } from "@sid-code/core/config/config.ts";
import type { StreamEvent, AccumulatedResponse } from "@sid-code/core/llm/types.ts";
import type { TodoItem } from "@sid-code/core/tool/todo-write.ts";
import { registerTask, clearAllTasks } from "@sid-code/core/task/registry.ts";
import {
  __resetWaitRegistryForTest,
  registerWait,
  releaseWait,
} from "@sid-code/core/task/wait-registry.ts";
import type { LocalShellTaskState } from "@sid-code/core/task/types.ts";

async function* emptyStream(): AsyncIterable<StreamEvent> {}

function toolUseResp(
  id: string,
  name = "read",
  input: Record<string, unknown> = {},
): AccumulatedResponse {
  return {
    role: "assistant",
    content: [{ type: "tool_use", id, name, input: { file_path: "/tmp/x", ...input } }],
    stopReason: "tool_use",
    usage: { inputTokens: 100, outputTokens: 5 },
  } as AccumulatedResponse;
}

function finalResp(text = "已完成"): AccumulatedResponse {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    stopReason: "end_turn",
    usage: { inputTokens: 100, outputTokens: 5 },
  } as AccumulatedResponse;
}

function todo(content: string, status: TodoItem["status"]): TodoItem {
  return { content, activeForm: `正在${content}`, status };
}

/** 造一个 running 的 local_shell 任务（显式等待的有效性判据要求它在 registry 里 running）。 */
function runningShell(id: string, description: string): LocalShellTaskState {
  return {
    id,
    type: "local_shell",
    status: "running",
    description,
    startTime: Date.now(),
    outputFile: `/tmp/${id}.out`,
    outputOffset: 0,
    notified: false,
    command: `run ${id}`,
    interrupted: false,
    isBackgrounded: true,
  };
}

/** 登记一个「显式声明的外部等待」：shell + deadline（= bash --wait_until_seconds） */
function declareShellWait(id: string, description = "等 PR CI") {
  registerTask(runningShell(id, description));
  registerWait({
    id,
    kind: "shell",
    promise: { kind: "deadline", deadlineAt: Date.now() + 600_000 },
    description,
    registeredAt: Date.now(),
  });
}

/**
 * 造一个长时间不碰清单的会话（writeVersion 恒定 = 停滞），
 * 与 todo-realtime-integration.test.ts 的 harness 同构，只多收 trace 事件。
 */
function makeHarness(opts: { turns: number; todos: TodoItem[]; toolName?: string }) {
  const ctxMgr = new ContextManager({ maxTokens: 200000 });
  ctxMgr.setSystemPrompt("test system prompt");
  ctxMgr.addMessage({ role: "user", content: [{ type: "text", text: "干个长活" }] });

  const sentWire: string[] = [];
  const traceEvents: Array<{ event: string; data: any }> = [];

  const responses: AccumulatedResponse[] = [
    ...Array.from({ length: opts.turns }, (_, i) => toolUseResp(`t${i}`, opts.toolName ?? "read")),
    finalResp(),
  ];
  let call = 0;

  const deps: QueryDeps = {
    sendWithRetry: (params: any) => {
      const msgs = params?.messages ?? [];
      for (let i = msgs.length - 1; i >= 0; i--) {
        const m = msgs[i];
        if (m.role !== "user" || !Array.isArray(m.content)) continue;
        sentWire.push(
          m.content
            .filter((b: any) => b.type === "text")
            .map((b: any) => b.text)
            .join("\n"),
        );
        break;
      }
      return emptyStream();
    },
    processStream: async () => responses[call++] ?? finalResp(),
    executeTools: async (content: any[]) => ({
      results: content
        .filter((b: any) => b.type === "tool_use")
        .map((b: any) => ({ type: "tool_result" as const, tool_use_id: b.id, content: "ok" })),
    }),
    autoCompact: async () => ({ kind: "skipped" as const }),
    getAbortSignal: () => undefined,
    uuid: () => "uuid-test",
    getTodoState: () => ({ todos: opts.todos, writeVersion: 1 }),
    traceAppendEvent: (e: any) => {
      traceEvents.push({ event: e.event, data: e.data });
    },
  };

  const loopConfig: QueryLoopConfig = {
    config: {
      model: "deepseek-v4-pro",
      provider: "openai",
      maxTurns: opts.turns + 5,
      toolSearch: false,
    } as unknown as Config,
    ctxMgr,
    toolRegistry: new ToolRegistry(),
    sessionState: new SessionState("test-session-r5"),
    fallback: new ModelFallback(),
    deps,
  };
  return { loopConfig, sentWire, traceEvents };
}

/** 催促通道的文案标志（与 todo-reminder.ts 的 buildTodoReminder 保持同步） */
const NAG_MARKER = "请继续推进";
/** R5 等待态说明的文案标志（与 todo-reminder.ts 的 buildTodoWaitSourcesMessage 同步） */
const WAIT_MARKER = "正在等待：";

function nagTurns(sentWire: string[]): number[] {
  return sentWire.reduce<number[]>((acc, w, i) => (w.includes(NAG_MARKER) ? [...acc, i] : acc), []);
}

function waitNoticeTurns(sentWire: string[]): number[] {
  return sentWire.reduce<number[]>(
    (acc, w, i) => (w.includes(WAIT_MARKER) ? [...acc, i] : acc),
    [],
  );
}

describe("isWaitingOnlyState：四条判据的边界（方案验收 4）", () => {
  test("1 项未完成 + 1 个显式等待 + 无新进展 → 等待态", () => {
    expect(
      isWaitingOnlyState({ unfinished: 1, declaredWaitCount: 1, progressedSinceTodoWrite: false }),
    ).toBe(true);
  });

  test("未完成项 ≤ 等待数：一个等待可以兑现多项，不要求严格相等", () => {
    // 「等 CI 过」+「等 PR 合并」都由同一次 CI 等待兑现，这是常见形态；
    // 要求 == 会把这种场景漏掉，让催促照旧打断等待。
    expect(
      isWaitingOnlyState({ unfinished: 2, declaredWaitCount: 3, progressedSinceTodoWrite: false }),
    ).toBe(true);
  });

  test("2 项未完成但只有 1 个等待 → 不算（有一项没有等待在盯）", () => {
    expect(
      isWaitingOnlyState({ unfinished: 2, declaredWaitCount: 1, progressedSinceTodoWrite: false }),
    ).toBe(false);
  });

  test("有新的副作用进展 → 不算（它其实在干活，催它记账是对的）", () => {
    expect(
      isWaitingOnlyState({ unfinished: 1, declaredWaitCount: 1, progressedSinceTodoWrite: true }),
    ).toBe(false);
  });

  test("没有未完成项 / 没有显式等待 → 不算", () => {
    expect(
      isWaitingOnlyState({ unfinished: 0, declaredWaitCount: 2, progressedSinceTodoWrite: false }),
    ).toBe(false);
    expect(
      isWaitingOnlyState({ unfinished: 2, declaredWaitCount: 0, progressedSinceTodoWrite: false }),
    ).toBe(false);
  });
});

describe("queryLoop 接线：等待态下两条催促通道让位（方案验收 1/3）", () => {
  beforeEach(() => {
    __resetWaitRegistryForTest();
    clearAllTasks();
  });

  afterEach(() => {
    __resetWaitRegistryForTest();
    clearAllTasks();
  });

  test("1 项未完成 + 1 个显式等待：不催「请继续推进」，改注入等待说明", async () => {
    declareShellWait("ci-wait");
    const { loopConfig, sentWire, traceEvents } = makeHarness({
      turns: 20,
      todos: [todo("等 CI 结果", "in_progress")],
    });
    for await (const _ of queryLoop(loopConfig)) {
      /* drain */
    }

    expect(nagTurns(sentWire)).toHaveLength(0);
    const noticeTurns = waitNoticeTurns(sentWire);
    expect(noticeTurns.length).toBeGreaterThanOrEqual(1);
    // 等待说明带上了等待源描述，模型知道 harness 清楚它在等什么
    expect(sentWire[noticeTurns[0]!]).toContain("等 PR CI");
    // 同一轮只注入一次（验收 3）：逐条 wire 里该标志最多出现一次
    for (const wire of sentWire) {
      expect(wire.split(WAIT_MARKER).length - 1).toBeLessThanOrEqual(1);
    }
    // 被压掉的催促可数：落 suppressed_by_wait 埋点，而不是静默消失
    const suppressed = traceEvents.filter(
      (e) =>
        e.event === "NoProgressNagInjected" &&
        e.data?.kind === "todo" &&
        e.data?.suppressed_by_wait === true,
    );
    expect(suppressed.length).toBeGreaterThanOrEqual(1);
  });

  test("等待释放后恢复原行为：重新注入「请继续推进」", async () => {
    declareShellWait("ci-wait");
    // 等待撤掉（CI 已回报 / 任务结束）
    releaseWait("ci-wait", "terminal");
    clearAllTasks();

    const { loopConfig, sentWire } = makeHarness({
      turns: 20,
      todos: [todo("等 CI 结果", "in_progress")],
    });
    for await (const _ of queryLoop(loopConfig)) {
      /* drain */
    }

    expect(nagTurns(sentWire).length).toBeGreaterThanOrEqual(1);
    expect(waitNoticeTurns(sentWire)).toHaveLength(0);
  });

  test("2 项未完成但只有 1 个等待：不算等待态，照常催", async () => {
    declareShellWait("ci-wait");
    const { loopConfig, sentWire } = makeHarness({
      turns: 20,
      todos: [todo("等 CI 结果", "in_progress"), todo("补文档", "pending")],
    });
    for await (const _ of queryLoop(loopConfig)) {
      /* drain */
    }

    expect(nagTurns(sentWire).length).toBeGreaterThanOrEqual(1);
    expect(waitNoticeTurns(sentWire)).toHaveLength(0);
  });

  test("等待期间仍在改文件：有新副作用进展 → 不算等待态，照常催", async () => {
    declareShellWait("ci-wait");
    const { loopConfig, sentWire } = makeHarness({
      turns: 20,
      todos: [todo("等 CI 结果", "in_progress")],
      toolName: "edit", // 每轮都有真实落盘副作用
    });
    for await (const _ of queryLoop(loopConfig)) {
      /* drain */
    }

    expect(nagTurns(sentWire).length).toBeGreaterThanOrEqual(1);
  });
});
