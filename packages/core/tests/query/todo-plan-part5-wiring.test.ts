/**
 * 进度清单横向剖析第五部分：事件字段接线测试（驱动真实 queryLoop）
 *
 * 单测（todo-rework.test.ts）只证明纯函数算得对；这里证明字段真的进了 trace 事件。
 * 变异自证：删掉 loop.ts 里 `...reworkEventData(rework.hits)`，T1 用例必须变红。
 */

import { describe, test, expect } from "bun:test";
import { queryLoop } from "@sid-code/core/query/loop.ts";
import type { QueryLoopConfig } from "@sid-code/core/query/loop.ts";
import type { QueryDeps } from "@sid-code/core/query/types.ts";
import { Manager as ContextManager } from "@sid-code/core/context/manager.ts";
import { Registry as ToolRegistry } from "@sid-code/core/tool/registry.ts";
import { ModelFallback } from "@sid-code/core/llm/fallback.ts";
import { SessionState } from "@sid-code/core/session/state.ts";
import type { Config } from "@sid-code/core/config/config.ts";
import type { StreamEvent, AccumulatedResponse } from "@sid-code/core/llm/types.ts";
import type { TodoItem } from "@sid-code/core/tool/todo-write.ts";
import { createAgentTask } from "@sid-code/core/task/agent-task.ts";
import { getTask } from "@sid-code/core/task/registry.ts";
import { __resetForTest as __resetQueueForTest } from "@sid-code/core/query/message-queue-manager.ts";

async function* emptyStream(): AsyncIterable<StreamEvent> {}

const FILE = "/tmp/sid-rework-wiring/a.ts";

function editResp(id: string): AccumulatedResponse {
  return {
    role: "assistant",
    content: [
      {
        type: "tool_use",
        id,
        name: "edit",
        input: { file_path: FILE, old_string: "a", new_string: "b" },
      },
    ],
    stopReason: "tool_use",
    usage: { inputTokens: 100, outputTokens: 5 },
  } as AccumulatedResponse;
}

function finalResp(): AccumulatedResponse {
  return {
    role: "assistant",
    content: [{ type: "text", text: "好了" }],
    stopReason: "end_turn",
    usage: { inputTokens: 100, outputTokens: 5 },
  } as AccumulatedResponse;
}

const t = (content: string, status: TodoItem["status"]): TodoItem => ({
  content,
  activeForm: content,
  status,
});

async function drain(cfg: QueryLoopConfig): Promise<void> {
  for await (const _ of queryLoop(cfg)) {
    /* 只关心副作用（trace 事件） */
  }
}

describe("TodoReworkDetected 接线（T1）", () => {
  test("标 completed 后再改同一文件 → 事件带 hits/hitCount", async () => {
    const ctxMgr = new ContextManager({ maxTokens: 200000 });
    ctxMgr.setSystemPrompt("test");
    ctxMgr.addMessage({ role: "user", content: [{ type: "text", text: "改个文件" }] });

    // 第 1 次 edit 之后模型把「改 a」标成 completed（模拟同一轮里的 todo_write）
    let todoState = { todos: [t("改 a", "in_progress"), t("验证", "pending")], writeVersion: 1 };
    const responses = [editResp("e1"), editResp("e2"), finalResp()];
    let call = 0;
    let execCount = 0;
    const events: Array<{ event: string; data: any }> = [];

    const deps: QueryDeps = {
      sendWithRetry: () => emptyStream(),
      processStream: async () => responses[call++] ?? finalResp(),
      executeTools: async (content: any[]) => {
        execCount++;
        if (execCount === 1) {
          todoState = {
            todos: [t("改 a", "completed"), t("验证", "in_progress")],
            writeVersion: 2,
          };
        }
        return {
          results: content
            .filter((b: any) => b.type === "tool_use")
            .map((b: any) => ({ type: "tool_result" as const, tool_use_id: b.id, content: "ok" })),
        };
      },
      autoCompact: async () => ({ kind: "skipped" as const }),
      getAbortSignal: () => undefined,
      uuid: () => "uuid-test",
      getTodoState: () => todoState,
      traceAppendEvent: (e: any) => {
        events.push({ event: e.event, data: e.data });
      },
    };

    await drain({
      config: {
        model: "deepseek-v4-pro",
        provider: "openai",
        maxTurns: 10,
        toolSearch: false,
      } as unknown as Config,
      ctxMgr,
      toolRegistry: new ToolRegistry(),
      sessionState: new SessionState("test-rework-wiring"),
      fallback: new ModelFallback(),
      deps,
    });

    const rework = events.filter((e) => e.event === "TodoReworkDetected");
    expect(rework.length).toBe(1);
    expect(rework[0]!.data.hitCount).toBe(1);
    expect(rework[0]!.data.hits).toEqual([{ item: "改 a", file: FILE }]);
  });
});

