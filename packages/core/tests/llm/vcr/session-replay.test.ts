/**
 * 会话级回放门禁 —— 评测接入 CI/CD 方案 P1（L0 确定性门禁补强）
 *
 * 跑的是**真实 queryLoop + 真实 provider（Anthropic / OpenAI）+ 真实 SubAgentTool
 * + 生产计费 sink**，只把最底层 fetch 换成夹具回放（见 session-harness.ts）。
 * 断言落在 provider 序列化后的 wire body 上，因为缓存命中只看发出去的字节。
 *
 * 四组断言，每组对应一种「缓存 / 计费被静默打塌」的回归形态：
 *   ① system 稳定段跨轮、跨会话（不同时刻）字节相同 —— 时间戳 / 随机值漏进边界前；
 *   ② 工具定义跨轮字节相同且按名字典序 —— 注册顺序或 schema 序列化抖动；
 *   ③ 消息历史第 k 轮是第 k−1 轮的前缀 —— 改写历史的路径必须先进白名单；
 *   ④ 每轮 cache_control 断点 ≤ 4（仅 Anthropic 族）；
 *   ⑤ 整会话 token / 成本 = 夹具逐轮 usage 之和（含子代理）—— 漏记一个入口。
 *
 * 变异自证（evals/CLAUDE.md §4）记录在 Agent Note
 * `.agents/notes/implemented/testing/2026-10-05-会话级回放门禁-多轮前缀稳定与整会话计费.md`。
 */

import { describe, test, expect, afterEach, setSystemTime } from "bun:test";
import { queryLoop } from "@sid-code/core/query/loop.ts";
import type { QueryLoopConfig } from "@sid-code/core/query/loop.ts";
import type { QueryDeps } from "@sid-code/core/query/types.ts";
import { executeTools } from "@sid-code/core/query/tool-executor.ts";
import { processStream } from "@sid-code/core/query/stream-processor.ts";
import { Manager as ContextManager } from "@sid-code/core/context/manager.ts";
import { Registry as ToolRegistry } from "@sid-code/core/tool/registry.ts";
import { ModelFallback } from "@sid-code/core/llm/fallback.ts";
import { AnthropicProvider } from "@sid-code/core/llm/anthropic.ts";
import { OpenAIProvider } from "@sid-code/core/llm/openai.ts";
import type { Provider } from "@sid-code/core/llm/provider.ts";
import type { ProviderRegistry } from "@sid-code/core/llm/registry.ts";
import { SessionState } from "@sid-code/core/session/state.ts";
import { SubAgentTool } from "@sid-code/core/agent/tool.ts";
import { createSubAgentUsageSink } from "@sid-code/core/agent/usage-sink.ts";
import { buildSystemPrompt, clearPromptCache } from "@sid-code/core/config/system-prompt.ts";
import { DYNAMIC_BOUNDARY, MAX_CACHE_BREAKPOINTS } from "@sid-code/core/api/cache-strategy.ts";
import type { Config } from "@sid-code/core/config/config.ts";
import type { LegacyTool, LegacyToolResult } from "@sid-code/core/tool/types.ts";
import {
  installSessionFetch,
  listSessionFixtures,
  loadSessionFixture,
  type CapturedRequest,
  type SessionFixture,
} from "./session-harness.ts";

const MAIN_HOST = { "anthropic-messages": "api.anthropic.com", "openai-chat": "main.vcr.test" };
const SUB_BASE = "https://sub.vcr.test";

/** 确定性假工具：输出只依赖入参，不碰文件系统 */
class FakeTool implements LegacyTool {
  constructor(
    private _name: string,
    private _readOnly: boolean,
  ) {}
  name() {
    return this._name;
  }
  description() {
    return `fake ${this._name}（会话回放夹具用）`;
  }
  inputSchema() {
    return {
      type: "object",
      properties: {
        path: { type: "string" },
        pattern: { type: "string" },
        old: { type: "string" },
        new: { type: "string" },
      },
    };
  }
  readOnly() {
    return this._readOnly;
  }
  async execute(input: unknown): Promise<LegacyToolResult> {
    return { output: `${this._name} ok: ${JSON.stringify(input)}` };
  }
}

interface RunResult {
  captured: CapturedRequest[];
  consumed: { main: number; sub: number };
  sessionState: SessionState;
  kinds: string[];
  toolOrder: string[];
}

