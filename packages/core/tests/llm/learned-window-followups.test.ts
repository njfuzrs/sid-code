/**
 * S6 / S5 复审遗留（修-3）：B3 + D1 + D4 + L14 + T2 + T3 + D5。
 *
 * 来源：docs-research `20261018-任务静默停住修复落地复审-遗留问题清单.md` §1 B3、§3 D1/D4/D5、§4 T2/T3、§5 L14。
 * 落盘重定向到 tmpdir（SID_CONFIG_DIR 存/恢复原值，见 CONTRIBUTING 测试约定）。
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { recordContextOverflow, lookupAdmittedCeiling } from "@sid-code/core/llm/learned-window.ts";
import { sidPaths } from "@sid-code/core/config/paths.ts";
import { queryLoop, type QueryLoopConfig } from "@sid-code/core/query/loop.ts";
import type { QueryDeps } from "@sid-code/core/query/types.ts";
import {
  Manager as ContextManager,
  compactBoundaryBreaksAlternation,
} from "@sid-code/core/context/manager.ts";
import { Registry as ToolRegistry } from "@sid-code/core/tool/registry.ts";
import { ModelFallback } from "@sid-code/core/llm/fallback.ts";
import { SessionState } from "@sid-code/core/session/state.ts";
import { checkAutoThreshold } from "@sid-code/core/tool/tool-search-auto.ts";
import { resolvePromptMaxTokens } from "@sid-code/core/config/system-prompt.ts";
import type { Config } from "@sid-code/core/config/config.ts";
import type { AccumulatedResponse, Message } from "@sid-code/core/llm/types.ts";

const MODEL = "origin-test-model-s6-followup";
const URL_A = "https://gw-a.example.com/v1";
const DAY = 24 * 60 * 60 * 1000;

let dir: string;
let prevDir: string | undefined;
beforeEach(() => {
  prevDir = process.env.SID_CONFIG_DIR;
  dir = mkdtempSync(join(tmpdir(), "sid-s6f-"));
  process.env.SID_CONFIG_DIR = dir;
});
afterEach(() => {
  if (prevDir === undefined) delete process.env.SID_CONFIG_DIR;
  else process.env.SID_CONFIG_DIR = prevDir;
  rmSync(dir, { recursive: true, force: true });
});

const overflow = (admittedTokens: number, now: number) =>
  recordContextOverflow({ model: MODEL, baseURL: URL_A, admittedTokens, now });

describe("B3：已学上限不被过期后的溢出抹掉", () => {
  it("第 0 / 6 天学到，第 8 天再溢出：上限保留并按更小值收紧", () => {
    const t0 = 1_800_000_000_000;
    expect(overflow(650_000, t0).status).toBe("pending");
    expect(overflow(660_000, t0 + 6 * DAY)).toEqual({
      status: "learned",
      ceiling: 660_000,
      overflows: 2,
    });
    // 第 8 天：待定计数（firstOverflowAt=第 0 天）已过期，但上限（learnedAt=第 6 天）仍有效
    const r = overflow(640_000, t0 + 8 * DAY);
    expect(r.status).toBe("learned");
    expect(r.status === "learned" && r.ceiling).toBe(640_000);
    expect(lookupAdmittedCeiling(MODEL, URL_A, t0 + 8 * DAY)).toBe(640_000);
    // 续期：从第 8 天起再算 7 天
    expect(lookupAdmittedCeiling(MODEL, URL_A, t0 + 14 * DAY)).toBe(640_000);
  });

  it("有效上限下撞墙但本次已放行值更大：上限不放宽", () => {
    const t0 = 1_800_000_000_000;
    overflow(600_000, t0);
    overflow(610_000, t0 + DAY);
    const r = overflow(700_000, t0 + 2 * DAY);
    expect(r.status === "learned" && r.ceiling).toBe(610_000);
  });

  it("上限本身过期后：重新按 2 次才写入", () => {
    const t0 = 1_800_000_000_000;
    overflow(600_000, t0);
    overflow(610_000, t0 + DAY);
    expect(overflow(650_000, t0 + 9 * DAY).status).toBe("pending");
    expect(lookupAdmittedCeiling(MODEL, URL_A, t0 + 9 * DAY)).toBeUndefined();
  });
});

describe("L14：写盘只动自己的键，临时文件不固定名", () => {
  it("另一个进程在两次写之间写入的别的键不被覆盖，且不留 .tmp", () => {
    overflow(600_000, 1_800_000_000_000);
    // 模拟另一个进程：另一个 base_url 学到了值
    recordContextOverflow({
      model: MODEL,
      baseURL: "https://gw-b.example.com/v1",
      admittedTokens: 1,
      now: 1,
    });
    overflow(610_000, 1_800_000_000_001);
    const file = JSON.parse(readFileSync(sidPaths.learnedInputCeiling(), "utf8"));
    expect(Object.keys(file.entries).length).toBe(2);
    expect(
      readdirSync(dirname(sidPaths.learnedInputCeiling())).filter((f) => f.endsWith(".tmp")),
    ).toEqual([]);
  });
});

describe("L14：临时文件名不固定", () => {
  it("`${path}.tmp` 被别的进程占着（这里用同名目录模拟）时仍能写入", () => {
    const path = sidPaths.learnedInputCeiling();
    mkdirSync(`${path}.tmp`, { recursive: true });
    overflow(600_000, Date.now() - 1000);
    overflow(610_000, Date.now());
    expect(lookupAdmittedCeiling(MODEL, URL_A)).toBe(610_000);
  });
});

describe("D4：只带 baseURL（无同名 availableModels 条目）也读得到学到值", () => {
  it("system-prompt 预算与 tool-search 阈值都随学到值收紧", () => {
    overflow(200_000, Date.now() - 1000);
    overflow(200_000, Date.now());
    const loose = resolvePromptMaxTokens({ tools: [], model: MODEL } as never);
    const tight = resolvePromptMaxTokens({ tools: [], model: MODEL, baseURL: URL_A } as never);
    expect(tight).toBe(Math.floor(200_000 * 0.9));
    expect(tight).toBeLessThan(loose);

    // 同一份延迟工具（约 24K token）：5% × 1M = 50K 不够阈值，5% × 200K = 10K 就够
    const defs = [
      { name: "x", description: "y".repeat(120_000), input_schema: { type: "object" } },
    ];
    expect(checkAutoThreshold({ model: MODEL, deferredDefinitions: defs as never }, 5)).toBe(false);
    expect(
      checkAutoThreshold({ model: MODEL, baseURL: URL_A, deferredDefinitions: defs as never }, 5),
    ).toBe(true);
  });
});

// ─────────────────────────── queryLoop 接线（T2 / T3）───────────────────────────

function endTurnResp(): AccumulatedResponse {
  return {
    role: "assistant",
    content: [{ type: "text", text: "好的" }],
    stopReason: "end_turn",
    usage: { inputTokens: 5, outputTokens: 2 },
  } as AccumulatedResponse;
}

function buildHistory(rounds: number, pad = 4000): Message[] {
  const msgs: Message[] = [{ role: "user", content: [{ type: "text", text: "请帮我重构模块" }] }];
  for (let i = 0; i < rounds; i++) {
    msgs.push({
      role: "assistant",
      content: [{ type: "tool_use", id: `t${i}`, name: "read", input: { path: `f${i}.ts` } }],
    });
    msgs.push({
      role: "user",
      content: [{ type: "tool_result", tool_use_id: `t${i}`, content: "x".repeat(pad) }],
    });
  }
  return msgs;
}

function makeLoop(opts: {
  preload: Message[];
  admitted?: number;
  /** 哪个阶段抛 PTL：connect = sendWithRetry 抛，stream = processStream 抛 */
  ptlAt?: "connect" | "stream";
  sent?: Message[][];
}): { cfg: QueryLoopConfig; ctxMgr: ContextManager } {
  const ctxMgr = new ContextManager({ maxTokens: 1_000_000 });
  ctxMgr.setSystemPrompt("test");
  ctxMgr.setMessages(opts.preload);
  if (opts.admitted) ctxMgr.recordActualTokens(opts.admitted);
  let sends = 0;
  let streams = 0;
  const ptl = () => new Error("prompt is too long: 1200000 tokens > 1000000 maximum");
  const deps = {
    sendWithRetry: (params: { messages: Message[] }) => {
      sends++;
      opts.sent?.push(params.messages);
      if (opts.ptlAt === "connect" && sends === 1) throw ptl();
      return (async function* () {})();
    },
    processStream: async () => {
      streams++;
      if (opts.ptlAt === "stream" && streams === 1) throw ptl();
      return endTurnResp();
    },
    executeTools: async () => ({ results: [] }),
    autoCompact: async () => {},
    handleContextOverflow: () => null,
    getAbortSignal: () => undefined,
    abortCurrentRequest: () => {},
    uuid: () => "u",
    traceAppendEvent: () => {},
  } as unknown as QueryDeps;
  return {
    cfg: {
      config: {
        model: MODEL,
        provider: "anthropic",
        baseURL: URL_A,
        maxTurns: 4,
        availableModels: [],
      } as unknown as Config,
      ctxMgr,
      toolRegistry: new ToolRegistry(),
      sessionState: new SessionState("s"),
      fallback: new ModelFallback(),
      deps,
    },
    ctxMgr,
  };
}