describe("todo_gate 排除后台任务（T2）", () => {
  function setup() {
    const ctxMgr = new ContextManager({ maxTokens: 200000 });
    ctxMgr.setSystemPrompt("test");
    ctxMgr.addMessage({ role: "user", content: [{ type: "text", text: "跑 CI" }] });
    const events: Array<{ event: string; data: any }> = [];
    const outputs: string[] = [];
    const deps: QueryDeps = {
      sendWithRetry: () => emptyStream(),
      processStream: async () => finalResp(),
      executeTools: async () => ({ results: [] }),
      autoCompact: async () => ({ kind: "skipped" as const }),
      getAbortSignal: () => undefined,
      uuid: () => "uuid-test",
      getTodoState: () => ({
        todos: [t("改代码", "completed"), t("等 CI 通过", "in_progress")],
        writeVersion: 1,
      }),
      traceAppendEvent: (e: any) => {
        events.push({ event: e.event, data: e.data });
      },
    };
    const cfg: QueryLoopConfig = {
      config: {
        model: "deepseek-v4-pro",
        provider: "openai",
        maxTurns: 10,
        toolSearch: false,
      } as unknown as Config,
      ctxMgr,
      toolRegistry: new ToolRegistry(),
      sessionState: new SessionState("test-bg-gate"),
      fallback: new ModelFallback(),
      deps,
    };
    return { cfg, events, outputs };
  }
  const gateRetries = (events: Array<{ event: string; data: any }>) =>
    events.filter((e) => e.event === "LoopTransition" && e.data?.type === "todo_gate_retry").length;

  test("有运行中的后台任务 → 不发 todo_gate_retry；任务结束后照常拦", async () => {
    __resetQueueForTest();
    const { taskState } = createAgentTask({
      agentType: "explore",
      prompt: "跑 CI",
      description: "CI",
      isBackgrounded: true,
    });
    try {
      const a = setup();
      await drain(a.cfg);
      expect(gateRetries(a.events)).toBe(0);
    } finally {
      const task = getTask(taskState.id);
      if (task) task.status = "completed";
      __resetQueueForTest();
    }

    const b = setup();
    await drain(b.cfg);
    expect(gateRetries(b.events)).toBeGreaterThan(0);
  });
});

