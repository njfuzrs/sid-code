/**
 * 无进展只读命令止损阀 —— queryLoop 消费端集成测试（方向 2/4/6）
 *
 * 背景（根因分析-commit任务git状态快照冻结死循环.md，会话 20260710-164407）：
 * 模型在已干净的工作区上反复空跑 `git status --short` 11 轮直到用户 ESC。此测试驱动真实
 * queryLoop，让模型每轮都发一个"内容完全相同、输出为空"的 git status tool_use，验证：
 *   1. 连续相同空跑达阈值后，loop 注入一条携带"实时状态/收尾锚点"的收敛提醒 user 消息；
 *   2. 提醒仍无效（继续空跑）时，loop 最终强制 yield done 收尾，而非无限打转；
 *   3. 中途一旦出现写操作/文本产出（有进展），计数清零、不误触发。
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
import type { StreamEvent, AccumulatedResponse } from "../../src/llm/types.ts";
import { STUCK_REPEAT_THRESHOLD, MAX_STUCK_REMINDERS } from "../../src/query/repeated-readonly-guard.ts";

function makeConfig(): Config {
  return { model: "deepseek-v4-pro", provider: "openai", maxTurns: 30 } as unknown as Config;
}

async function* emptyStream(): AsyncIterable<StreamEvent> {}

/** 一个"只发 git status tool_use、无文本"的响应（模拟空跑探查）。 */
function gitStatusResp(id: string): AccumulatedResponse {
  return {
    role: "assistant",
    content: [{ type: "tool_use", id, name: "bash", input: { command: "git status --short" } }],
    stopReason: "tool_use",
    usage: { inputTokens: 100, outputTokens: 5 },
  } as AccumulatedResponse;
}

/** 一个写操作 tool_use（模拟"有进展"）。 */
function commitResp(id: string): AccumulatedResponse {
  return {
    role: "assistant",
    content: [{ type: "tool_use", id, name: "bash", input: { command: "git commit -m x" } }],
    stopReason: "tool_use",
    usage: { inputTokens: 100, outputTokens: 5 },
  } as AccumulatedResponse;
}

function normalResp(text: string): AccumulatedResponse {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    stopReason: "end_turn",
    usage: { inputTokens: 100, outputTokens: 20 },
  } as AccumulatedResponse;
}

