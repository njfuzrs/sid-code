/**
 * 回归测试：共享 AbortController 场景下 turn 级自我清理不得污染会话级取消检测
 *
 * 背景（P0 回归，见 docs/bugfixes/todo/orphan-stream-snapshot-watchdog-corruption-design.md）：
 *   Fix 3 曾在每轮 Promise.race 的 finally 里 **无条件** 调用
 *   deps.abortCurrentRequest("race-settled")。而生产环境 app.ts 里 getAbortSignal 与
 *   abortCurrentRequest 操作 **同一个** 会话级 AbortController（每条用户消息一个，贯穿
 *   整个 queryLoop 所有轮次）。于是：
 *     1. 第一轮正常返回 → finally abort 会话级 controller → signal.aborted = true
 *     2. loop.ts 的 A2 检测 getAbortSignal()?.aborted 命中 → yield「请求已被取消」+ return
 *     3. 任务在第一轮后就被误判为「用户取消」而中止（单轮 end_turn / 多轮 tool_use 均必现）
 *
 *   4851 个既有测试全过却没抓到它——因为 loop-watchdog 等测试把两个回调 **解耦**
 *   （getAbortSignal 返回 undefined，abortCurrentRequest 只 push 数组），没有复现生产中
 *   「二者共享同一 controller」的接线。本文件专门补上这个结构。
 *
 * 根治：每轮创建独立的「turn 级子 AbortController」，级联父（会话级）signal。turn 级
 *   中断（超时/看门狗/race settle 清理）只作用于子 controller，绝不回写会话级；父 signal
 *   （用户 ESC/会话超时）经 AbortSignal.any 级联下来仍能中断本轮。
 *
 * fix_type: case_design
 */

import { describe, test, expect } from "bun:test";
import { queryLoop } from "../../src/query/loop.ts";
import type { QueryLoopConfig } from "../../src/query/loop.ts";
import type { QueryDeps } from "../../src/query/types.ts";
import { Manager as ContextManager } from "../../src/context/manager.ts";
import { Registry as ToolRegistry } from "../../src/tool/registry.ts";
import { ModelFallback } from "../../src/llm/fallback.ts";
import { SessionState } from "../../src/session/state.ts";
import type { Config } from "../../src/config/config.ts";
import type { StreamEvent } from "../../src/llm/types.ts";

function makeConfig(): Config {
  return { model: "test-model", provider: "anthropic", maxTurns: 10 } as unknown as Config;
}

async function* emptyStream(): AsyncIterable<StreamEvent> {}

/**
 * 构造「共享 AbortController」的 loopConfig——精确复现 app.ts 的接线：
 * getAbortSignal 与 abortCurrentRequest 操作同一个会话级 controller。
 */
function makeSharedControllerLoopConfig(
  processStream: QueryDeps["processStream"],
  executeTools: QueryDeps["executeTools"],
): { loopConfig: QueryLoopConfig; controller: AbortController } {
  const controller = new AbortController();

  const ctxMgr = new ContextManager({ maxTokens: 200000 });
  ctxMgr.setSystemPrompt("test");
  ctxMgr.addMessage({ role: "user", content: [{ type: "text", text: "做点事" }] });

  const deps: QueryDeps = {
    sendWithRetry: () => emptyStream(),
    processStream,
    executeTools,
    autoCompact: async () => {},
    handleContextOverflow: () => null,
    // 关键：与 app.ts 一致，二者操作同一个共享 controller
    getAbortSignal: () => controller.signal,
    abortCurrentRequest: (reason) => {
      try { controller.abort(reason ?? "turn-timeout"); } catch { /* ignore */ }
    },
    uuid: () => "uuid-test",
  };

  const loopConfig: QueryLoopConfig = {
    config: makeConfig(),
    ctxMgr,
    toolRegistry: new ToolRegistry(),
    sessionState: new SessionState("test-session"),
    fallback: new ModelFallback(),
    deps,
  };
  return { loopConfig, controller };
}

