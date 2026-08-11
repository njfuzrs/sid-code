/**
 * 循环恢复路径消息历史完整性测试 — 第四条孤儿来源（系统级查漏补缺方案）
 *
 * 真实 bug（2026-06-06 session 28b7eed7 21:28 崩溃）的路径：
 *   deepseek 连续等价工具调用 → ToolShapeLoopDetector/ToolCallLoopDetector 触发 →
 *   recoverFromLoop 注入纯 text 恢复提示并 continue → executeTools 被跳过 →
 *   assistant 的 tool_use 永远拿不到 tool_result → 孤儿 → 下一次发送 OpenAI 400。
 *
 * 本测试直接驱动**真实 queryLoop**（app.ts 运行时用的就是它，经 QueryEngine 消费），
 * 让 stopReason=tool_use 的轮次触发循环检测 → recoverFromLoop，
 * 再用 D1-4 共享不变量断言 ctxMgr 历史无孤儿（修复前必红，修复后必绿）。
 *
 * 同时覆盖发送前 backstop：即便恢复路径漏补，发送前关卡也会兜底。
 *
 * 注：原测试驱动已删除的 AgentLoopRunner（生产死代码）；迁移到 queryLoop 后，
 * 覆盖的是真实生产循环（queryLoop 的 recoverFromLoop + 发送前 backfillOrphanToolResults）。
 *
 * fix_type: core_code（L3，测试）
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
import type {
  StreamEvent,
  AccumulatedResponse,
  ContentBlock,
  Message,
} from "@sid-code/core/llm/types.ts";
import { checkMessageHistoryIntegrity } from "@sid-code/core/agent/message-invariants.ts";

function makeConfig(): Config {
  return { model: "mock-model", provider: "mock", maxTokens: 4096, maxTurns: 30 } as unknown as Config;
}

/** 空流：abort/循环路径下 processStream 产物由 mock 决定，stream 内容不重要 */
async function* emptyStream(): AsyncIterable<StreamEvent> {
  // 不 yield 任何事件
}

/**
 * processStream 每次返回**等价的** tool_use（同 name + 同 input），
 * 让循环检测在 tool_use 轮次必然触发。每次用新的 tool_use id 模拟真实模型行为
 * （真实模型每轮 id 不同，但 name/input 相同 → 触发 exact/shape 检测）。
 */
function makeLoopConfig(opts: {
  ctxMgr: ContextManager;
  toolName: string;
  toolInput: unknown;
  executeTools: QueryDeps["executeTools"];
}): QueryLoopConfig {
  let callIndex = 0;
  const processStream = async (): Promise<AccumulatedResponse> => {
    callIndex++;
    return {
      role: "assistant",
      content: [
        { type: "text", text: `第 ${callIndex} 次尝试` },
        { type: "tool_use", id: `call_${callIndex}`, name: opts.toolName, input: opts.toolInput },
      ],
      stopReason: "tool_use",
      usage: { inputTokens: 10, outputTokens: 5 },
    };
  };

  const deps: QueryDeps = {
    sendWithRetry: () => emptyStream(),
    processStream,
    executeTools: opts.executeTools,
    autoCompact: async () => {},
    handleContextOverflow: () => null,
    getAbortSignal: () => undefined,
    uuid: () => "uuid-test",
  };

  return {
    config: makeConfig(),
    ctxMgr: opts.ctxMgr,
    toolRegistry: new ToolRegistry(),
    sessionState: new SessionState("test-loop-recovery"),
    fallback: new ModelFallback(),
    deps,
  };
}

describe("第四条孤儿来源 — 循环恢复路径历史完整性", () => {
  test("循环检测在 tool_use 轮次触发 → recoverFromLoop 跳过 executeTools → 历史仍无孤儿", async () => {
    const ctxMgr = new ContextManager({ maxTokens: 100_000 });
    ctxMgr.setSystemPrompt("test");
    ctxMgr.addMessage({ role: "user", content: [{ type: "text", text: "反复搜索一个不存在的字符串" }] });

    // executeTools 正常返回（让循环能多轮累积，直到检测器触发）
    const executeTools = async (content: ContentBlock[]) => {
      const results: ContentBlock[] = content
        .filter((b): b is Extract<ContentBlock, { type: "tool_use" }> => b.type === "tool_use")
        .map(b => ({ type: "tool_result" as const, tool_use_id: b.id, content: "未找到匹配的内容" }));
      return { results };
    };

    // 等价的重复 bash 调用（复刻崩溃现场：反复 rg 同一目标）
    const loopConfig = makeLoopConfig({
      ctxMgr,
      toolName: "bash",
      toolInput: { command: "rg escape src/ui", description: "搜索" },
      executeTools,
    });

    for await (const _ev of queryLoop(loopConfig)) {
      // drain：跑到 done（恢复耗尽 continue 放行或 max_turns）
    }

    // 关键不变量：无论循环检测在哪一轮触发、是否跳过 executeTools，
    // 最终 ctxMgr 历史都不能残留孤儿 tool_use（否则下一次发送即 400）。
    const messages: Message[] = ctxMgr.getMessages();
    const integrity = checkMessageHistoryIntegrity(messages);
    expect(integrity.intact).toBe(true);
    expect(integrity.orphans).toHaveLength(0);

    // 同时不能出现相邻同角色（恢复占位合并不破坏交替）
    for (let i = 1; i < messages.length; i++) {
      expect(messages[i].role).not.toBe(messages[i - 1].role);
    }
  });

  test("多轮工具调用全程无 400 成因：每条 assistant tool_use 都有应答", async () => {
    const ctxMgr = new ContextManager({ maxTokens: 100_000 });
    ctxMgr.setSystemPrompt("test");
    ctxMgr.addMessage({ role: "user", content: [{ type: "text", text: "查找" }] });

    const executeTools = async (content: ContentBlock[]) => {
      const results: ContentBlock[] = content
        .filter((b): b is Extract<ContentBlock, { type: "tool_use" }> => b.type === "tool_use")
        .map(b => ({ type: "tool_result" as const, tool_use_id: b.id, content: "ok" }));
      return { results };
    };

    const loopConfig = makeLoopConfig({
      ctxMgr,
      toolName: "grep",
      toolInput: { pattern: "escape", path: "src/ui" },
      executeTools,
    });

    for await (const _ev of queryLoop(loopConfig)) {
      // drain
    }

    // 收集所有 assistant.tool_use id 与所有 tool_result id，断言前者 ⊆ 后者
    const messages = ctxMgr.getMessages();
    const useIds = new Set<string>();
    const resultIds = new Set<string>();
    for (const m of messages) {
      for (const b of m.content) {
        if (b.type === "tool_use") useIds.add(b.id);
        if (b.type === "tool_result") resultIds.add(b.tool_use_id);
      }
    }
    for (const id of useIds) {
      expect(resultIds.has(id)).toBe(true);
    }
  });
});
