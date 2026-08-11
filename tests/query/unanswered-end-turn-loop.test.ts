/**
 * 场景 (c)：无 todo 时连续 end_turn 空手收尾 —— queryLoop 消费端集成测试
 * （方案②，deepseek-reasoning-leak 修复）
 *
 * 背景（例③「重试无反应」机制级根因）：模型陷入思考发散、思考漂移进 content 通道，
 * 每轮都以「_unansweredEndTurn=true + 无 tool_use」空手 end_turn。此前完成度校验/重试链
 * 全以 todo 存在为前提，模型从不建 todo → unfinished===0 → end_turn 顺利放行 → 用户
 * 「请你修复」重试 N 次每次都没反应。
 *
 * 本测试验证 loop 消费端（前面的 unanswered-end-turn.test.ts 只测了纯函数置位逻辑）：
 *   1. deps.getTodoState 缺失（模型从不建 todo）时，方案② 仍能独立触发；
 *   2. 连续未答复轮被软续命 MAX_UNANSWERED_RETRIES 次（回注收敛提示 + system 警告）；
 *   3. 续命耗尽后如实放行（不假装完成，给出可操作的兜底建议），不无限打转；
 *   4. 中途一旦模型正常答复（无 _unansweredEndTurn），续命计数清零、正常收尾。
 *
 * fix_type: case_design
 */

import { describe, test, expect } from "bun:test";
import { queryLoop } from "@sid-code/core/query/loop.ts";
import type { QueryLoopConfig } from "@sid-code/core/query/loop.ts";
import type { QueryDeps } from "@sid-code/core/query/types.ts";
import { MAX_UNANSWERED_RETRIES } from "@sid-code/core/query/todo-reminder.ts";
import { Manager as ContextManager } from "@sid-code/core/context/manager.ts";
import { Registry as ToolRegistry } from "@sid-code/core/tool/registry.ts";
import { ModelFallback } from "@sid-code/core/llm/fallback.ts";
import { SessionState } from "@sid-code/core/session/state.ts";
import type { Config } from "@sid-code/core/config/config.ts";
import type { StreamEvent, AccumulatedResponse } from "@sid-code/core/llm/types.ts";

function makeConfig(): Config {
  return { model: "deepseek-v4-pro", provider: "openai", maxTurns: 20 } as unknown as Config;
}

async function* emptyStream(): AsyncIterable<StreamEvent> {
  /* processStream 被 mock，此处不产事件 */
}

/** 构造一个「思考漂移进正文、空手 end_turn」的响应（模拟 stream-processor 已置位 _unansweredEndTurn） */
function unansweredResp(text: string): AccumulatedResponse {
  return {
    role: "assistant",
    content: [{ type: "thinking", thinking: text }], // 折叠思考块，无 text / 无 tool_use
    stopReason: "end_turn",
    usage: { inputTokens: 100, outputTokens: 0 },
    _unansweredEndTurn: true,
  } as AccumulatedResponse;
}

/** 构造一个正常答复的响应 */
function normalResp(text: string): AccumulatedResponse {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    stopReason: "end_turn",
    usage: { inputTokens: 100, outputTokens: 20 },
  } as AccumulatedResponse;
}

function makeLoopConfig(
  responses: AccumulatedResponse[],
  overrides: Partial<QueryDeps> = {},
): { loopConfig: QueryLoopConfig; ctxMgr: ContextManager } {
  const ctxMgr = new ContextManager({ maxTokens: 200000 });
  ctxMgr.setSystemPrompt("test");
  ctxMgr.addMessage({ role: "user", content: [{ type: "text", text: "请你修复这个问题" }] });

  let call = 0;
  const deps: QueryDeps = {
    sendWithRetry: () => emptyStream(),
    // 依次吐出预设响应；超出则退化为正常收尾，避免无限循环
    processStream: async () => {
      const r = responses[call] ?? normalResp("已完成");
      call++;
      return r;
    },
    executeTools: async () => ({ results: [] }),
    autoCompact: async () => {},
    handleContextOverflow: () => null,
    getAbortSignal: () => undefined,
    uuid: () => "uuid-test",
    // 注意：故意不提供 getTodoState —— 模拟「模型从不建 todo」
    ...overrides,
  };

  const loopConfig: QueryLoopConfig = {
    config: makeConfig(),
    ctxMgr,
    toolRegistry: new ToolRegistry(),
    sessionState: new SessionState("test-session"),
    fallback: new ModelFallback(),
    deps,
  };
  return { loopConfig, ctxMgr };
}

