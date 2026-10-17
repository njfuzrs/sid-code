/**
 * PR-B 收尾（2026-10-17）：子代理单轮兜底的「无事件」计时口径 + 去限制后的循环层行为。
 *
 * 锁四件事（方案 §7.1 T3 / T4 / T6 的循环层版本）：
 *   ① 链路失效（流永不 settle、无视 abort）→ 兜底开枪 → 重试 → 第 2 次交付，子代理 success；
 *   ② 慢但一直有事件的流，总耗时远超阈值也**不**开枪（「无事件」口径；改回总耗时口径即红）；
 *   ③ 一直挂死 → 恰好 maxStreamRetries+1 次后耗尽，文案写实际那一层、不含「墙钟」；
 *   ④ 不声明 maxTurns → 能跑满 40 轮工具调用（`turns < undefined` 陷阱 / 30 轮默认值复活即红）。
 *
 * 阈值经 `SID_CODE_MAX_TURN_DURATION_MS` 压到毫秒级——它就是主循环同一个配置项，
 * 这同时证明子代理读的是主循环那一份，而不是另起的子代理专属值。
 *
 * fix_type: regression_guard
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { runAgentLoop } from "@sid-code/core/agent/agentic-loop.ts";
import { Manager as ContextManager } from "@sid-code/core/context/manager.ts";
import { Registry as ToolRegistry } from "@sid-code/core/tool/registry.ts";
import { LoopDetector } from "@sid-code/core/agent/loop-detection.ts";
import { ModelAvailabilityService } from "@sid-code/core/llm/availability.ts";
import { resolveSubAgentMaxTurns } from "@sid-code/core/agent/sub-agent.ts";
import type { Provider } from "@sid-code/core/llm/provider.ts";
import type { StreamEvent } from "@sid-code/core/llm/types.ts";
import type { LegacyTool, LegacyToolResult } from "@sid-code/core/tool/types.ts";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const ENV = "SID_CODE_MAX_TURN_DURATION_MS";
let savedEnv: string | undefined;

beforeEach(() => {
  savedEnv = process.env[ENV];
});
afterEach(() => {
  if (savedEnv === undefined) delete process.env[ENV];
  else process.env[ENV] = savedEnv;
});

function textEvents(text: string): StreamEvent[] {
  return [
    {
      type: "message_start",
      message: { usage: { inputTokens: 10, outputTokens: 0 } },
    } as any,
    {
      type: "content_block_start",
      index: 0,
      content_block: { type: "text" },
    } as any,
    {
      type: "content_block_delta",
      index: 0,
      delta: { type: "text_delta", text },
    } as any,
    { type: "content_block_stop", index: 0 } as any,
    {
      type: "message_delta",
      delta: { stop_reason: "end_turn" },
      usage: { outputTokens: 5 },
    } as any,
  ];
}

function toolUseEvents(id: string, filePath: string): StreamEvent[] {
  return [
    {
      type: "message_start",
      message: { usage: { inputTokens: 10, outputTokens: 0 } },
    } as any,
    {
      type: "content_block_start",
      index: 0,
      content_block: { type: "tool_use", id, name: "read" },
    } as any,
    {
      type: "content_block_delta",
      index: 0,
      delta: {
        type: "input_json_delta",
        partial_json: JSON.stringify({ file_path: filePath }),
      },
    } as any,
    { type: "content_block_stop", index: 0 } as any,
    {
      type: "message_delta",
      delta: { stop_reason: "tool_use" },
      usage: { outputTokens: 5 },
    } as any,
  ];
}

/** 模拟 `reader.read()` 与 `cancel()` 同时 hang：永不 yield、也不响应 abort。 */
async function* hangForever(): AsyncIterable<StreamEvent> {
  await new Promise<never>(() => {});
}

async function* fromEvents(events: StreamEvent[], gapMs = 0): AsyncIterable<StreamEvent> {
  for (const e of events) {
    if (gapMs > 0) await sleep(gapMs);
    yield e;
  }
}

function scripted(script: Array<() => AsyncIterable<StreamEvent>>) {
  let calls = 0;
  const provider = {
    name: () => "openai",
    defaultModel: () => "mock-model",
    sendMessageStream: () => {
      const f = script[Math.min(calls, script.length - 1)];
      calls += 1;
      return f();
    },
  } as unknown as Provider;
  return { provider, calls: () => calls };
}

function noCooldownAvailability(): ModelAvailabilityService {
  const svc = new ModelAvailabilityService();
  svc.markRateLimited = () => {};
  return svc;
}

