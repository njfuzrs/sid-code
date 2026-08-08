/**
 * 跨会话缓存视图（P2-4）测试
 *
 * 本模块存在的理由是"数字必须带可信度标注"——博客里"luna 命中率 2.2%，判定网关
 * 后端不支持前缀缓存"那个错误结论，正是因为账本只给了一个裸数字。所以这里的测试
 * 重点不是"算得对不对"（那是 usage-aggregator 的职责），而是**该打的标注有没有打**。
 *
 * 经 SID_CODE_USAGE_LEDGER / SID_CODE_CACHE_BREAKS 重定向到 tmp，不触碰真实 ~/.sid-code。
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { buildCacheReport, renderCacheSection } from "../../src/trace/cache-report.ts";
import type { UsageLedgerEntry } from "../../src/telemetry/usage-ledger.ts";

let dir: string;
// 存/恢复原值，不无条件 delete —— bun test 同进程跑多文件，delete 会抹掉别人的隔离
const savedLedger = process.env.SID_CODE_USAGE_LEDGER;
const savedBreaks = process.env.SID_CODE_CACHE_BREAKS;

function entry(over: Partial<UsageLedgerEntry> & { sessionId: string }): UsageLedgerEntry {
  return {
    ts: 1_700_000_000,
    model: "glm-5.2",
    provider: "openai",
    promptTotal: 10000,
    cacheHit: 8000,
    cacheWrite: 0,
    uncachedInput: 2000,
    output: 500,
    costUSD: 0.01,
    savingsUSD: 0.02,
    durationMs: 1000,
    ...over,
  };
}

function writeLedger(entries: UsageLedgerEntry[]): void {
  writeFileSync(
    process.env.SID_CODE_USAGE_LEDGER!,
    entries.map((e) => JSON.stringify(e)).join("\n") + "\n",
    "utf-8",
  );
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "sid-cache-report-"));
  process.env.SID_CODE_USAGE_LEDGER = join(dir, "usage-ledger.jsonl");
  process.env.SID_CODE_CACHE_BREAKS = join(dir, "cache-breaks.jsonl");
});

afterEach(() => {
  if (savedLedger === undefined) delete process.env.SID_CODE_USAGE_LEDGER;
  else process.env.SID_CODE_USAGE_LEDGER = savedLedger;
  if (savedBreaks === undefined) delete process.env.SID_CODE_CACHE_BREAKS;
  else process.env.SID_CODE_CACHE_BREAKS = savedBreaks;
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
});

describe("P2-4 缓存视图：命中率口径", () => {
  test("命中率分母是 promptTotal，不是会话数或请求数", () => {
    writeLedger([
      // 一个大会话低命中 + 一个小会话高命中：按会话平均会得出接近 50%，
      // 按 token 加权才是真实的 (1000+900)/(100000+1000) ≈ 1.9%
      entry({ sessionId: "big", promptTotal: 100000, cacheHit: 1000 }),
      entry({ sessionId: "small", promptTotal: 1000, cacheHit: 900 }),
    ]);
    const r = buildCacheReport();
    const glm = r.models.find((m) => m.model === "glm-5.2")!;
    expect(glm.hitRate).toBeCloseTo(1900 / 101000, 6);
    expect(glm.hitRate).toBeLessThan(0.05);
  });

  test("promptTotal=0 给 null 而非 0（没有分母就没有比率）", () => {
    writeLedger([entry({ sessionId: "a", promptTotal: 0, cacheHit: 0 })]);
    const r = buildCacheReport();
    expect(r.models[0]!.hitRate).toBeNull();
    // 落 0 会被读成"命中率 0%"，与"没有数据"混淆
    expect(r.models[0]!.hitRate).not.toBe(0);
  });

  test("账本为空时不报 0%，明确说是空账本", () => {
    writeLedger([]);
    const out = renderCacheSection();
    expect(out).toContain("账本为空");
    expect(out).not.toContain("命中率 0.0%");
  });
});

describe("P2-4 可信度标注（本模块的核心职责）", () => {
  test("命中率异常低时给出两个待查方向，不直接断言渠道不支持", () => {
    // 复刻 luna 那次的形状：样本充足（>=5 会话）但命中率 2.2%
    writeLedger(
      Array.from({ length: 8 }, (_, i) =>
        entry({ sessionId: `s${i}`, model: "gpt-5.6-luna", promptTotal: 100000, cacheHit: 2200 }),
      ),
    );
    const r = buildCacheReport();
    const luna = r.models.find((m) => m.model === "gpt-5.6-luna")!;
    expect(luna.caveats.length).toBeGreaterThan(0);
    const caveat = luna.caveats.join(" ");
    // 必须同时提"本地漏采"与"渠道不支持"两个方向 —— 只提后者就是那次错误结论
    expect(caveat).toContain("漏采");
    expect(caveat).toContain("渠道");
    // 不得给出结论式断言
    expect(caveat).not.toContain("不支持前缀缓存（已确认");
  });

  test("样本不足时只标注不下结论（哪怕命中率同样低）", () => {
    writeLedger([entry({ sessionId: "a", model: "new-model", promptTotal: 100000, cacheHit: 100 })]);
    const r = buildCacheReport();
    const m = r.models[0]!;
    expect(m.caveats.some((c) => c.includes("样本仅 1 会话"))).toBe(true);
    // 样本不足时不叠加"命中率异常低"的待查提示（1 个会话的冷启动本就该 0 命中）
    expect(m.caveats.some((c) => c.includes("命中率异常低"))).toBe(false);
  });

  test("有命中但省钱为 0 → 提示定价表可能缺该模型", () => {
    writeLedger(
      Array.from({ length: 6 }, (_, i) =>
        entry({ sessionId: `p${i}`, model: "claude-opus-5", cacheHit: 8000, savingsUSD: 0, costUSD: 1 }),
      ),
    );
    const r = buildCacheReport();
    expect(r.models[0]!.caveats.some((c) => c.includes("定价表"))).toBe(true);
  });

  test("渲染时 caveat 紧跟对应模型行（数字与可信度必须同时出现）", () => {
    writeLedger(
      Array.from({ length: 8 }, (_, i) =>
        entry({ sessionId: `s${i}`, model: "gpt-5.6-luna", promptTotal: 100000, cacheHit: 2200 }),
      ),
    );
    const lines = renderCacheSection({ noColor: true }).split("\n");
    const idx = lines.findIndex((l) => l.includes("gpt-5.6-luna"));
    expect(idx).toBeGreaterThanOrEqual(0);
    // 下一行就是 ⚠：分开放会让人只抄走数字
    expect(lines[idx + 1]).toContain("⚠");
  });
});

describe("P2-4 中断归因分布", () => {
  test("结构化与旧文案记录数分别可见（P0-2 迁移进度）", () => {
    const path = process.env.SID_CODE_CACHE_BREAKS!;
    writeFileSync(
      path,
      [
        JSON.stringify({
          ts: 1, model: "m", dropTokens: 100, dropPercent: 90,
          changes: ["本地前缀 hash 未变（x），命中下降疑为服务端缓存波动"],
          previousCacheReadTokens: 1000, currentCacheReadTokens: 100,
        }),
        JSON.stringify({
          ts: 2, model: "m", dropTokens: 100, dropPercent: 90,
          changes: ["System prompt 变化"], categories: ["system_prompt"],
          previousCacheReadTokens: 1000, currentCacheReadTokens: 100,
        }),
      ].join("\n") + "\n",
      "utf-8",
    );
    writeLedger([entry({ sessionId: "a" })]);

    const r = buildCacheReport();
    expect(r.breaks.legacyCount).toBe(1);
    expect(r.breaks.structuredCount).toBe(1);
    expect(r.breaks.byCategory.server_fluctuation).toBe(1);
    expect(r.breaks.byCategory.system_prompt).toBe(1);
  });

  test("渲染标注哪类可优化、哪类本地不可控", () => {
    const path = process.env.SID_CODE_CACHE_BREAKS!;
    writeFileSync(
      path,
      JSON.stringify({
        ts: 1, model: "m", dropTokens: 100, dropPercent: 90,
        changes: ["x"], categories: ["server_fluctuation"],
        previousCacheReadTokens: 1000, currentCacheReadTokens: 100,
      }) + "\n",
      "utf-8",
    );
    writeLedger([entry({ sessionId: "a" })]);

    const out = renderCacheSection({ noColor: true });
    // 不标注会让"服务端波动占比高"被读成"缓存坏了"而去改本地代码
    expect(out).toContain("本地不可控");
  });
});
