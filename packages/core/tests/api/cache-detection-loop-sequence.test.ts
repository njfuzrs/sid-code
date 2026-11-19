/**
 * 账单侧缓存断裂归因 —— **按主循环真实调用顺序**驱动的集成测试（D1 / D2 / D7）
 *
 * 缺陷背景（2026-11-19 复核）：
 * - D1：`recordPromptState` 直接覆盖 `previousState`，`checkResponse` 里 `prev` 与 `curr`
 *   是**同一轮**的两个快照 → 归因链逐项比较全部相同，本地类别恒不可达，
 *   `/cost` 永远显示「上游 N / 本地 0」。
 * - D2：`loop.ts` 请求前的 `recordPromptState` 不传 `messages` → `diffMessagePrefix`
 *   永远「不可判」，`message_history` 归因不可达。
 * - D7：`suppressNext` 只在 `checkResponse` 里消费；compact 后请求失败时抑制标志留到
 *   下一次成功请求，白抑制一次检测。
 *
 * 为什么必须新开一份而不是补 `cache-detection-message-prefix.test.ts`：
 * 那份测试**连调两次 `checkResponse`**，绕过了 `loop.ts` 的请求前 `recordPromptState`，
 * 于是 prev / curr 天然是不同轮 —— 它绿着，生产路径照样全空转。这正是「单测绿、集成失效」
 * 的教科书形态：缺陷在调用时序上，纯逻辑单测测不出来。
 *
 * 本文件分两层：
 *   1. **序列层**：用手动驱动的 `CacheBreakDetector` 复刻 loop.ts 的调用序列
 *      （recordPromptState → checkResponse），覆盖 a/b/c/d，并含性能计量。
 *   2. **接线层**：真跑 `queryLoop`，断言 D2 的 `messages` 参数与 D7 的失败路径清理
 *      确实接在生产代码里（去掉这两处接线，序列全部通过这层仍能变红）。
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { queryLoop } from "@sid-code/core/query/loop.ts";
import type { QueryLoopConfig } from "@sid-code/core/query/loop.ts";
import type { QueryDeps } from "@sid-code/core/query/types.ts";
import { Manager as ContextManager } from "@sid-code/core/context/manager.ts";
import { Registry as ToolRegistry } from "@sid-code/core/tool/registry.ts";
import { ModelFallback } from "@sid-code/core/llm/fallback.ts";
import { SessionState } from "@sid-code/core/session/state.ts";
import type { Config } from "@sid-code/core/config/config.ts";
import type { AccumulatedResponse } from "@sid-code/core/llm/types.ts";
import type { LegacyTool } from "@sid-code/core/tool/types.ts";
import {
  CacheBreakDetector,
  MultiSourceCacheDetector,
  cancelSuppression,
  checkResponseForCacheBreak,
  clearCacheBreaks,
  getRecentCacheBreaks,
  notifyCompaction,
  recordPromptState,
  resetCacheDetection,
  type CacheCheckParams,
} from "@sid-code/core/api/cache-detection.ts";

// ─── 隔离 ───
//
// 模块级 defaultDetector / recentBreaks 在本进程内被多个用例共享，且 recordCacheBreak
// 会 fire-and-forget 落盘。这里把所有会落到 ~/.sid-code/ 的副作用都重定向到 tmpdir
// （SID_CODE_CACHE_BREAKS），并在每例前后 reset，避免用例互相污染。

let savedBreaksPath: string | undefined;
const TMP_BREAKS = `/tmp/cache-detection-loop-sequence-${process.pid}.jsonl`;

beforeEach(() => {
  savedBreaksPath = process.env.SID_CODE_CACHE_BREAKS;
  process.env.SID_CODE_CACHE_BREAKS = TMP_BREAKS;
  resetCacheDetection();
  clearCacheBreaks();
});

afterEach(async () => {
  // 落盘走 dynamic import().then()（fire-and-forget），恢复 env 前先让微任务跑干。
  await new Promise((r) => setTimeout(r, 0));
  resetCacheDetection();
  clearCacheBreaks();
  if (savedBreaksPath === undefined) delete process.env.SID_CODE_CACHE_BREAKS;
  else process.env.SID_CODE_CACHE_BREAKS = savedBreaksPath;
});

// ─── 序列层：复刻 loop.ts 的调用序列 ───

const TOOLS = [
  { name: "read", description: "read file" },
  { name: "write", description: "write file" },
];

/** 每条约 2KB：改写第 3 条起作废比例远超 1% 显著阈值 */
function msg(i: number, tag = ""): { role: string; content: string } {
  return { role: i % 2 ? "assistant" : "user", content: `第 ${i} 条${tag} ` + "x".repeat(2000) };
}
const history = (n: number) => Array.from({ length: n }, (_, i) => msg(i));

