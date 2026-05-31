/**
 * B7-8 check-failure-taxonomy-coverage 单测
 *
 * 锁死核心铁律：
 *   - v1 set 14 个编码完整命中（任何漏掉一个都失败 → 防 set 被误改丢编码）
 *   - red 阈值用 ">" 严格大于：刚好 15% 是黄灯（避免一发现就强制升 v2）
 *   - yellow 阈值用 ">=" 包含 5%（5% 是有意义信号）
 *   - 空输入 → green（无证据无判定）
 */
import { describe, test, expect } from "bun:test";
import { classifyCoverage, FAILURE_TAXONOMY_V1, TAXONOMY_VERSION } from "../../scripts/eval/check-failure-taxonomy-coverage";

describe("B7-8 FAILURE_TAXONOMY_V1 集合完整性", () => {
  test("v1 必含 14 个编码（与 docs/eval/失败分类法-v1.md §1 表对齐）", () => {
    const expected = [
      "TS-01", "TS-02", "TS-03",
      "EX-01", "EX-02",
      "CTX-01", "CTX-02",
      "OUT-01", "OUT-02", "OUT-03", "OUT-04",
      "ABORT-01", "ABORT-02",
      "TOOL-01",
    ];
    expect(FAILURE_TAXONOMY_V1.size).toBe(expected.length);
    for (const code of expected) expect(FAILURE_TAXONOMY_V1.has(code)).toBe(true);
  });

  test("版本号是 v1（升级时必须同步 bump）", () => {
    expect(TAXONOMY_VERSION).toBe("v1");
  });
});

describe("B7-8 classifyCoverage 阈值边界", () => {
  const mk = (codes: string[]) => ({
    failure_modes: codes.map((c) => ({ code: c })),
  });

  test("全 known → 0% unknown → green", () => {
    const r = classifyCoverage([mk(["TS-01", "EX-01", "OUT-01", "ABORT-01"])]);
    expect(r.status).toBe("green");
    expect(r.unknownRatio).toBe(0);
    expect(r.knownCount).toBe(4);
    expect(r.unknownCount).toBe(0);
  });

  test("4% unknown → green（< 5% yellow 阈值）", () => {
    // 1 unknown / 25 total = 4%
    const codes = [...Array(24).fill("TS-01"), "NEW-XX-99"];
    const r = classifyCoverage([mk(codes)]);
    expect(r.unknownRatio).toBeCloseTo(0.04, 5);
    expect(r.status).toBe("green");
  });

  test("刚好 5% unknown → yellow（边界 = yellow）", () => {
    // 1 unknown / 20 total = 5%
    const codes = [...Array(19).fill("TS-01"), "NEW-XX-99"];
    const r = classifyCoverage([mk(codes)]);
    expect(r.unknownRatio).toBeCloseTo(0.05, 5);
    expect(r.status).toBe("yellow");
  });

  test("10% unknown → yellow（5%≤x≤15%）", () => {
    // 2 unknown / 20 total = 10%
    const codes = [...Array(18).fill("TS-01"), "NEW-1", "NEW-2"];
    const r = classifyCoverage([mk(codes)]);
    expect(r.unknownRatio).toBeCloseTo(0.10, 5);
    expect(r.status).toBe("yellow");
  });

  test("刚好 15% unknown → yellow（边界 = yellow，不升 v2）", () => {
    // 3 unknown / 20 total = 15%
    const codes = [...Array(17).fill("TS-01"), "NEW-1", "NEW-2", "NEW-3"];
    const r = classifyCoverage([mk(codes)]);
    expect(r.unknownRatio).toBeCloseTo(0.15, 5);
    expect(r.status).toBe("yellow");
  });

  test("16% unknown → red（> 15% 触发 v(N+1) 升级）", () => {
    // 4 unknown / 25 total = 16%
    const codes = [...Array(21).fill("TS-01"), "NEW-1", "NEW-2", "NEW-3", "NEW-4"];
    const r = classifyCoverage([mk(codes)]);
    expect(r.unknownRatio).toBeCloseTo(0.16, 5);
    expect(r.status).toBe("red");
    expect(r.unknownCodes["NEW-1"]).toBe(1);
  });

  test("空输入 → green（total=0，无证据无判定）", () => {
    const r = classifyCoverage([]);
    expect(r.status).toBe("green");
    expect(r.total).toBe(0);
    expect(r.unknownRatio).toBe(0);
  });

  test("跨多 diff 累加 + 按 code 计数", () => {
    const r = classifyCoverage([
      mk(["TS-01", "TS-01", "EX-01"]),
      mk(["TS-01", "OUT-01"]),
    ]);
    expect(r.knownByCode["TS-01"]).toBe(3);
    expect(r.knownByCode["EX-01"]).toBe(1);
    expect(r.knownByCode["OUT-01"]).toBe(1);
    expect(r.knownCount).toBe(5);
  });

  test("空 code / undefined code 字段被忽略（不计入 total）", () => {
    const r = classifyCoverage([
      { failure_modes: [{ code: "" }, { code: undefined }, { code: "TS-01" }] },
    ]);
    expect(r.total).toBe(1);
    expect(r.knownCount).toBe(1);
  });
});
