/**
 * B26 顺带：顶层主循环在 StructuredOutput 捕获合规载荷后必须收尾。
 *
 * 实测缺陷（会话 20261002-212543-660c152b）：`-p --json-schema` 下模型拿到成功返回后
 * 同参连调 StructuredOutput 99 次、102 次 API，只有 maxTurns 能停住。子代理路径有
 * hasCapturedOutput 旁路出口，顶层 queryLoop 没有。
 *
 * 两条用例互为对照：合规 → 一次就收尾；不合规 → 必须续轮让模型按错误重试。
 */
import { describe, test, expect } from "bun:test";
import { queryLoop } from "@sid-code/core/query/loop.ts";
import type { QueryLoopConfig } from "@sid-code/core/query/loop.ts";
import type { QueryDeps } from "@sid-code/core/query/types.ts";
import { Manager as ContextManager } from "@sid-code/core/context/manager.ts";
import { Registry as ToolRegistry } from "@sid-code/core/tool/registry.ts";
import { ModelFallback } from "@sid-code/core/llm/fallback.ts";
import { SessionState } from "@sid-code/core/session/state.ts";
import { StructuredOutputTool } from "@sid-code/core/tool/structured-output-tool.ts";
import type { Config } from "@sid-code/core/config/config.ts";
import type { AccumulatedResponse, ContentBlock, StreamEvent } from "@sid-code/core/llm/types.ts";

const SCHEMA = {
  type: "object",
  properties: { language: { type: "string" }, functionCount: { type: "number" } },
  required: ["language", "functionCount"],
};

async function* emptyStream(): AsyncIterable<StreamEvent> {
  /* processStream 被 mock */
}

function soCall(id: string, input: unknown): AccumulatedResponse {
  return {
    role: "assistant",
    content: [{ type: "tool_use", id, name: "StructuredOutput", input }],
    stopReason: "tool_use",
    usage: { inputTokens: 100, outputTokens: 10 },
  } as AccumulatedResponse;
}

/** 模型「拿到成功也不停」：每一轮都再调一次 StructuredOutput */
async function run(inputs: unknown[]) {
  const tool = new StructuredOutputTool(SCHEMA);
  const registry = new ToolRegistry();
  registry.register(tool);

  const ctxMgr = new ContextManager({ maxTokens: 200000 });
  ctxMgr.setSystemPrompt("test");
  ctxMgr.addMessage({ role: "user", content: [{ type: "text", text: "分析 calc.ts" }] });

  let call = 0;
  const deps: QueryDeps = {
    sendWithRetry: () => emptyStream(),
    processStream: async () => {
      const r = soCall(`t${call}`, inputs[Math.min(call, inputs.length - 1)]);
      call++;
      return r;
    },
    // 真执行工具：hasCapturedOutput 必须由工具自己的校验结果置位，测试不伪造它
    executeTools: async (blocks: ContentBlock[]) => {
      const results: ContentBlock[] = [];
      for (const b of blocks) {
        if (b.type !== "tool_use") continue;
        const r = await tool.execute(b.input);
        results.push({
          type: "tool_result",
          tool_use_id: b.id,
          content: r.output,
          is_error: r.isError,
        } as ContentBlock);
      }
      return { results };
    },
    autoCompact: async () => {},
    handleContextOverflow: () => null,
    getAbortSignal: () => undefined,
    uuid: () => `uuid-${call}`,
  } as unknown as QueryDeps;

  const loopConfig: QueryLoopConfig = {
    config: { model: "m", provider: "anthropic", maxTurns: 8, maxTokens: 128000 } as Config,
    ctxMgr,
    toolRegistry: registry,
    sessionState: new SessionState("test-so-terminate"),
    fallback: new ModelFallback(),
    deps,
  };

  const kinds: string[] = [];
  let delivered: unknown;
  for await (const ev of queryLoop(loopConfig)) {
    kinds.push(ev.kind);
    if (ev.kind === "done")
      delivered = (ev as { structuredOutputDelivered?: true }).structuredOutputDelivered;
  }
  return { calls: call, kinds, tool, delivered };
}

describe("StructuredOutput 捕获合规输出后主循环收尾", () => {
  test("第一次就合规 → 只发 1 次模型请求，以 done 结束", async () => {
    const { calls, kinds, tool, delivered } = await run([
      { language: "TypeScript", functionCount: 2 },
    ]);
    expect(tool.hasCapturedOutput).toBe(true);
    // done 必须声明交付收尾，否则轨迹 exit_status 会掉进 user_interrupt 兜底桶
    expect(delivered).toBe(true);
    expect(calls).toBe(1);
    expect(kinds[kinds.length - 1]).toBe("done");
    expect(kinds).not.toContain("max_turns");
  });

  test("先不合规后合规 → 续轮重试一次，合规那轮收尾", async () => {
    const { calls, kinds, tool } = await run([
      { language: "TypeScript" }, // 缺 functionCount → isError，必须续轮
      { language: "TypeScript", functionCount: 2 },
    ]);
    expect(tool.getCapturedOutput()).toEqual({ language: "TypeScript", functionCount: 2 });
    expect(calls).toBe(2);
    expect(kinds[kinds.length - 1]).toBe("done");
  });
});