async function drain(cfg: QueryLoopConfig): Promise<void> {
  for await (const _ev of queryLoop(cfg)) {
    /* drain */
  }
}

describe("T2：两处学习调用必须在 reactiveCompact 之前", () => {
  for (const phase of ["connect", "stream"] as const) {
    it(`${phase} 阶段 PTL：已放行值在压缩清零之前被记下`, async () => {
      // 先有一次待定溢出，本轮 PTL 是第 2 次 → 应学到
      recordContextOverflow({ model: MODEL, baseURL: URL_A, admittedTokens: 640_000 });
      const { cfg, ctxMgr } = makeLoop({
        preload: buildHistory(12),
        admitted: 663_013,
        ptlAt: phase,
      });
      await drain(cfg);
      // 前提：压缩真的发生了（否则锚点不会被清零，用例测不出顺序）
      expect(ctxMgr.messageCount()).toBeLessThan(25);
      expect(lookupAdmittedCeiling(MODEL, URL_A)).toBe(663_013);
      expect(ctxMgr.getMaxTokens()).toBe(663_013);
    }, 15_000);
  }
});

describe("T3：请求前确实剥掉末尾内部 ack", () => {
  it("历史以 compact ack 收尾：发出的请求不以那条 assistant 结尾", async () => {
    const sent: Message[][] = [];
    const preload: Message[] = [
      {
        role: "user",
        content: [{ type: "text", text: "[对话摘要] 之前做了 X" }],
        _meta: { origin: "compact-summary" },
      },
      {
        role: "assistant",
        content: [{ type: "text", text: "好的，我已了解之前的上下文。" }],
        _meta: { origin: "compact-summary" },
      },
    ];
    const { cfg } = makeLoop({ preload, sent });
    await drain(cfg);
    expect(sent.length).toBeGreaterThan(0);
    const last = sent[0]![sent[0]!.length - 1]!;
    expect(last.role).toBe("user");
  });
});

describe("D5：compact_boundary 接在 user 之后会被识别出来", () => {
  it("尾部 user → true；尾部 assistant / 空 → false", () => {
    const u: Message = { role: "user", content: [{ type: "text", text: "a" }] };
    const a: Message = { role: "assistant", content: [{ type: "text", text: "b" }] };
    expect(compactBoundaryBreaksAlternation([u])).toBe(true);
    expect(compactBoundaryBreaksAlternation([u, a])).toBe(false);
    expect(compactBoundaryBreaksAlternation([])).toBe(false);
  });
});