function params(over: Partial<CacheCheckParams> = {}): CacheCheckParams {
  return {
    cacheReadTokens: 10_000,
    systemPrompt: "you are helpful",
    toolSchemas: TOOLS,
    model: "m",
    messages: history(6),
    agentId: "main",
    ...over,
  };
}

/**
 * 一轮「真实」请求：**先**请求前快照（loop.ts 请求前那处），**再**响应后检测
 * （loop.ts 响应后那处）。刻意不连调两次 checkResponse —— 那正是缺陷漏网的缝隙。
 */
function turn(
  d: CacheBreakDetector,
  opts: { cacheRead: number; systemPrompt?: string; messages?: unknown[] },
) {
  const snapshot = params({
    cacheReadTokens: 0, // 请求前快照不关心 token（与 loop.ts 一致）
    systemPrompt: opts.systemPrompt ?? "you are helpful",
    messages: opts.messages ?? history(6),
  });
  d.recordPromptState(snapshot);
  return d.checkResponse({ ...snapshot, cacheReadTokens: opts.cacheRead });
}

describe("序列层：两轮之间改前缀 → 本地类别可达（D1 / D2）", () => {
  test("(a) 两轮之间改 system prompt → categories 含 system_prompt（D1）", () => {
    const d = new CacheBreakDetector(() => 0); // 时间不前进，排除 ttl_expiry
    expect(turn(d, { cacheRead: 40_000 })).toBeNull(); // 首轮只立基线
    const r = turn(d, { cacheRead: 20_000, systemPrompt: "you are a DIFFERENT assistant" });
    expect(r).not.toBeNull();
    // 修复前这里恒是 ["server_fluctuation"]：prev / curr 是同一轮快照，system hash 相同
    expect(r!.categories).toContain("system_prompt");
    expect(r!.categories).not.toContain("server_fluctuation");
    expect(r!.prefixHashSame).toBe(false);
  });

  test("(b) 两轮之间改写第 3 条消息 → categories 含 message_history（D2）", () => {
    const d = new CacheBreakDetector(() => 0);
    d.recordPromptState(params({ cacheReadTokens: 0, messages: history(6) }));
    expect(d.checkResponse(params({ cacheReadTokens: 40_000, messages: history(6) }))).toBeNull();

    const rewritten = history(6);
    rewritten[3] = msg(3, "（被原地改写）");
    d.recordPromptState(params({ cacheReadTokens: 0, messages: rewritten }));
    const r = d.checkResponse(params({ cacheReadTokens: 20_000, messages: rewritten }));

    expect(r).not.toBeNull();
    // 修复前（请求前快照不带 messages）恒是 ["server_fluctuation"]：
    // messagePrints 为 undefined → diffMessagePrefix 返回 null → 「不可判」
    expect(r!.categories).toContain("message_history");
    expect(r!.firstChangedMessageIndex).toBe(3);
    expect(r!.messagePrefixChanged).toBe(true);
  });

  test("只改 messages 不改 system（D1/D2 独立）：只归因 message_history", () => {
    const d = new CacheBreakDetector(() => 0);
    d.recordPromptState(params({ cacheReadTokens: 0, messages: history(6) }));
    d.checkResponse(params({ cacheReadTokens: 40_000, messages: history(6) }));
    const rewritten = history(6);
    rewritten[3] = msg(3, "（改写）");
    d.recordPromptState(params({ cacheReadTokens: 0, messages: rewritten }));
    const r = d.checkResponse(params({ cacheReadTokens: 20_000, messages: rewritten }))!;
    expect(r.categories).toEqual(["message_history"]);
  });

  test("pendingState 为 null（本轮没有请求前快照）→ 不比较、也不改基线", () => {
    const d = new CacheBreakDetector(() => 0);
    d.recordPromptState(params({ cacheReadTokens: 0, systemPrompt: "A" }));
    d.checkResponse(params({ cacheReadTokens: 40_000, systemPrompt: "A" })); // 基线 = A

    // 本轮 recordPromptState 没被调用（主循环在它之前就 continue 走了）
    expect(d.checkResponse(params({ cacheReadTokens: 10_000, systemPrompt: "B" }))).toBeNull();

    // 基线没被污染：下一轮比较的是 A（两轮前），不是 B（上一轮）
    d.recordPromptState(params({ cacheReadTokens: 0, systemPrompt: "C" }));
    const r = d.checkResponse(params({ cacheReadTokens: 10_000, systemPrompt: "C" }))!;
    expect(r.categories).toContain("system_prompt");
    // 若基线被 B 覆盖，这里的 drop 仍会触发，但 system 变化仍判 system_prompt；
    // 真正能区分的是「基线没被改」→ 比较对象是 A。用 changes 文案核对模型侧没有
    // 凭空多出 compact / ttl 之类的误归因。
    expect(r.categories).not.toContain("compact");
    expect(r.categories).not.toContain("ttl_expiry");
  });

  test("pending 在未达阈值分支也会提为基线（不允许滞留一轮）", () => {
    const d = new CacheBreakDetector(() => 0);
    // 第 1 轮：基线 = system A
    d.recordPromptState(params({ cacheReadTokens: 0, systemPrompt: "A" }));
    d.checkResponse(params({ cacheReadTokens: 40_000, systemPrompt: "A" }));
    // 第 2 轮：system 改成 B，但命中只掉 1000（< 2000 阈值）→ 不报，基线必须提为 B
    d.recordPromptState(params({ cacheReadTokens: 0, systemPrompt: "B" }));
    expect(d.checkResponse(params({ cacheReadTokens: 39_000, systemPrompt: "B" }))).toBeNull();
    // 第 3 轮：system 仍是 B，骤降 → 若第 2 轮 pending 滞留，这里会拿 A 当基线，
    // 把「A → B」的变化错误地记到第 3 轮上
    d.recordPromptState(params({ cacheReadTokens: 0, systemPrompt: "B" }));
    const r = d.checkResponse(params({ cacheReadTokens: 10_000, systemPrompt: "B" }))!;
    expect(r.categories).not.toContain("system_prompt");
    expect(r.categories).toEqual(["server_fluctuation"]);
  });

  test("reset() 清掉 pending：旧会话的请求前快照不得跨会话残留", () => {
    const d = new CacheBreakDetector(() => 0);
    d.recordPromptState(params({ cacheReadTokens: 0, systemPrompt: "A" }));
    d.checkResponse(params({ cacheReadTokens: 40_000, systemPrompt: "A" }));
    d.recordPromptState(params({ cacheReadTokens: 0, systemPrompt: "旧会话的残留" }));
    d.reset();
    // 新会话首轮：没有基线 → 只立基线，不比较（若 pending 没被清，会拿残留快照当基线）
    expect(d.checkResponse(params({ cacheReadTokens: 10_000, systemPrompt: "B" }))).toBeNull();
    d.recordPromptState(params({ cacheReadTokens: 0, systemPrompt: "B" }));
    expect(d.checkResponse(params({ cacheReadTokens: 10_000, systemPrompt: "B" }))).toBeNull();
  });
});

