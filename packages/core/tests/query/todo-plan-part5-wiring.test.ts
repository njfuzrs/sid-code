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
