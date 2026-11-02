/**
 * 压缩摘要覆盖率：锚点匹配口径
 *
 * 缺陷：锚点取自 `tool_use.input.file_path`（绝对路径），按原样子串匹配摘要；摘要是自然语言，
 * 写的是文件名。于是覆盖率必然塌到 0。2026-11-02 实测 23 次 `[COMPACT_QUALITY]` 里 15 次 0%、
 * 其余 ≤ 33%，全部告警；而对应摘要里那些文件名都在（`runner.ts` 出现 11 次）。
 *
 * 下面的 fixture 照 `20261028-164141-4e1fa953` 08:49:33 那次的形态构造：
 * 4 个绝对路径锚点，摘要里只写文件名。
 */
import { describe, test, expect } from "bun:test";
import { checkCompactQuality } from "../../../src/query/compact/quality-check.ts";
import type { Message } from "../../../src/llm/types.ts";

const ROOT = "/Users/someone/Code/wt/f3-flash-L1f-2-sid/packages/core/src/hook";

function readCalls(paths: string[]): Message[] {
  return [
    {
      role: "assistant",
      content: paths.map((p, i) => ({
        type: "tool_use",
        id: `t${i}`,
        name: "Read",
        input: { file_path: p },
      })),
    } as unknown as Message,
  ];
}

describe("覆盖率锚点：绝对路径对文件名", () => {
  const anchors = [
    `${ROOT}/aggregator.ts`,
    `${ROOT}/planner.ts`,
    `${ROOT}/ssrf-guard.ts`,
    `${ROOT}/async-registry.ts`,
  ];
  const summary =
    "3. 文件与代码段\n   - 已全文读过：planner.ts、aggregator.ts、ssrf-guard.ts、async-registry.ts。\n" +
    "   - aggregator.ts 的钩子阻止语义聚合一致性待核。";

  test("摘要只写文件名 → 覆盖率 1，且全部由 basename 档命中", () => {
    const r = checkCompactQuality(readCalls(anchors), summary);
    expect(r.totalAnchors).toBe(4);
    expect(r.coverage).toBe(1);
    expect(r.matchedBy).toEqual({ exact: 0, relative: 0, basename: 4 });
    expect(r.missedSamples).toEqual([]);
  });

  test("摘要写相对路径 → 由 relative 档命中", () => {
    const r = checkCompactQuality(
      readCalls([`${ROOT}/runner.ts`]),
      "改动集中在 core/src/hook/runner.ts 的双阶段超时。",
    );
    expect(r.coverage).toBe(1);
    expect(r.matchedBy.relative).toBe(1);
  });

  test("摘要原样写了绝对路径 → exact 档（旧口径仍然成立）", () => {
    const r = checkCompactQuality(readCalls([`${ROOT}/runner.ts`]), `读了 ${ROOT}/runner.ts`);
    expect(r.matchedBy).toEqual({ exact: 1, relative: 0, basename: 0 });
  });

  test("摘要确实漏了文件 → 仍然算未覆盖（放宽口径没有把真塌陷也抹掉）", () => {
    const r = checkCompactQuality(readCalls(anchors), "用户要求做只读审计，尚未开始。");
    expect(r.coverage).toBe(0);
    expect(r.missedSamples).toHaveLength(4);
  });
});

describe("覆盖率锚点：basename 档的边界", () => {
  test("泛名 types.ts 不靠 basename 单独命中：两个不同目录的 types.ts 不会都算覆盖", () => {
    const r = checkCompactQuality(
      readCalls(["/r/packages/a/src/types.ts", "/r/packages/b/src/types.ts"]),
      "改了 types.ts 里的接口定义。",
    );
    expect(r.coveredAnchors).toBe(0);
  });

  test("泛名带上一级目录就能命中，且只命中对应那一个", () => {
    const r = checkCompactQuality(
      readCalls(["/r/packages/a/src/hook/types.ts", "/r/packages/b/src/tool/types.ts"]),
      "改了 hook/types.ts 里的接口定义。",
    );
    expect(r.coveredAnchors).toBe(1);
    expect(r.matchedBy.relative).toBe(1);
    expect(r.missedSamples).toEqual(["/r/packages/b/src/tool/types.ts"]);
  });

  test("basename 必须是独立 token：runner.ts 不命中 my-runner.ts", () => {
    const r = checkCompactQuality(readCalls(["/r/src/runner.ts"]), "只看了 my-runner.ts。");
    expect(r.coveredAnchors).toBe(0);
  });

  test("过短的文件名（< 6 字符）不走 basename 档", () => {
    const r = checkCompactQuality(readCalls(["/r/src/a.ts"]), "读了 a.ts。");
    expect(r.coveredAnchors).toBe(0);
  });

  test("目录锚点（无扩展名）不走 basename 档", () => {
    const r = checkCompactQuality(readCalls(["/r/packages/core/src/hook"]), "看了 hook 目录。");
    expect(r.coveredAnchors).toBe(0);
  });

  test("Windows 风格路径也能按文件名命中", () => {
    const r = checkCompactQuality(
      readCalls(["C:\\r\\packages\\core\\src\\hook\\runner.ts"]),
      "runner.ts 的超时清理有遗漏。",
    );
    expect(r.matchedBy.basename).toBe(1);
  });
});

describe("matchedBy 计数自洽", () => {
  test("三档之和 == coveredAnchors", () => {
    const r = checkCompactQuality(
      readCalls([
        `${ROOT}/runner.ts`,
        `${ROOT}/planner.ts`,
        `${ROOT}/aggregator.ts`,
        `${ROOT}/x-missing.ts`,
      ]),
      `原样 ${ROOT}/runner.ts；相对 src/hook/planner.ts；文件名 aggregator.ts。`,
    );
    const { exact, relative, basename } = r.matchedBy;
    expect(exact + relative + basename).toBe(r.coveredAnchors);
    expect(r.matchedBy).toEqual({ exact: 1, relative: 1, basename: 1 });
    expect(r.coveredAnchors).toBe(3);
  });

  test("无锚点时 matchedBy 全 0、coverage 1（空样本由调用方按 totalAnchors 过滤）", () => {
    const r = checkCompactQuality([], "任意摘要");
    expect(r).toEqual({
      totalAnchors: 0,
      coveredAnchors: 0,
      coverage: 1,
      missedSamples: [],
      matchedBy: { exact: 0, relative: 0, basename: 0 },
    });
  });
});
