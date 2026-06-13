/**
 * DF2 大 diff 上下文折叠逻辑单测
 *
 * 验证 planDiffWithContextCollapse：连续未变更 context 超过阈值时折叠中段,
 * 首尾各保留 keep 行;add/del 行与短 context run 原样保留。
 */

import { test, expect, describe } from "bun:test";
import { planDiffWithContextCollapse } from "../../src/ui/components/DiffRenderer.tsx";

type L = { type: "add" | "del" | "context" | "hunk" | "other"; content: string };

function ctx(n: number): L[] {
  return Array.from({ length: n }, (_, i) => ({ type: "context" as const, content: `ctx${i}` }));
}

describe("planDiffWithContextCollapse 上下文折叠", () => {
  test("短 context run(≤阈值)不折叠,原样保留", () => {
    const lines: L[] = ctx(10); // 默认阈值 10,等于不折叠
    const plan = planDiffWithContextCollapse(lines);
    expect(plan.every((p) => p.kind === "line")).toBe(true);
    expect(plan.length).toBe(10);
  });

  test("超长 context run 折叠:首尾各保留 3 行,中间一个 collapsed", () => {
    const lines: L[] = ctx(20); // 20 > 10
    const plan = planDiffWithContextCollapse(lines);
    // 3 行 + 1 collapsed + 3 行 = 7 项
    expect(plan.length).toBe(7);
    expect(plan[0].kind).toBe("line");
    expect(plan[2].kind).toBe("line");
    expect(plan[3].kind).toBe("collapsed");
    expect(plan[3].hiddenCount).toBe(14); // 20 - 3*2
    expect(plan[4].kind).toBe("line");
    expect(plan[6].kind).toBe("line");
  });

  test("add/del 行永不折叠", () => {
    const lines: L[] = [
      { type: "add", content: "+a" },
      ...ctx(20),
      { type: "del", content: "-d" },
    ];
    const plan = planDiffWithContextCollapse(lines);
    expect(plan[0]).toMatchObject({ kind: "line", line: { type: "add" } });
    expect(plan[plan.length - 1]).toMatchObject({ kind: "line", line: { type: "del" } });
    // 中间 context 被折叠为 3 + collapsed + 3
    const collapsed = plan.filter((p) => p.kind === "collapsed");
    expect(collapsed.length).toBe(1);
    expect(collapsed[0].hiddenCount).toBe(14);
  });

  test("origIndex 保留原始下标(供 pairMap 查询)", () => {
    const lines: L[] = [
      { type: "del", content: "-d" }, // index 0
      { type: "add", content: "+a" }, // index 1
      ...ctx(20), // index 2..21
    ];
    const plan = planDiffWithContextCollapse(lines);
    expect(plan[0].origIndex).toBe(0);
    expect(plan[1].origIndex).toBe(1);
    // context 首段从原始下标 2 开始
    expect(plan[2].origIndex).toBe(2);
    expect(plan[3].origIndex).toBe(3);
    expect(plan[4].origIndex).toBe(4);
    // 折叠后尾段最后一行应是原始下标 21
    const lastLine = plan[plan.length - 1];
    expect(lastLine.origIndex).toBe(21);
  });

  test("多个独立超长 context run 各自折叠", () => {
    const lines: L[] = [
      ...ctx(15),
      { type: "add", content: "+x" },
      ...ctx(15),
    ];
    const plan = planDiffWithContextCollapse(lines);
    const collapsed = plan.filter((p) => p.kind === "collapsed");
    expect(collapsed.length).toBe(2);
    expect(collapsed[0].hiddenCount).toBe(9); // 15 - 6
    expect(collapsed[1].hiddenCount).toBe(9);
  });

  test("自定义阈值与保留行数", () => {
    const lines: L[] = ctx(8);
    const plan = planDiffWithContextCollapse(lines, 4, 1);
    // 8 > 4,保留首尾各 1 行 + collapsed(隐藏 6)
    expect(plan.length).toBe(3);
    expect(plan[1].kind).toBe("collapsed");
    expect(plan[1].hiddenCount).toBe(6);
  });
});