/** 构造 loop harness：executeTools 恒返回空输出的 tool_result（模拟工作区已干净）。 */
function makeLoopConfig(
  responses: AccumulatedResponse[],
  toolOutput = "(命令无输出)",
): { loopConfig: QueryLoopConfig; ctxMgr: ContextManager; sentReminders: string[] } {
  const ctxMgr = new ContextManager({ maxTokens: 200000 });
  ctxMgr.setSystemPrompt("test");
  ctxMgr.addMessage({ role: "user", content: [{ type: "text", text: "帮我提交所有改动" }] });

  // 捕获每轮发送给 LLM 的消息里注入的 system-reminder 文本。
  // remind 走 reminderParts → injectReminders(finalMessages)，注入到**发送副本**而非落历史，
  // 故必须从 sendWithRetry 的入参 messages 抓，而非从 ctxMgr.getMessages()。
  const sentReminders: string[] = [];

  let call = 0;
  const deps: QueryDeps = {
    sendWithRetry: (params: any) => {
      for (const m of params?.messages ?? []) {
        if (m.role !== "user" || !Array.isArray(m.content)) continue;
        for (const b of m.content) {
          if (b.type === "text" && typeof b.text === "string" && b.text.includes("<system-reminder>")) {
            sentReminders.push(b.text);
          }
        }
      }
      return emptyStream();
    },
    processStream: async () => {
      const r = responses[call] ?? normalResp("已完成");
      call++;
      return r;
    },
    // 依据入参 tool_use 回配对的 tool_result，输出恒定（模拟反复查同一个稳定状态）。
    executeTools: async (content) => {
      const results = content
        .filter((b: any) => b.type === "tool_use")
        .map((b: any) => ({ type: "tool_result" as const, tool_use_id: b.id, content: toolOutput }));
      return { results };
    },
    autoCompact: async () => {},
    handleContextOverflow: () => null,
    getAbortSignal: () => undefined,
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
  return { loopConfig, ctxMgr, sentReminders };
}

/** 从 ctxMgr 历史抽出所有 system-reminder 文本（用于验证 terminate 的直插 notice）。 */
function injectedReminderTexts(ctxMgr: ContextManager): string[] {
  const out: string[] = [];
  for (const m of ctxMgr.getMessages()) {
    if (m.role !== "user" || !Array.isArray(m.content)) continue;
    for (const b of m.content as any[]) {
      if (b.type === "text" && typeof b.text === "string" && b.text.includes("<system-reminder>")) {
        out.push(b.text);
      }
    }
  }
  return out;
}

describe("无进展只读命令止损阀（queryLoop 集成）", () => {
  test("连续空跑 git status → 注入实时状态收敛提醒 → 最终强制收尾", async () => {
    // 全程都发相同的 git status（空输出），远超阈值 + 提醒上限。
    const responses = Array.from({ length: 20 }, (_, i) => gitStatusResp(`t${i}`));
    const { loopConfig, ctxMgr, sentReminders } = makeLoopConfig(responses, "(命令无输出)");

    const kinds: string[] = [];
    const systemTexts: string[] = [];
    for await (const ev of queryLoop(loopConfig)) {
      kinds.push(ev.kind);
      if (ev.kind === "system" && "text" in ev) systemTexts.push(ev.text);
    }

    // 收敛提醒经 reminderParts 注入到发送副本（非落历史）→ 从 sentReminders 抓。
    // 恰好注入 MAX_STUCK_REMINDERS 次（含"工作区已干净 / end_turn"终止锚点）。
    const convergenceReminders = sentReminders.filter(
      (t) => t.includes("反复执行相同的只读命令") || t.includes("连续多轮执行相同的只读命令"),
    );
    expect(convergenceReminders.length).toBe(MAX_STUCK_REMINDERS);
    expect(convergenceReminders.some((t) => t.includes("end_turn"))).toBe(true);

    // 强制收尾 notice 是终态、直插历史（无下一轮可注入）→ 从 ctxMgr 抓。
    const historyReminders = injectedReminderTexts(ctxMgr);
    expect(historyReminders.some((t) => t.includes("强制结束"))).toBe(true);
    expect(kinds).toContain("done");
    // 未跑满 30 轮 maxTurns —— 说明是被止损阀提前收尾，而非耗尽轮次。
    expect(systemTexts.some((t) => t.includes("强制结束") || t.includes("无限循环"))).toBe(true);
  });

  test("中途出现写操作（有进展）→ 计数清零，不触发止损", async () => {
    // 阈值-1 次空跑 → 一次 commit（有进展）→ 再几次空跑，均不足以再次达阈值 → 正常收尾。
    const responses = [
      ...Array.from({ length: STUCK_REPEAT_THRESHOLD - 1 }, (_, i) => gitStatusResp(`a${i}`)),
      commitResp("commit1"),
      ...Array.from({ length: STUCK_REPEAT_THRESHOLD - 1 }, (_, i) => gitStatusResp(`b${i}`)),
      normalResp("提交完成"),
    ];
    const { loopConfig, ctxMgr, sentReminders } = makeLoopConfig(responses, "(命令无输出)");

    const kinds: string[] = [];
    for await (const ev of queryLoop(loopConfig)) kinds.push(ev.kind);

    // 既不注入收敛提醒（发送副本），也不直插强制收尾（历史）。
    expect(sentReminders.some((t) => t.includes("只读命令"))).toBe(false);
    expect(injectedReminderTexts(ctxMgr).some((t) => t.includes("强制结束"))).toBe(false);
    expect(kinds).toContain("assistant_message");
    expect(kinds).toContain("done");
  });
});