// ─── 序列层：抑制在失败路径上的迁移（D7） ───

describe("序列层：compact 后请求失败 → 抑制必须被取消（D7）", () => {
  /** 第 1 轮建立基线，然后 compact、再模拟一次失败请求 */
  function baselineThenCompactThenFail(d: CacheBreakDetector) {
    d.recordPromptState(params({ cacheReadTokens: 0 }));
    d.checkResponse(params({ cacheReadTokens: 40_000 }));
    // 压缩真的发生了 → 抑制紧接的一次检测
    d.notifyCompaction();
  }

  test("(c) notifyCompaction → 请求失败（只 cancelSuppression）→ 下一轮走比较分支而非抑制分支", () => {
    const d = new CacheBreakDetector(() => 0);
    baselineThenCompactThenFail(d);

    // 失败的那一轮：请求前快照建立了，但请求抛错 → 只有失败路径的清理，没有 checkResponse
    d.recordPromptState(params({ cacheReadTokens: 0, systemPrompt: "compact 后的 system" }));
    d.cancelSuppression();

    // 下一轮：system 又变了一次，命中骤降 → **必须**给出报告
    // （若抑制没被取消，这一轮会被静默吞掉，返回 null）
    d.recordPromptState(params({ cacheReadTokens: 0, systemPrompt: "再变一次" }));
    const r = d.checkResponse(params({ cacheReadTokens: 10_000, systemPrompt: "再变一次" }));

    expect(r).not.toBeNull();
    // 走的是比较分支：基线是失败那一轮的请求前快照，不是被 reset 后的「首轮」
    expect(r!.previousCacheReadTokens).toBe(40_000);
    expect(r!.categories).toContain("system_prompt");
  });

  test("(c2) 与「完全没调 cancelSuppression」对照：抑制会吞掉下一轮检测", () => {
    // 这条是对照组，用来说明 (c) 的断言确实能区分两种行为（而不是恒真）。
    const d = new CacheBreakDetector(() => 0);
    baselineThenCompactThenFail(d);
    d.recordPromptState(params({ cacheReadTokens: 0, systemPrompt: "compact 后的 system" }));
    // 不调 cancelSuppression
    d.recordPromptState(params({ cacheReadTokens: 0, systemPrompt: "再变一次" }));
    expect(
      d.checkResponse(params({ cacheReadTokens: 10_000, systemPrompt: "再变一次" })),
    ).toBeNull();
  });

  test("(d) cancelSuppression 之后 previousState / previousCacheReadTokens 保持不变", () => {
    const d = new CacheBreakDetector(() => 0);
    baselineThenCompactThenFail(d);

    // 用一条「基线未变」才能解释的观测：失败轮之后再来的那一轮，若基线没被清，
    // 比较的就是「基线（40k，system=you are helpful）→ 本轮（10k，system=X）」。
    d.cancelSuppression();
    d.recordPromptState(params({ cacheReadTokens: 0, systemPrompt: "you are helpful" }));
    const r = d.checkResponse(
      params({ cacheReadTokens: 10_000, systemPrompt: "you are helpful" }),
    )!;
    // previousCacheReadTokens 仍是 40k（没被清成 0）
    expect(r.previousCacheReadTokens).toBe(40_000);
    expect(r.dropTokens).toBe(30_000);
    // 基线没被清 → 不是「首轮只立基线」（首轮会返回 null）；且 system 未变 → 不归因 system_prompt
    expect(r.categories).toEqual(["server_fluctuation"]);
  });

  test("cancelSuppression 只清抑制，不清 pending（pending 属于本轮请求前的真实快照）", () => {
    const d = new CacheBreakDetector(() => 0);
    d.recordPromptState(params({ cacheReadTokens: 0 }));
    d.checkResponse(params({ cacheReadTokens: 40_000 }));
    d.notifyCompaction();
    d.recordPromptState(params({ cacheReadTokens: 0, systemPrompt: "本轮" }));
    d.cancelSuppression();
    // 抑制已清 → 本轮若正常返回，检测照常进行
    const r = d.checkResponse(params({ cacheReadTokens: 10_000, systemPrompt: "本轮" }));
    expect(r).not.toBeNull();
    // 基线 system 是 "you are helpful"，本轮是 "本轮" → system_prompt（证明比的是基线而非首轮）
    expect(r!.categories).toEqual(["system_prompt"]);
    expect(r!.previousCacheReadTokens).toBe(40_000);
  });

  test("MultiSourceCacheDetector.cancelSuppression 只作用于指定 agentId", () => {
    const m = new MultiSourceCacheDetector(() => 0);
    for (const id of ["main", "sub-1"]) {
      m.recordPromptState(params({ cacheReadTokens: 0, agentId: id }));
      m.checkResponse(params({ cacheReadTokens: 40_000, agentId: id }));
      m.notifyCompaction(id);
    }
    m.cancelSuppression("main");

    // main 的抑制被清 → 正常检测
    m.recordPromptState(params({ cacheReadTokens: 0, agentId: "main" }));
    expect(m.checkResponse(params({ cacheReadTokens: 10_000, agentId: "main" }))).not.toBeNull();
    // sub-1 的抑制仍在 → 被吞掉（证明它是按 agentId 精确清除，不是全清）
    m.recordPromptState(params({ cacheReadTokens: 0, agentId: "sub-1" }));
    expect(m.checkResponse(params({ cacheReadTokens: 10_000, agentId: "sub-1" }))).toBeNull();
  });

  test("模块级 cancelSuppression 走默认单例（main 源）", () => {
    recordPromptState(params({ cacheReadTokens: 0 }));
    expect(checkResponseForCacheBreak(params({ cacheReadTokens: 40_000 }))).toBeNull();
    notifyCompaction("main");
    cancelSuppression();
    recordPromptState(params({ cacheReadTokens: 0 }));
    expect(checkResponseForCacheBreak(params({ cacheReadTokens: 10_000 }))).not.toBeNull();
  });
});

