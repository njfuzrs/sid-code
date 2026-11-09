/**
 * 闸门用例的共用驱动（FIX-3 提取，T-W2-* 复用）。
 *
 * 为什么需要它：T-W2-3/5/8 验的是 queryLoop 收尾链上的 T2 分支（end_turn 时「有带承诺的
 * 等待源就放行，不续命」）。直调内部函数绕过入口测不到真相——`promisedWaits` 是循环里
 * 现算的、reminder 写进 SessionState 的时机也在循环内。这里只 mock 模型这一层
 * （`sendWithRetry` / `processStream`），其余走真实 queryLoop。
 *
 * 等待源**不 mock**：`listWaits()` 是模块级单例，测试用真实的
 * `registerTask` + `registerWait` 构造，T2 判据才真的被验证。每个用例在 beforeEach /
 * afterEach 里清（见 `todo-gate-wait-sources.test.ts`）。
 *
 * 从真实入口进、不直调内部函数（方案 §5.1 的落点纪律）。
 */
import { queryLoop } from "@sid-code/core/query/loop.ts";
import type { QueryLoopConfig } from "@sid-code/core/query/loop.ts";
import type { QueryDeps } from "@sid-code/core/query/types.ts";
import { Manager as ContextManager } from "@sid-code/core/context/manager.ts";
import { Registry as ToolRegistry } from "@sid-code/core/tool/registry.ts";
import { ModelFallback } from "@sid-code/core/llm/fallback.ts";
import { SessionState } from "@sid-code/core/session/state.ts";
import type { Config } from "@sid-code/core/config/config.ts";
import type { AccumulatedResponse, Message, StreamEvent } from "@sid-code/core/llm/types.ts";
import type { TodoItem } from "@sid-code/core/tool/todo-write.ts";

/** 一次 run 的可观测结果 */
export interface GateRunResult {
  /** 本轮 yield 出的 `{kind:"system"}` 文案（断言「没有旧瞬态状态条」用） */
  systemTexts: string[];
  /** 真正调了几次模型（T2 放行 = 1，被续命 = 1 + MAX_TODO_GATE_RETRIES） */
  llmCalls: number;
  /** 每次请求实际发给模型的 messages（含 reminder 注入后的形态） */
  requests: Message[][];
}

export interface GateHarness {
  run(): Promise<GateRunResult>;
  /** 与 queryLoop 同一个实例：跨 run 的 reminder / 续命预算都读它 */
  sessionState: SessionState;
  setTodos(todos: TodoItem[]): void;
}

export interface GateHarnessOptions {
  todos: TodoItem[];
  /** 依次取用的模型响应；用尽后回落到「正常文本收尾」 */
  responses?: AccumulatedResponse[];
  userText?: string;
}

function makeConfig(): Config {
  return {
    model: "claude-opus-4-8",
    provider: "anthropic",
    maxTurns: 20,
    maxTokens: 128000,
  } as unknown as Config;
}

async function* emptyStream(): AsyncIterable<StreamEvent> {
  /* processStream 被 mock，流本身不消费 */
}

/** 正常文本收尾（无 tool_use、stopReason=end_turn），会走到收尾闸门链 */
function endTurnResp(text = "已启动监控，结果会以通知送达。"): AccumulatedResponse {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    stopReason: "end_turn",
    usage: { inputTokens: 100, outputTokens: 20 },
  } as AccumulatedResponse;
}

export function makeGateHarness(opts: GateHarnessOptions): GateHarness {
  // 跨 run 共用：reminder（WAIT_SOURCES_REMINDER_KEY）与续命预算（TODO_GATE_BUDGET_KEY）
  // 都是会话级事实，换新实例就测不出「第二次不重复注入」
  const sessionState = new SessionState("test-gate-harness");
  let todos = opts.todos;
  let writeVersion = 1;
  const responses = opts.responses ?? [];

  return {
    sessionState,
    setTodos(t) {
      todos = t;
      writeVersion++;
    },
    async run(): Promise<GateRunResult> {
      const ctxMgr = new ContextManager({ maxTokens: 200000 });
      ctxMgr.setSystemPrompt("test");
      ctxMgr.addMessage({
        role: "user",
        content: [{ type: "text", text: opts.userText ?? "请按计划推进" }],
      });

      const requests: Message[][] = [];
      const systemTexts: string[] = [];
      let llmCalls = 0;

      const deps: QueryDeps = {
        sendWithRetry: (params) => {
          requests.push(params.messages);
          return emptyStream();
        },
        processStream: async () => {
          const r = responses[llmCalls] ?? endTurnResp();
          llmCalls++;
          return r;
        },
        executeTools: async () => ({ results: [] }),
        autoCompact: async () => ({ kind: "skipped" as const }),
        getAbortSignal: () => undefined,
        uuid: () => "uuid-gate-harness",
        getTodoState: () => ({ todos, writeVersion }),
      };

      const loopConfig: QueryLoopConfig = {
        config: makeConfig(),
        ctxMgr,
        toolRegistry: new ToolRegistry(),
        sessionState,
        fallback: new ModelFallback(),
        deps,
      };

      for await (const ev of queryLoop(loopConfig)) {
        if (ev.kind === "system" && "text" in ev) systemTexts.push((ev as { text: string }).text);
      }
      return { systemTexts, llmCalls, requests };
    },
  };
}
