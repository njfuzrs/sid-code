/**
 * eval-judge 单测
 *
 * 覆盖几类 regression：
 * - gradeAnchorHit: 长锚点表不应惩罚命中任意一项的回答（case_007/028）
 * - gradeToolCompliance: sideband metadata 缺失时不应扣分（case_002/005 0.6 系统性偏差）
 * - gradeToolCompliance: any_of 模式下命中任一即满分（case_030 诚实兜底）
 */

import { describe, test, expect } from "bun:test";
import { gradeAnchorHit, gradeToolCompliance } from "./eval-judge.ts";

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
    // case_007 锚点：src/llm/quota.ts, QuotaManager, QuotaCheckResult, AlertLevel,
    //                 quota, check(, ratio, >=, exceeded, 1.0
    // deepseek 答案命中 ratio / >= / exceeded / 1.0 = 4 个
    // 旧实现：score = 4/10 = 0.4 → 严重不足，不公平
    // 新实现：满分阈值 = max(2, ceil(10*0.5)) = 5；命中 4 → (4-1)/(5-1)*0.5+0.5 = 0.875
    const anchors = [
      "src/llm/quota.ts", "QuotaManager", "QuotaCheckResult", "AlertLevel",
      "quota", "check(", "ratio", ">=", "exceeded", "1.0",
    ];
    const output = "边界条件：当 ratio >= 1.0 时返回 exceeded";
    const r = gradeAnchorHit(output, anchors);
    expect(r.score).toBeGreaterThan(0.6); // 不应该被判"严重不足"
    expect(r.pass).toBe(true);
  });

  test("regression case_028: 5 个锚点命中 1 个仍合格", () => {
    const anchors = ["src/cli.ts", "src/app.ts", "src/memory/store.ts", "MemoryStore", "import"];
    const output = "MemoryStore 在 cli.ts 和 app.ts 中被多处使用";
    const r = gradeAnchorHit(output, anchors);
    expect(r.pass).toBe(true);
    expect(r.score).toBeGreaterThanOrEqual(0.5);
  });

  test("命中数达到满分阈值即给 1.0", () => {
    const anchors = ["a", "b", "c", "d"];
    // 满分阈值 = max(2, ceil(4*0.5)) = 2
    const r = gradeAnchorHit("a b", anchors);
    expect(r.score).toBe(1.0);
  });

  test("锚点表只有 1 项，命中即得 0.5（保留单锚点的鉴别度）", () => {
    // 只有 1 个锚点时，hitCount === 1 == fullScoreThreshold(2 的下限)，渐进逻辑不适用
    // 但语义上"命中唯一锚点"应该满分；这里给 0.5 是合规但偏严
    // 这条测试只是固定当前行为，避免后续重构悄悄改坏；如要改为 1.0 单锚点也满分，需更新此测试
    const r = gradeAnchorHit("foo", ["foo"]);
    expect(r.score).toBeGreaterThanOrEqual(0.5);
    expect(r.pass).toBe(true);
  });
});

describe("gradeToolCompliance", () => {
  const emptyMeta = { tools_used: [], files_edited: [], total_steps: 0, total_tokens: 0 };

  test("sideband metadata 缺失（全 0）跳过检查得满分（修复 case_002/005 系统性 0.6）", () => {
    const r = gradeToolCompliance(emptyMeta, {
      mustCallTools: ["grep"],
      mustNotCallTools: ["bash"],
    });
    expect(r.score).toBe(1.0);
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
    expect(r.score).toBe(0.8); // 1.0 - 0.4*(1 - 1/2) = 0.8
  });

  test("any_of 模式下命中任一即满分（修复 case_030 诚实兜底）", () => {
    // case_030: 诚实兜底类只要查证过文件不存在就行，用 grep/glob/ls/read 任一都行
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
    expect(r.score).toBeCloseTo(0.7, 5);
  });

  test("禁止修改的文件被改扣 0.5", () => {
    const meta = { tools_used: ["edit"], files_edited: ["src/llm/quota.ts"], total_steps: 5, total_tokens: 1000 };
    const r = gradeToolCompliance(meta, {
      mustNotModifyFiles: ["src/"],
    });
    expect(r.score).toBe(0.5);
  });
});
