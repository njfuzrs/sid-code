/**
 * eval-judge 单测
 *
 * 覆盖几类 regression：
 * - gradeAnchorHit: 长锚点表不应惩罚命中任意一项的回答（case_007/028）
 * - gradeToolCompliance: sideband metadata 缺失时给 score:null（不再兜底 1.0）
 * - gradeToolCompliance: any_of 模式下命中任一即满分（case_030 诚实兜底）
 * - aggregate: 跳过 score === null 的维度，按剩余权重归一化
 */

import { describe, test, expect } from "bun:test";
import {
  gradeAnchorHit,
  gradeToolCompliance,
  gradeEfficiency,
  gradeCost,
  aggregate,
  type DimScore,
} from "./eval-judge.ts";

describe("gradeAnchorHit", () => {
  test("无锚点直接满分", () => {
    const r = gradeAnchorHit("anything", []);
    expect(r.score).toBe(1.0);
    expect(r.pass).toBe(true);
  });

  test("一个都没命中得 0", () => {
    const r = gradeAnchorHit("foo bar baz", ["xxx", "yyy"]);
    expect(r.score).toBe(0);
    expect(r.pass).toBe(false);
  });

  test("命中 1/2 得 0.5（基础合格分）", () => {
    const r = gradeAnchorHit("foo", ["foo", "bar"]);
    expect(r.score).toBe(0.5);
    expect(r.pass).toBe(true);
  });

  test("命中 2/2 得满分", () => {
    const r = gradeAnchorHit("foo bar", ["foo", "bar"]);
    expect(r.score).toBe(1.0);
  });

  test("regression case_007: 长锚点表（10 个）命中 4 个不应被惩罚", () => {
    const anchors = [
      "src/llm/quota.ts", "QuotaManager", "QuotaCheckResult", "AlertLevel",
      "quota", "check(", "ratio", ">=", "exceeded", "1.0",
    ];
    const output = "边界条件：当 ratio >= 1.0 时返回 exceeded";
    const r = gradeAnchorHit(output, anchors);
    expect(r.score).not.toBeNull();
    expect(r.score!).toBeGreaterThan(0.6);
    expect(r.pass).toBe(true);
  });

  test("regression case_028: 5 个锚点命中 1 个仍合格", () => {
    const anchors = ["src/cli.ts", "src/app.ts", "src/memory/store.ts", "MemoryStore", "import"];
    const output = "MemoryStore 在 cli.ts 和 app.ts 中被多处使用";
    const r = gradeAnchorHit(output, anchors);
    expect(r.pass).toBe(true);
    expect(r.score).not.toBeNull();
    expect(r.score!).toBeGreaterThanOrEqual(0.5);
  });

  test("命中数达到满分阈值即给 1.0", () => {
    const anchors = ["a", "b", "c", "d"];
    const r = gradeAnchorHit("a b", anchors);
    expect(r.score).toBe(1.0);
  });

  test("锚点表只有 1 项，命中即得 0.5（保留单锚点的鉴别度）", () => {
    const r = gradeAnchorHit("foo", ["foo"]);
    expect(r.score).not.toBeNull();
    expect(r.score!).toBeGreaterThanOrEqual(0.5);
    expect(r.pass).toBe(true);
  });
});

describe("gradeToolCompliance", () => {
  const emptyMeta = { tools_used: [], files_edited: [], total_steps: 0, total_tokens: 0 };

  test("sideband metadata 缺失（全 0）→ score: null（不再兜底 1.0，避免污染均值）", () => {
    const r = gradeToolCompliance(emptyMeta, {
      mustCallTools: ["grep"],
      mustNotCallTools: ["bash"],
    });
    expect(r.score).toBeNull();
    expect(r.pass).toBe(false);
    expect(r.reason).toContain("sideband metadata 缺失");
  });

  test("正常合规（all_of 默认）", () => {
    const meta = { tools_used: ["read", "grep"], files_edited: [], total_steps: 5, total_tokens: 1000 };
    const r = gradeToolCompliance(meta, { mustCallTools: ["read", "grep"] });
    expect(r.score).toBe(1.0);
  });

  test("all_of 模式下漏调一个工具按比例扣分", () => {
    const meta = { tools_used: ["read"], files_edited: [], total_steps: 5, total_tokens: 1000 };
    const r = gradeToolCompliance(meta, { mustCallTools: ["read", "grep"] });
    expect(r.score).toBe(0.8);
  });

  test("any_of 模式下命中任一即满分（修复 case_030 诚实兜底）", () => {
    const meta = { tools_used: ["glob"], files_edited: [], total_steps: 3, total_tokens: 500 };
    const r = gradeToolCompliance(meta, {
      mustCallTools: ["grep", "glob", "ls", "read"],
      mustCallMode: "any_of",
    });
    expect(r.score).toBe(1.0);
  });

  test("any_of 模式下一个都没命中扣 0.4", () => {
    const meta = { tools_used: ["bash"], files_edited: [], total_steps: 3, total_tokens: 500 };
    const r = gradeToolCompliance(meta, {
      mustCallTools: ["grep", "glob", "ls", "read"],
      mustCallMode: "any_of",
    });
    expect(r.score).toBe(0.6);
  });

  test("禁止的工具被使用扣 0.3", () => {
    const meta = { tools_used: ["read", "bash"], files_edited: [], total_steps: 5, total_tokens: 1000 };
    const r = gradeToolCompliance(meta, {
      mustCallTools: ["read"],
      mustNotCallTools: ["bash"],
    });
    expect(r.score).not.toBeNull();
    expect(r.score!).toBeCloseTo(0.7, 5);
  });

  test("禁止修改的文件被改扣 0.5", () => {
    const meta = { tools_used: ["edit"], files_edited: ["src/llm/quota.ts"], total_steps: 5, total_tokens: 1000 };
    const r = gradeToolCompliance(meta, {
      mustNotModifyFiles: ["src/"],
    });
    expect(r.score).toBe(0.5);
  });
});