describe("清单防线开关（T3）", () => {
  function withEnv(key: string, fn: () => Promise<void>) {
    return async () => {
      const prev = process.env[key];
      process.env[key] = "1";
      try {
        await fn();
      } finally {
        if (prev === undefined) delete process.env[key];
        else process.env[key] = prev;
      }
    };
  }

  test(
    "SID_DISABLE_TODO_GATE=1 → 有未完成项也不发 todo_gate_retry",
    withEnv("SID_DISABLE_TODO_GATE", async () => {
      const ctxMgr = new ContextManager({ maxTokens: 200000 });
      ctxMgr.setSystemPrompt("test");
      ctxMgr.addMessage({ role: "user", content: [{ type: "text", text: "干活" }] });
      const events: Array<{ event: string; data: any }> = [];
      await drain({
        config: {
          model: "deepseek-v4-pro",
          provider: "openai",
          maxTurns: 10,
          toolSearch: false,
        } as unknown as Config,
        ctxMgr,
        toolRegistry: new ToolRegistry(),
        sessionState: new SessionState("test-gate-off"),
        fallback: new ModelFallback(),
        deps: {
          sendWithRetry: () => emptyStream(),
          processStream: async () => finalResp(),
          executeTools: async () => ({ results: [] }),
          autoCompact: async () => ({ kind: "skipped" as const }),
          getAbortSignal: () => undefined,
          uuid: () => "uuid-test",
          getTodoState: () => ({ todos: [t("改代码", "in_progress")], writeVersion: 1 }),
          traceAppendEvent: (e: any) => events.push({ event: e.event, data: e.data }),
        } as QueryDeps,
      });
      expect(
        events.filter((e) => e.event === "LoopTransition" && e.data?.type === "todo_gate_retry")
          .length,
      ).toBe(0);
    }),
  );

  test(
    "SID_DISABLE_TODO_REWORK=1 → 提醒不进发送副本，事件照发且带 suppressed",
    withEnv("SID_DISABLE_TODO_REWORK", async () => {
      const ctxMgr = new ContextManager({ maxTokens: 200000 });
      ctxMgr.setSystemPrompt("test");
      ctxMgr.addMessage({ role: "user", content: [{ type: "text", text: "改个文件" }] });
      let todoState = { todos: [t("改 a", "in_progress"), t("验证", "pending")], writeVersion: 1 };
      const responses = [editResp("e1"), editResp("e2"), finalResp()];
      let call = 0;
      let exec = 0;
      const events: Array<{ event: string; data: any }> = [];
      const wire: string[] = [];
      await drain({
        config: {
          model: "deepseek-v4-pro",
          provider: "openai",
          maxTurns: 10,
          toolSearch: false,
        } as unknown as Config,
        ctxMgr,
        toolRegistry: new ToolRegistry(),
        sessionState: new SessionState("test-rework-off"),
        fallback: new ModelFallback(),
        deps: {
          sendWithRetry: (params: any) => {
            wire.push(JSON.stringify(params?.messages ?? []));
            return emptyStream();
          },
          processStream: async () => responses[call++] ?? finalResp(),
          executeTools: async (content: any[]) => {
            exec++;
            if (exec === 1)
              todoState = {
                todos: [t("改 a", "completed"), t("验证", "in_progress")],
                writeVersion: 2,
              };
            return {
              results: content
                .filter((b: any) => b.type === "tool_use")
                .map((b: any) => ({
                  type: "tool_result" as const,
                  tool_use_id: b.id,
                  content: "ok",
                })),
            };
          },
          autoCompact: async () => ({ kind: "skipped" as const }),
          getAbortSignal: () => undefined,
          uuid: () => "uuid-test",
          getTodoState: () => todoState,
          traceAppendEvent: (e: any) => events.push({ event: e.event, data: e.data }),
        } as QueryDeps,
      });
      const rework = events.filter((e) => e.event === "TodoReworkDetected");
      expect(rework.length).toBe(1);
      expect(rework[0]!.data.suppressed).toBe(true);
      expect(wire.some((w) => w.includes("已标 completed，但你随后又修改了"))).toBe(false);
    }),
  );
});

describe("TodoProgressAdvanced 推进量字段（T7）", () => {
  test("只改措辞的第二次写入 → completedDelta=0、contentChanged=true", async () => {
    const ctxMgr = new ContextManager({ maxTokens: 200000 });
    ctxMgr.setSystemPrompt("test");
    ctxMgr.addMessage({ role: "user", content: [{ type: "text", text: "干活" }] });
    let todoState = { todos: [t("改 a", "completed"), t("验证", "in_progress")], writeVersion: 1 };
    const responses = [editResp("e1"), finalResp()];
    let call = 0;
    const events: Array<{ event: string; data: any }> = [];
    await drain({
      config: {
        model: "deepseek-v4-pro",
        provider: "openai",
        maxTurns: 10,
        toolSearch: false,
      } as unknown as Config,
      ctxMgr,
      toolRegistry: new ToolRegistry(),
      sessionState: new SessionState("test-progress-delta"),
      fallback: new ModelFallback(),
      deps: {
        sendWithRetry: () => emptyStream(),
        processStream: async () => responses[call++] ?? finalResp(),
        executeTools: async (content: any[]) => {
          todoState = {
            todos: [t("改 a", "completed"), t("跑测试验证", "in_progress")],
            writeVersion: 2,
          };
          return {
            results: content
              .filter((b: any) => b.type === "tool_use")
              .map((b: any) => ({
                type: "tool_result" as const,
                tool_use_id: b.id,
                content: "ok",
              })),
          };
        },
        autoCompact: async () => ({ kind: "skipped" as const }),
        getAbortSignal: () => undefined,
        uuid: () => "uuid-test",
        getTodoState: () => todoState,
        traceAppendEvent: (e: any) => events.push({ event: e.event, data: e.data }),
      } as QueryDeps,
    });
    const adv = events.filter((e) => e.event === "TodoProgressAdvanced");
    expect(adv.length).toBe(2);
    expect(adv[0]!.data).toMatchObject({ completedDelta: 1, contentChanged: true });
    expect(adv[1]!.data).toMatchObject({ completedDelta: 0, contentChanged: true });
  });
});
