/**
 * 发现 3a/3c（20261020-110542-ce7ea52e 会话评估）：压缩成败判据同源。
 *
 * hard 档的渐进管道第一步 toolResultBudget 是**原地替换**（消息数不变），而 hard 分支随后
 * 无条件追加一条边界消息 ⇒ 旧判据「after < before」恒为 +1、恒判 false。实测 input
 * 865,039 → 250,055 却报 success:false：不画横幅、不调 notifyCompaction，缓存脱落被误归因。
 *
 * 本文件走真实 queryLoop：构造一份落在 hard 档、但只靠原地截断就能压下去的历史，断言
 * CompactionAttempt{trigger:threshold_hard} 为 success:true、带 savedTokens>0，且画了横幅。
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { queryLoop } from "@sid-code/core/query/loop.ts";
import type { QueryLoopConfig } from "@sid-code/core/query/loop.ts";
import type { QueryDeps } from "@sid-code/core/query/types.ts";
import { Manager as ContextManager } from "@sid-code/core/context/manager.ts";
import { Registry as ToolRegistry } from "@sid-code/core/tool/registry.ts";
import { ModelFallback } from "@sid-code/core/llm/fallback.ts";
import { SessionState } from "@sid-code/core/session/state.ts";
import type { Config } from "@sid-code/core/config/config.ts";
import type { AccumulatedResponse, Message } from "@sid-code/core/llm/types.ts";

let tmpRoot = "";
const savedTmp = process.env.SID_CODE_TMPDIR;
beforeAll(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), "sid-compact-same-src-"));
  process.env.SID_CODE_TMPDIR = tmpRoot;
});
afterAll(() => {
  if (savedTmp === undefined) delete process.env.SID_CODE_TMPDIR;
  else process.env.SID_CODE_TMPDIR = savedTmp;
  rmSync(tmpRoot, { recursive: true, force: true });
});

const WINDOW = 200_000;

/** rounds 条 bash 输出，每条 chars 字符（> toolResultBudget 单条 10K token 上限，会被原地截断） */
function history(rounds: number, chars: number): Message[] {
  const msgs: Message[] = [{ role: "user", content: [{ type: "text", text: "开始" }] }];
  for (let i = 0; i < rounds; i++) {
    msgs.push({
      role: "assistant",
      content: [{ type: "tool_use", id: `t${i}`, name: "bash", input: { command: `cat f${i}` } }],
    });
    msgs.push({
      role: "user",
      content: [{ type: "tool_result", tool_use_id: `t${i}`, content: "x".repeat(chars) }],
    });
  }
  msgs.push({ role: "assistant", content: [{ type: "text", text: "继续" }] });
  msgs.push({ role: "user", content: [{ type: "text", text: "下一步" }] });
  return msgs;
}

function endTurn(): AccumulatedResponse {
  return {
    role: "assistant",
    content: [{ type: "text", text: "好的" }],
    stopReason: "end_turn",
    usage: { inputTokens: 5, outputTokens: 2 },
  } as AccumulatedResponse;
}

describe("发现 3a — hard 档原地截断按同源 token 判成功", () => {
  test("消息数不减、token 大降 ⇒ CompactionAttempt success:true + 横幅", async () => {
    const ctxMgr = new ContextManager({ maxTokens: WINDOW });
    ctxMgr.setSystemPrompt("test");
    // 自我定位到 hard 档（估算器细节变化时测试仍成立）
    let found = false;
    for (let rounds = 4; rounds < 40; rounds++) {
      ctxMgr.setMessages(history(rounds, 60_000));
      if (ctxMgr.getCompactionLevel() === "hard") {
        found = true;
        break;
      }
    }
    expect(found).toBe(true); // 前提：确实落在 hard 档，否则本测试空转

    const events: Array<{ event: string; data: Record<string, unknown> }> = [];
    const deps = {
      sendWithRetry: () => (async function* () {})(),
      processStream: async () => endTurn(),
      executeTools: async () => ({ results: [] }),
      autoCompact: async () => {},
      getAbortSignal: () => undefined,
      abortCurrentRequest: () => {},
      uuid: () => "uuid-test",
      traceAppendEvent: (e: { event: string; data?: Record<string, unknown> }) => {
        events.push({ event: e.event, data: e.data ?? {} });
      },
    } as unknown as QueryDeps;
    const loopConfig: QueryLoopConfig = {
      config: { model: "test-model", provider: "anthropic", maxTurns: 2 } as unknown as Config,
      ctxMgr,
      toolRegistry: new ToolRegistry(),
      sessionState: new SessionState("test-session"),
      fallback: new ModelFallback(),
      deps,
    };

    const banners: Array<{ before: number; after: number; saved?: number }> = [];
    for await (const ev of queryLoop(loopConfig)) {
      if (ev.kind === "compact") {
        banners.push({
          before: ev.messageCountBefore,
          after: ev.messageCountAfter,
          saved: ev.savedTokens,
        });
      }
    }

    const hard = events.filter(
      (e) => e.event === "CompactionAttempt" && e.data.trigger === "threshold_hard",
    );
    expect(hard.length).toBeGreaterThan(0);
    const first = hard[0].data;
    // 复现形态：原地替换，消息数不减（边界消息不计入 after）
    expect(first.messageCountAfter).toBe(first.messageCountBefore);
    expect(first.savedTokens as number).toBeGreaterThan(0);
    // ★旧判据下这里恒为 false
    expect(first.success).toBe(true);
    // 成功 ⇒ 画横幅，且横幅带 token 实据
    expect(banners.length).toBeGreaterThan(0);
    expect(banners[0].saved ?? 0).toBeGreaterThan(0);
  }, 20_000);
});