describe("gradeEfficiency", () => {
  test("无轨迹数据 → score: null（不再兜底 1.0）", () => {
    const r = gradeEfficiency({ tools_used: [], files_edited: [], total_steps: 0, total_tokens: 0 }, 15);
    expect(r.score).toBeNull();
    expect(r.pass).toBe(false);
  });

  test("步数在预期内得 1.0", () => {
    const r = gradeEfficiency({ tools_used: ["read"], files_edited: [], total_steps: 10, total_tokens: 1000 }, 15);
    expect(r.score).toBe(1.0);
  });
});

describe("gradeCost", () => {
  test("无 token 数据 → score: null（不再兜底 1.0）", () => {
    const r = gradeCost({ tools_used: [], files_edited: [], total_steps: 0, total_tokens: 0 });
    expect(r.score).toBeNull();
    expect(r.pass).toBe(false);
  });

  test("低消耗满分", () => {
    const r = gradeCost({ tools_used: [], files_edited: [], total_steps: 5, total_tokens: 100_000 });
    expect(r.score).toBe(1.0);
  });
});

describe("aggregate - null 维度跳过", () => {
  test("error case：anchor=0 + 其它全 null → 总分 0（不再 ~2.5）", () => {
    // 模拟挂掉的 case：output 是 [ERROR]、meta 全空
    const dims: Record<string, DimScore> = {
      anchor_hit: { pass: false, score: 0, reason: "0 命中" },
      rubric_score: { pass: false, score: null, reason: "judge 不可用" },
      tool_compliance: { pass: false, score: null, reason: "sideband 缺失" },
      efficiency: { pass: false, score: null, reason: "无轨迹" },
      cost: { pass: false, score: null, reason: "无 token" },
    };
    const { score, namedScores } = aggregate(dims);
    // 只有 anchor 维度有效，权重 1.5，分 0 → 0/1.5 * 5 = 0
    expect(score).toBe(0);
    expect(namedScores.rubric_score).toBeNull();
    expect(namedScores.tool_compliance).toBeNull();
    expect(namedScores.efficiency).toBeNull();
    expect(namedScores.cost).toBeNull();
  });

  test("全部 null → score: null（无法评分）", () => {
    const dims: Record<string, DimScore> = {
      anchor_hit: { pass: false, score: null, reason: "x" },
      rubric_score: { pass: false, score: null, reason: "x" },
    };
    const { score } = aggregate(dims);
    expect(score).toBeNull();
  });

  test("正常 5 维全有效 → 加权归一化到 5 分制", () => {
    const dims: Record<string, DimScore> = {
      anchor_hit: { pass: true, score: 1.0, reason: "" },
      rubric_score: { pass: true, score: 1.0, reason: "" },
      tool_compliance: { pass: true, score: 1.0, reason: "" },
      efficiency: { pass: true, score: 1.0, reason: "" },
      cost: { pass: true, score: 1.0, reason: "" },
    };
    const { score } = aggregate(dims);
    expect(score).toBe(5.0);
  });

  test("rubric=null（限流）但其它正常 → 不污染总分（与旧版兜底 1.0 不同）", () => {
    const dims: Record<string, DimScore> = {
      anchor_hit: { pass: true, score: 1.0, reason: "" },
      rubric_score: { pass: false, score: null, reason: "judge 不可用" },
      tool_compliance: { pass: true, score: 0.8, reason: "" },
      efficiency: { pass: true, score: 1.0, reason: "" },
      cost: { pass: true, score: 1.0, reason: "" },
    };
    // 旧版：rubric=1.0 兜底 → 总分接近满分
    // 新版：跳过 rubric，按剩余 4 维权重 (1.5+1.5+1.0+0.5=4.5) 归一化
    // (1.0*1.5 + 0.8*1.5 + 1.0*1.0 + 1.0*0.5) / 4.5 * 5 = 4.2 / 4.5 * 5 ≈ 4.67
    const { score } = aggregate(dims);
    expect(score).not.toBeNull();
    expect(score!).toBeGreaterThan(4.5);
    expect(score!).toBeLessThan(4.8);
  });
});