class MockReadTool implements LegacyTool {
  count = 0;
  name() {
    return "read";
  }
  description() {
    return "读取文件";
  }
  inputSchema() {
    return {
      type: "object",
      properties: { file_path: { type: "string" } },
      required: ["file_path"],
    };
  }
  readOnly() {
    return true;
  }
  async execute(input: Record<string, unknown>): Promise<LegacyToolResult> {
    this.count++;
    return { output: `内容 ${String(input.file_path)} #${this.count}` };
  }
}

function baseConfig(provider: Provider, extra: Record<string, unknown> = {}) {
  const ctxMgr = new ContextManager({ maxTokens: 1_000_000 });
  ctxMgr.setSystemPrompt("你是代码核查助手");
  ctxMgr.addMessage({
    role: "user",
    content: [{ type: "text", text: "核查" }],
  });
  return {
    provider,
    model: "mock-model",
    ctxMgr,
    tools: new ToolRegistry(),
    signal: new AbortController().signal,
    loopDetector: new LoopDetector(),
    availability: noCooldownAvailability(),
    permissionChecker: { check: async () => ({ allowed: true }) },
    retryBackoffBaseMs: 0,
    retryBackoffMaxMs: 0,
    ...extra,
  } as any;
}

describe("S2b 单轮兜底：链路失效时重试，而不是挂死或判死", () => {
  test("① 第 1 次永不 settle → 兜底开枪 → 第 2 次交付，子代理 success", async () => {
    process.env[ENV] = "120";
    const { provider, calls } = scripted([hangForever, () => fromEvents(textEvents("核查完成"))]);
    const result = await runAgentLoop(baseConfig(provider, { maxTurns: 3 }));
    expect(calls()).toBe(2);
    expect(result.success).toBe(true);
    expect(result.lastTextOutput).toContain("核查完成");
    expect(result.retryAttempts ?? 0).toBeGreaterThanOrEqual(1);
  }, 10_000);

  test("② 慢但一直有事件（总耗时 ≈ 3× 阈值）→ 不开枪，一次交付", async () => {
    // 5 个事件 × 80ms ≈ 400ms，阈值 150ms：总耗时口径必开枪，无事件口径不开枪。
    process.env[ENV] = "150";
    const { provider, calls } = scripted([() => fromEvents(textEvents("慢慢写完"), 80)]);
    const result = await runAgentLoop(baseConfig(provider, { maxTurns: 3 }));
    expect(result.success).toBe(true);
    expect(calls(), "开枪会触发重发：调用次数必须是 1").toBe(1);
    expect(result.lastTextOutput).toContain("慢慢写完");
  }, 10_000);

  test("③ 一直挂死 → 恰好 maxStreamRetries+1 次后耗尽，文案写实际层且不含「墙钟」", async () => {
    process.env[ENV] = "60";
    const { provider, calls } = scripted([hangForever]);
    const result = await runAgentLoop(baseConfig(provider, { maxTurns: 3, maxStreamRetries: 2 }));
    expect(result.success).toBe(false);
    expect(calls()).toBe(3);
    expect(result.errorMessage ?? "").toContain("单轮硬超时");
    expect(result.errorMessage ?? "").toContain("已重试 2 次");
    expect(result.errorMessage ?? "").not.toContain("墙钟");
  }, 10_000);
});

describe("S4 循环层：不声明 maxTurns 即无上限", () => {
  test("④ 不传 maxTurns → 跑满 40 轮工具调用后正常收尾（不被 30 轮截断、不是 0 轮）", async () => {
    const N = 40;
    const script: Array<() => AsyncIterable<StreamEvent>> = [];
    for (let i = 0; i < N; i++) script.push(() => fromEvents(toolUseEvents(`t${i}`, `/f${i}.ts`)));
    script.push(() => fromEvents(textEvents("40 个文件全部核查完毕")));
    const { provider, calls } = scripted(script);
    const read = new MockReadTool();
    const tools = new ToolRegistry();
    tools.register(read as any);

    // 走生产同一条取值路径：未声明 → resolveSubAgentMaxTurns 归一（必须是 Infinity 而非 undefined）
    const maxTurns = resolveSubAgentMaxTurns({});
    const result = await runAgentLoop(baseConfig(provider, { tools, maxTurns }));
    expect(read.count).toBe(N);
    expect(calls()).toBe(N + 1);
    expect(result.success).toBe(true);
    expect(result.lastTextOutput).toContain("全部核查完毕");
  }, 30_000);
});
