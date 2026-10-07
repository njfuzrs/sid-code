/**
 * 缺陷 31：digest 的 POLL_TOOLS 与循环检测的 CONDITIONALLY_EXEMPT_TOOLS 对账。
 *
 * 两份名单语义不同、刻意不合并；这里钉住的是「差异必须是登记过的」——
 * 任一侧增删一个名字而没同步登记，本测试红，避免 pollRatio 分子静默漂移。
 */
import { describe, test, expect } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { POLL_TOOLS, POLL_TOOLS_VS_CONDITIONAL_EXEMPT } from "@sid-code/core/trace/digest.ts";
import { CONDITIONALLY_EXEMPT_TOOLS } from "@sid-code/core/agent/loop-detection.ts";

const sorted = (xs: Iterable<string>) => [...xs].sort();

describe("缺陷 31：POLL_TOOLS ↔ CONDITIONALLY_EXEMPT_TOOLS 对账", () => {
  test("POLL_TOOLS − 条件豁免 = 已登记的 onlyInPoll", () => {
    const diff = [...POLL_TOOLS].filter((t) => !CONDITIONALLY_EXEMPT_TOOLS.has(t));
    expect(sorted(diff)).toEqual(sorted(POLL_TOOLS_VS_CONDITIONAL_EXEMPT.onlyInPoll));
  });

  test("条件豁免 − POLL_TOOLS = 已登记的 onlyInConditionalExempt", () => {
    const diff = [...CONDITIONALLY_EXEMPT_TOOLS].filter((t) => !POLL_TOOLS.has(t));
    expect(sorted(diff)).toEqual(sorted(POLL_TOOLS_VS_CONDITIONAL_EXEMPT.onlyInConditionalExempt));
  });

  test("POLL_TOOLS 每个名字都是真实注册的工具名（防拼错 / 工具已删）", () => {
    const toolDir = join(import.meta.dir, "../../src/tool");
    const names = new Set<string>();
    for (const f of readdirSync(toolDir)) {
      if (!f.endsWith(".ts")) continue;
      const src = readFileSync(join(toolDir, f), "utf8");
      for (const m of src.matchAll(/\bname\(\)[^{]*\{\s*return "([a-z_]+)"/g)) names.add(m[1]!);
    }
    // 反向自证：扫描式确实能抓到工具名
    expect(names.has("bash")).toBe(true);
    for (const t of POLL_TOOLS) expect(names.has(t), t).toBe(true);
  });
});