async function runSession(fx: SessionFixture, at: Date): Promise<RunResult> {
  setSystemTime(at);
  clearPromptCache();
  const family = fx.family;
  const mainProvider: Provider =
    family === "anthropic-messages"
      ? // baseURL 必须显式给：SDK 会读 ANTHROPIC_BASE_URL，本机若设了它，请求就绕过 shim
        new AnthropicProvider("test-key", fx.model, `https://${MAIN_HOST[family]}`)
      : new OpenAIProvider("test-key", fx.model, `https://${MAIN_HOST[family]}/v1`);
  const subProvider: Provider =
    family === "anthropic-messages"
      ? new AnthropicProvider("test-key", fx.model, SUB_BASE)
      : new OpenAIProvider("test-key", fx.model, `${SUB_BASE}/v1`);
  const provider = family === "anthropic-messages" ? "anthropic" : "openai";

  const config = {
    model: fx.model,
    provider,
    maxTurns: 20,
    maxTokens: 8192,
    checkpoint: { enabled: false },
    permissionMode: "bypassPermissions",
  } as unknown as Config;

  const sessionState = new SessionState(`vcr-session-${family}`);
  const toolRegistry = new ToolRegistry();
  // 刻意按非字典序注册：断言 ② 要拦的就是「发出去的顺序跟着注册顺序走」
  for (const t of [
    new FakeTool("read", true),
    new FakeTool("grep", true),
    new FakeTool("edit", false),
  ]) {
    toolRegistry.register(t);
  }
  const providerRegistry = {
    getProvider: () => mainProvider,
    getProviderFor: () => mainProvider,
    getCurrentModel: () => fx.model,
    getModelForSubAgent: () => fx.model,
    getProviderForSubAgent: () => subProvider,
    getLanguage: () => "zh" as const,
    getKnownModelNames: () => [fx.model],
    getContextWindow: () => 200_000,
    clearCache: () => {},
  } as unknown as ProviderRegistry;
  const subTool = new SubAgentTool(providerRegistry, toolRegistry);
  subTool.setUsageSink(createSubAgentUsageSink(sessionState, config));
  toolRegistry.register(subTool as unknown as LegacyTool);

  const ctxMgr = new ContextManager({ maxTokens: 200_000 });
  ctxMgr.setSystemPrompt(
    buildSystemPrompt({
      tools: toolRegistry.all() as any,
      workingDir: "/workspace/vcr",
      gitStatus: false,
      model: fx.model,
      preferredLanguage: "zh" as any,
    }),
  );
  ctxMgr.addMessage({ role: "user", content: [{ type: "text", text: fx.prompt }] });

  const fallback = new ModelFallback();
  const toolOrder: string[] = [];
  const deps: QueryDeps = {
    sendWithRetry: (params, signal, opts) => {
      fallback.reset();
      return fallback.executeWithFallback(mainProvider, params, signal, {
        deadlineAt: opts?.deadlineAt,
      });
    },
    processStream: (stream, onText, onThinking) => processStream(stream, onText, onThinking),
    executeTools: async (content) => {
      for (const b of content) if (b.type === "tool_use") toolOrder.push(b.name);
      return executeTools(content, {
        config,
        toolRegistry,
        sessionState,
        hookSystem: {
          firePreToolUseEvent: async () => ({ finalOutput: undefined }),
          firePostToolUseEvent: async () => ({ finalOutput: undefined }),
          firePostToolUseFailureEvent: async () => {},
        } as any,
        permissionChecker: null,
        getAbortSignal: () => undefined,
        requestUserConfirmation: async () => true,
      });
    },
    autoCompact: async () => {},
    handleContextOverflow: () => null,
    getAbortSignal: () => undefined,
    uuid: () => "uuid",
  };

  const loopConfig: QueryLoopConfig = {
    config,
    ctxMgr,
    toolRegistry,
    sessionState,
    fallback,
    deps,
  };
  const shim = installSessionFetch(
    fx,
    { main: MAIN_HOST[family], sub: new URL(SUB_BASE).host },
    // 辅助调用（loop-detection 自检等）不带工具
    (body) => !Array.isArray(body.tools) || body.tools.length === 0,
  );
  const kinds: string[] = [];
  try {
    for await (const ev of queryLoop(loopConfig)) kinds.push(ev.kind);
  } finally {
    shim.restore();
    setSystemTime();
  }
  return { captured: shim.captured, consumed: shim.consumed, sessionState, kinds, toolOrder };
}

// ─── wire body 归一化：不同协议族抽出「稳定段 / 工具 / 历史」 ──────────────

/** 去掉 cache_control（它每轮跟着「最后一条 user」移动，不属于内容） */
function stripCacheControl<T>(v: T): T {
  return JSON.parse(JSON.stringify(v, (k, val) => (k === "cache_control" ? undefined : val)));
}