// ─── 接线层：真跑 queryLoop，锁住 loop.ts 的两处接线 ───
//
// 序列层只能证明 detector 的**逻辑**对；接线（loop.ts 是否真把 messages 传进请求前快照、
// 失败路径是否真清了抑制）是另一回事 —— D1/D2 的原缺陷正是「逻辑对、接线断」。
// 这一层用工具轮把 loop 真正推进到多轮（end_turn 的第一轮会直接收尾）。

const readTool: LegacyTool = {
  name: () => "read",
  description: () => "read file",
  inputSchema: () => ({ type: "object", properties: { p: { type: "string" } } }),
  execute: async () => ({ output: "ok" }),
  readOnly: () => true,
};

function toolResp(id: string, cacheRead: number): AccumulatedResponse {
  return {
    role: "assistant",
    content: [{ type: "tool_use", id, name: "read", input: { p: "x" } }],
    stopReason: "tool_use",
    usage: { inputTokens: 100, outputTokens: 10, cacheReadInputTokens: cacheRead },
  } as unknown as AccumulatedResponse;
}

/** 在第 turns 轮之前（0 起）把历史某条消息原地改写，模拟「静默改写历史前缀」 */
function makeHarness(opts: {
  turns: number;
  cacheReadOf: (turn: number) => number;
  mutateBeforeTurn?: (turn: number, ctxMgr: ContextManager) => void;
}) {
  const registry = new ToolRegistry();
  registry.register(readTool);
  const ctxMgr = new ContextManager({ maxTokens: 200_000 });
  ctxMgr.setSystemPrompt("test");
  // 预置一段历史，让「改写第 3 条」有东西可改
  for (let i = 0; i < 4; i++) {
    ctxMgr.addMessage({
      role: i % 2 ? "assistant" : "user",
      content: [{ type: "text", text: `历史 ${i} ` + "y".repeat(2000) }],
    });
  }
  let turn = 0;
  const deps: QueryDeps = {
    sendWithRetry: () => {
      const t = turn;
      opts.mutateBeforeTurn?.(t, ctxMgr);
      return (async function* () {})();
    },
    processStream: async () => toolResp(`t${turn}`, opts.cacheReadOf(turn++)),
    executeTools: async (content: any[]) => ({
      results: content
        .filter((b: any) => b.type === "tool_use")
        .map((b: any) => ({ type: "tool_result", tool_use_id: b.id, content: "ok" })),
    }),
    autoCompact: async () => ({ kind: "skipped" as const }),
    getAbortSignal: () => undefined,
    uuid: () => `uuid-${turn}`,
    traceAppendEvent: () => {},
  } as unknown as QueryDeps;
  const loopConfig = {
    config: { model: "claude-opus-4-8", provider: "anthropic", maxTurns: opts.turns } as Config,
    ctxMgr,
    toolRegistry: registry,
    sessionState: new SessionState("cache-loop-sequence"),
    fallback: new ModelFallback(),
    deps,
  } as QueryLoopConfig;
  return { loopConfig, ctxMgr };
}