describe("回归：共享 AbortController 下 turn 级清理不污染会话级取消", () => {
  test("单轮 end_turn：正常产出 assistant_message，不出现「请求已被取消」", async () => {
    const { loopConfig, controller } = makeSharedControllerLoopConfig(
      async () => ({
        role: "assistant" as const,
        content: [{ type: "text" as const, text: "你好，有什么可以帮你" }],
        stopReason: "end_turn" as const,
        usage: { inputTokens: 5, outputTokens: 2 },
      }),
      async () => ({ results: [] }),
    );

    const kinds: string[] = [];
    const systemTexts: string[] = [];
    for await (const ev of queryLoop(loopConfig)) {
      kinds.push(ev.kind);
      if (ev.kind === "system" && "text" in ev) systemTexts.push(ev.text);
    }

    // 核心断言：任务正常完成，未被误判为取消
    expect(systemTexts).not.toContain("请求已被取消");
    expect(kinds).toContain("assistant_message");
    expect(kinds).toContain("done");
    // 会话级 controller 未被 turn 级清理污染（正常完成不应 abort 会话级 signal）
    expect(controller.signal.aborted).toBe(false);
  }, 15_000);

  test("多轮 tool_use：第一轮工具调用后任务继续到 end_turn，而非被中止", async () => {
    let turnCall = 0;
    const { loopConfig, controller } = makeSharedControllerLoopConfig(
      async () => {
        turnCall++;
        if (turnCall === 1) {
          // 第一轮：模型返回 tool_use（未超时，Promise.race 由 processStream 分支正常 settle）
          return {
            role: "assistant" as const,
            content: [{ type: "tool_use" as const, id: "t1", name: "read", input: { file_path: "/tmp/x" } }],
            stopReason: "tool_use" as const,
            usage: { inputTokens: 5, outputTokens: 2 },
          };
        }
        // 第二轮：能走到这里即证明第一轮没被误判为 abort
        return {
          role: "assistant" as const,
          content: [{ type: "text" as const, text: "完成" }],
          stopReason: "end_turn" as const,
          usage: { inputTokens: 5, outputTokens: 2 },
        };
      },
      async () => ({
        results: [{ type: "tool_result" as const, tool_use_id: "t1", content: "ok", is_error: false }],
      }),
    );

    const kinds: string[] = [];
    const systemTexts: string[] = [];
    for await (const ev of queryLoop(loopConfig)) {
      kinds.push(ev.kind);
      if (ev.kind === "system" && "text" in ev) systemTexts.push(ev.text);
    }

    // 核心断言：第二轮 processStream 被调用（任务继续），而非在第一轮 tool_use 后就被打断
    expect(turnCall).toBe(2);
    expect(systemTexts).not.toContain("请求已被取消");
    expect(controller.signal.aborted).toBe(false);
  }, 15_000);

  test("父 signal（用户 ESC）在流式后被 abort：仍能优雅收尾为「请求已被取消」", async () => {
    // 复现真正的用户取消：processStream 返回后、A2 检测前，父 controller 已被 abort。
    // 这是 A2 检测「应当」触发的合法场景——验证根治没有把它一并压掉。
    const { loopConfig, controller } = makeSharedControllerLoopConfig(
      async () => {
        // 模拟用户在流式输出期间按了 ESC：直接 abort 会话级 controller
        controller.abort("user-cancel");
        return {
          role: "assistant" as const,
          content: [{ type: "tool_use" as const, id: "t1", name: "read", input: {} }],
          stopReason: "tool_use" as const,
          usage: { inputTokens: 5, outputTokens: 2 },
        };
      },
      async () => ({ results: [] }),
    );

    const systemTexts: string[] = [];
    let sawDone = false;
    for await (const ev of queryLoop(loopConfig)) {
      if (ev.kind === "system" && "text" in ev) systemTexts.push(ev.text);
      if (ev.kind === "done") sawDone = true;
    }

    // 用户真正取消时，A2 检测应命中并优雅收尾
    expect(systemTexts).toContain("请求已被取消");
    expect(sawDone).toBe(true);
  }, 15_000);
});