function stableSystem(fx: SessionFixture, body: Record<string, any>): string {
  if (fx.family === "anthropic-messages")
    return JSON.stringify(stripCacheControl(body.system?.[0]));
  const first = body.messages?.[0];
  return JSON.stringify(first?.role === "system" || first?.role === "developer" ? first : null);
}

function toolsBytes(body: Record<string, any>): string {
  return JSON.stringify(stripCacheControl(body.tools));
}

function toolNames(fx: SessionFixture, body: Record<string, any>): string[] {
  return (body.tools ?? []).map((t: any) =>
    fx.family === "anthropic-messages" ? t.name : t.function?.name,
  );
}

const isReminderText = (s: unknown) =>
  typeof s === "string" && s.trimStart().startsWith("<system-reminder>");

/**
 * 历史消息（不含 OpenAI 族的 system 首条）。
 *
 * 合法改写白名单 —— 每一条都是一条**已知**的、每轮都会重写历史尾部的生产路径，
 * 不在白名单里的改写一律判红。新增改写历史的路径必须先在这里登记并写明理由：
 *   W1 reminder 注入（reminder-inject.ts）：本轮注入的 <system-reminder> 只进本轮请求，
 *      不进 ctxMgr，所以下一轮里同一条 user 消息不带它 —— 比较前从 user 消息剔除。
 *   W2 动态区后置（openai.ts prependSystemMessage）：OpenAI 族把 DYNAMIC_BOUNDARY 之后的
 *      内容作为**末尾**独立 user 消息发送，下一轮它会移到新的末尾 —— 比较前剔除。
 *   W3 cache_control 漂移（anthropic.ts markLastUserMessageCacheBreakpoint）：断点跟着
 *      最后一条 user 走 —— stripCacheControl 已处理。
 */
function history(fx: SessionFixture, body: Record<string, any>): unknown[] {
  let msgs: any[] = stripCacheControl(body.messages ?? []);
  if (fx.family === "openai-chat") {
    if (msgs[0]?.role === "system" || msgs[0]?.role === "developer") msgs = msgs.slice(1);
    // W2
    msgs = msgs.filter((m) => !(m.role === "user" && isReminderText(m.content)));
  }
  // W1
  return msgs
    .map((m) => {
      if (m.role !== "user") return m;
      if (Array.isArray(m.content)) {
        return {
          ...m,
          content: m.content.filter((b: any) => !(b.type === "text" && isReminderText(b.text))),
        };
      }
      return m;
    })
    .filter((m) => !(m.role === "user" && Array.isArray(m.content) && m.content.length === 0));
}

function countBreakpoints(body: Record<string, any>): number {
  let n = 0;
  JSON.stringify(body, (k, v) => {
    if (k === "cache_control" && v) n++;
    return v;
  });
  return n;
}

// ─── 用例 ──────────────────────────────────────────────────────────

afterEach(() => setSystemTime());

const FIXTURES = listSessionFixtures();