async function drain(loopConfig: QueryLoopConfig): Promise<void> {
  for await (const _ev of queryLoop(loopConfig)) {
    /* 消费完整个生成器 */
  }
}

describe("接线层：queryLoop 真实调用序列", () => {
  test("loop.ts 请求前快照带 messages → 两轮之间改写历史第 3 条 → message_history（D2 接线）", async () => {
    // 第 2 轮（下标 1）之前改写一条历史消息：随后那次请求的前缀与上一轮不同
    const REWRITE_AT = 1;
    const h = makeHarness({
      turns: 3,
      // 第 1 轮 0（只立基线），第 2 轮起给 40k，第 3 轮骤降到 10k
      cacheReadOf: (t) => (t === 0 ? 0 : t === 1 ? 40_000 : 10_000),
      mutateBeforeTurn: (t, ctxMgr) => {
        if (t !== REWRITE_AT) return;
        const msgs = ctxMgr.getMessages() as Array<{ role: string; content: unknown }>;
        msgs[2] = {
          role: msgs[2].role,
          content: [{ type: "text", text: "被原地改写的第 3 条 " + "z".repeat(2000) }],
        };
        ctxMgr.setMessages(msgs as never);
      },
    });
    await drain(h.loopConfig);

    const breaks = getRecentCacheBreaks();
    expect(breaks.length).toBeGreaterThan(0);
    // 修复前（loop.ts 不传 messages）这里恒是 server_fluctuation
    expect(breaks.some((b) => b.categories.includes("message_history"))).toBe(true);
  });

  test("loop.ts 请求前快照带 messages → 纯尾部追加不误报 message_history（反向对照）", async () => {
    const h = makeHarness({
      turns: 3,
      cacheReadOf: (t) => (t === 0 ? 0 : t === 1 ? 40_000 : 10_000),
    });
    await drain(h.loopConfig);
    const breaks = getRecentCacheBreaks();
    expect(breaks.length).toBeGreaterThan(0);
    // 每轮只追加（assistant tool_use + user tool_result），上一轮是这一轮的前缀
    expect(breaks.every((b) => !b.categories.includes("message_history"))).toBe(true);
  });

  test("loop 失败路径取消抑制：compact 抑制 → 请求失败 → 下一次成功请求仍能检测（D7 接线）", async () => {
    // 模拟时序：第 1 轮建立基线（40k）→ 制造一次 compact 抑制 → 第 2 轮 isPromptTooLongError
    // （失败后 loop 内部压缩并 continue）→ 第 3 轮成功且骤降。
    //
    // 断言点：压制在「第 2 轮失败」时没有被消费掉，也没有残留到「第 3 轮」——
    // 若残留，第 3 轮会被吞掉，getRecentCacheBreaks() 在整轮跑完后一条都没有。
    let turn = 0;
    const registry = new ToolRegistry();
    registry.register(readTool);
    const ctxMgr = new ContextManager({ maxTokens: 200_000 });
    ctxMgr.setSystemPrompt("test");
    ctxMgr.addMessage({ role: "user", content: [{ type: "text", text: "开始" }] });
    let compactCalls = 0;
    const deps: QueryDeps = {
      sendWithRetry: () => (async function* () {})(),
      processStream: async () => {
        const t = turn++;
        if (t === 1) {
          // 第 2 轮失败（prompt-too-long）：走 loop 的 catch → 失败路径
          throw Object.assign(new Error("prompt is too long: 210000 tokens > 200000 maximum"), {
            status: 400,
          });
        }
        return toolResp(`t${t}`, t === 0 ? 40_000 : 10_000);
      },
      executeTools: async (content: any[]) => ({
        results: content
          .filter((b: any) => b.type === "tool_use")
          .map((b: any) => ({ type: "tool_result", tool_use_id: b.id, content: "ok" })),
      }),
      autoCompact: async () => {
        compactCalls++;
      },
      getAbortSignal: () => undefined,
      uuid: () => `uuid-${turn}`,
      traceAppendEvent: () => {},
    } as unknown as QueryDeps;
    const loopConfig = {
      config: { model: "claude-opus-4-8", provider: "anthropic", maxTurns: 4 } as Config,
      ctxMgr,
      toolRegistry: registry,
      sessionState: new SessionState("cache-loop-d7"),
      fallback: new ModelFallback(),
      deps,
    } as QueryLoopConfig;

    // 在 loop 启动前挂上抑制：loop 第一次 checkResponse（第 1 轮）就会消费它，
    // 所以我们改为「第 1 轮之后」挂 —— 通过 provider 回调做不到，改用轮询不现实。
    // 这里用 QueryDeps 的 sendWithRetry 作为「每轮请求前」钩子：它在请求前快照之后执行。
    let sent = 0;
    const originalSend = deps.sendWithRetry;
    deps.sendWithRetry = (p) => {
      sent++;
      if (sent === 2) {
        // 第 2 轮请求就要发出时挂抑制：模拟「上一轮结束后刚 compact 过」，
        // 而这一轮马上失败 → 抑制不能被消费
        notifyCompaction("main");
      }
      return originalSend(p);
    };

    await drain(loopConfig);

    expect(compactCalls).toBeGreaterThan(0); // 前提：失败路径确实走到了
    const breaks = getRecentCacheBreaks();
    // 第 3 轮成功且骤降 → 必须有报告。若抑制残留到第 3 轮，这里会是 []。
    expect(breaks.length).toBeGreaterThan(0);
  });
});