describe("场景 (c) — 无 todo 连续 end_turn 空手收尾（queryLoop 集成）", () => {
  test("无 getTodoState 时，连续未答复被软续命 MAX_UNANSWERED_RETRIES 次后如实放行", async () => {
    // 全程都是「未答复的 end_turn」——模拟例③模型每轮都吐思考、空手收尾
    const responses = Array.from({ length: 10 }, (_, i) =>
      unansweredResp(`Let me analyze the trace once more... round ${i} `.repeat(60)),
    );
    const { loopConfig, ctxMgr } = makeLoopConfig(responses);

    const systemTexts: string[] = [];
    const kinds: string[] = [];
    for await (const ev of queryLoop(loopConfig)) {
      kinds.push(ev.kind);
      if (ev.kind === "system" && "text" in ev) systemTexts.push(ev.text);
    }

    // 软续命提示恰好出现 MAX_UNANSWERED_RETRIES 次（第 1..MAX 轮回注重试）
    const retryHints = systemTexts.filter((t) => t.includes("自动引导重新推进"));
    expect(retryHints.length).toBe(MAX_UNANSWERED_RETRIES);

    // 续命耗尽后如实放行：给出可操作建议，不假装完成
    expect(systemTexts.some((t) => t.includes("未产出有效答复") && t.includes("切换模型"))).toBe(true);

    // 最终正常交还控制权（done），而非无限打转
    expect(kinds).toContain("done");

    // 机制核对：回注了 MAX 条收敛提示 user 消息（不依赖 todo）
    const injected = ctxMgr
      .getMessages()
      .filter(
        (m) =>
          m.role === "user" &&
          Array.isArray(m.content) &&
          m.content.some(
            (b: any) => b.type === "text" && typeof b.text === "string" && b.text.includes("没有产出面向用户的有效答复"),
          ),
      );
    expect(injected.length).toBe(MAX_UNANSWERED_RETRIES);
  });

  test("中途模型恢复正常答复 → 续命计数清零，正常收尾（不触发耗尽提示）", async () => {
    // 前 1 轮未答复（触发 1 次续命），第 2 轮正常答复
    const responses = [
      unansweredResp("Hmm, let me reconsider the whole thing... ".repeat(60)),
      normalResp("问题已定位并修复：根因是 X，改动在 Y。"),
    ];
    const { loopConfig } = makeLoopConfig(responses);

    const systemTexts: string[] = [];
    const kinds: string[] = [];
    for await (const ev of queryLoop(loopConfig)) {
      kinds.push(ev.kind);
      if (ev.kind === "system" && "text" in ev) systemTexts.push(ev.text);
    }

    // 恰好 1 次续命提示（第 1 轮），随后模型正常答复
    expect(systemTexts.filter((t) => t.includes("自动引导重新推进")).length).toBe(1);
    // 未走到「续命耗尽」分支
    expect(systemTexts.some((t) => t.includes("切换模型"))).toBe(false);
    // 正常收尾
    expect(kinds).toContain("assistant_message");
    expect(kinds).toContain("done");
  });

  test("正常答复从一开始 → 不触发任何未答复续命", async () => {
    const { loopConfig } = makeLoopConfig([normalResp("直接给出答复")]);

    const systemTexts: string[] = [];
    for await (const ev of queryLoop(loopConfig)) {
      if (ev.kind === "system" && "text" in ev) systemTexts.push(ev.text);
    }
    expect(systemTexts.some((t) => t.includes("自动引导重新推进"))).toBe(false);
    expect(systemTexts.some((t) => t.includes("切换模型"))).toBe(false);
  });
});