describe("会话级回放门禁（P1 · L0）", () => {
  test("至少两个协议族各有一份会话夹具，且每份都含子代理轮次", () => {
    const fams = new Set(FIXTURES.map((f) => loadSessionFixture(f).family));
    expect([...fams].sort()).toEqual(["anthropic-messages", "openai-chat"]);
    for (const f of FIXTURES) {
      const fx = loadSessionFixture(f);
      expect(
        fx.turns.some((t) => t.agent === "sub"),
        `${f} 缺子代理轮次`,
      ).toBe(true);
      expect(
        fx.turns.filter((t) => t.agent === "main").length,
        `${f} 主轮数`,
      ).toBeGreaterThanOrEqual(5);
    }
  });

  for (const file of FIXTURES) {
    const fx = loadSessionFixture(file);
    describe(file, () => {
      test("事件序列：夹具轮次恰好耗尽，工具按录制顺序派发，正常 end_turn 收尾", async () => {
        const r = await runSession(fx, new Date("2026-10-05T09:00:00Z"));
        expect(r.consumed.main).toBe(fx.turns.filter((t) => t.agent === "main").length);
        expect(r.consumed.sub).toBe(fx.turns.filter((t) => t.agent === "sub").length);
        const expectedTools = fx.turns
          .filter((t) => t.agent === "main")
          .flatMap((t) =>
            t.response.content.filter((b) => b.type === "tool_use").map((b: any) => b.name),
          );
        expect(r.toolOrder).toEqual(expectedTools);
        expect(r.kinds.at(-1)).toBe("done");
      });

      test("① system 稳定段：跨轮字节相同，且两个不同时刻启动的会话也相同", async () => {
        const a = await runSession(fx, new Date("2026-10-05T09:00:00Z"));
        const b = await runSession(fx, new Date("2027-03-17T21:47:13Z"));
        const mainA = a.captured.filter((c) => c.route === "main");
        const mainB = b.captured.filter((c) => c.route === "main");
        const first = stableSystem(fx, mainA[0]!.body);
        expect(first.length).toBeGreaterThan(100);
        for (const [k, c] of mainA.entries()) {
          expect(stableSystem(fx, c.body), `第 ${k + 1} 轮稳定段与第 1 轮不同`).toBe(first);
        }
        expect(
          stableSystem(fx, mainB[0]!.body),
          "不同时刻启动的会话，稳定段不同（时间漏进了边界前）",
        ).toBe(first);
        // 边界本身不得出现在稳定段里（出现说明拆分失效，整段都会被当稳定段缓存）
        expect(first.includes(DYNAMIC_BOUNDARY.trim())).toBe(false);
      });

      test("② 工具定义：跨轮字节相同，且按名字典序（不跟注册顺序）", async () => {
        const r = await runSession(fx, new Date("2026-10-05T09:00:00Z"));
        const main = r.captured.filter((c) => c.route === "main");
        const first = toolsBytes(main[0]!.body);
        for (const [k, c] of main.entries()) {
          expect(toolsBytes(c.body), `第 ${k + 1} 轮工具定义与第 1 轮不同`).toBe(first);
        }
        const names = toolNames(fx, main[0]!.body);
        expect(names).toEqual([...names].sort());
      });

      test("③ 消息历史：第 k 轮是第 k−1 轮的前缀（白名单外的改写判红）", async () => {
        const r = await runSession(fx, new Date("2026-10-05T09:00:00Z"));
        for (const route of ["main", "sub"] as const) {
          const reqs = r.captured.filter((c) => c.route === route);
          for (let k = 1; k < reqs.length; k++) {
            const prev = history(fx, reqs[k - 1]!.body);
            const cur = history(fx, reqs[k]!.body);
            expect(cur.length, `${route} 第 ${k + 1} 轮历史变短`).toBeGreaterThan(prev.length);
            expect(
              cur.slice(0, prev.length),
              `${route} 第 ${k + 1} 轮改写了第 ${k} 轮的历史`,
            ).toEqual(prev);
          }
        }
      });

      if (fx.family === "anthropic-messages") {
        test(`④ 每轮 cache_control 断点 ≤ ${MAX_CACHE_BREAKPOINTS}`, async () => {
          const r = await runSession(fx, new Date("2026-10-05T09:00:00Z"));
          for (const [k, c] of r.captured.entries()) {
            expect(
              countBreakpoints(c.body),
              `第 ${k + 1} 个请求（${c.route}）`,
            ).toBeLessThanOrEqual(MAX_CACHE_BREAKPOINTS);
          }
        });
      }

      test("⑤ 整会话 token / 成本 = 夹具逐轮 usage 之和（含子代理）", async () => {
        // 计价时刻必须与会话时刻一致：分时段定价（DeepSeek 闲时半价）下，换个时刻算期望值会差 2 倍
        const at = new Date("2026-10-05T09:00:00Z");
        const r = await runSession(fx, at);
        const provider = fx.family === "anthropic-messages" ? "anthropic" : "openai";
        let input = 0;
        let output = 0;
        let cacheRead = 0;
        let cost = 0;
        for (const t of fx.turns) {
          const u = {
            inputTokens: t.usage.input_tokens,
            outputTokens: t.usage.output_tokens,
            cacheReadInputTokens: t.usage.cache_read_input_tokens ?? 0,
            cacheCreationInputTokens: t.usage.cache_creation_input_tokens ?? 0,
          };
          input += u.inputTokens;
          output += u.outputTokens;
          cacheRead += u.cacheReadInputTokens;
          cost += r.sessionState.calculateCost(fx.model, u, provider, undefined, at);
        }
        const total = r.sessionState.getTotalUsage();
        expect(total.inputTokens).toBe(input);
        expect(total.outputTokens).toBe(output);
        expect(total.cacheReadInputTokens ?? 0).toBe(cacheRead);
        expect(r.sessionState.totalCostUSD).toBeCloseTo(cost, 10);
        expect(cost).toBeGreaterThan(0);
      });
    });
  }
});