// ─── 性能：每轮一次全量 snapshot 的绝对开销（方案 §4.3） ───
//
// D1 修复后仍是一次全量序列化/轮（修复前也是一次：请求前只序列化 system+tools，
// 响应后序列化全量）。要测的是「这一次全量」在长上下文下的绝对耗时。
// 方案门槛：> 1ms/轮即需改惰性指纹。这里用 300 条消息的假会话量一次，
// 并打印实测值供 PR 引用（不设硬断言，因为 runner 速度差异会让它变成 flake）。

describe("性能：300 条消息的假会话单次 snapshot 开销", () => {
  test("量一次全量快照耗时并打印", () => {
    const longHistory = Array.from({ length: 300 }, (_, i) => ({
      role: i % 2 ? "assistant" : "user",
      content: [{ type: "text", text: `第 ${i} 条 ` + "d".repeat(2000) }],
    }));
    const p = params({ cacheReadTokens: 0, messages: longHistory });
    // 预热（JIT + 首次 hash 分配）后再计时
    for (let i = 0; i < 5; i++) new CacheBreakDetector(() => 0).recordPromptState(p);
    const RUNS = 40;
    const started = performance.now();
    for (let i = 0; i < RUNS; i++) new CacheBreakDetector(() => 0).recordPromptState(p);
    const perRunMs = (performance.now() - started) / RUNS;
    console.log(
      `[cache-detection 性能] 300 条消息 × 2KB 单次 snapshot 平均 ${perRunMs.toFixed(3)}ms` +
        `（共约 ${(300 * 2000) / 1024 / 1024}MB 文本，门槛 1ms/轮）`,
    );
    // 只做上界兜底：真到几十毫秒说明有人把逐条序列化改成了平方复杂度之类
    expect(perRunMs).toBeLessThan(50);
  });
});
