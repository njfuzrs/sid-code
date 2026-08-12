/**
 * diff 折叠档裁剪逻辑单测（foldRenderPlan）
 *
 * 验证 write/edit 结果 diff 的「默认折叠 + ctrl+o 展开」核心逻辑：
 * 按 maxLines 同步保留头部计划项、正确统计被裁掉的实际行数（collapsed 项按 hiddenCount 计）。
 *
 * 背景：write 新建文件曾一次性把整份内容灌进 TUI（DiffRenderer 直渲、绕过折叠）。
 * 修复后由 DiffRenderer 内部同步裁剪（Static 安全，不用异步测高的 MaxSizedBox）。
 */

import { test, expect, describe } from "bun:test";
import {
  foldRenderPlan,
  type DiffRenderPlanItem,
} from "@sid-code/cli/ui/components/DiffRenderer.tsx";

/** 造 N 个 line 计划项 */
function lines(n: number): DiffRenderPlanItem[] {
  return Array.from({ length: n }, (_, i) => ({
    kind: "line" as const,
    line: { type: "add" as const, content: `+line${i}` },
    origIndex: i,
  }));
}

describe("foldRenderPlan 折叠档裁剪", () => {
  test("maxLines===undefined（全展开档）不裁剪", () => {
    const plan = lines(100);
    const r = foldRenderPlan(plan, undefined);
    expect(r.plan.length).toBe(100);
    expect(r.foldedLineCount).toBe(0);
    // 原样返回同一引用（不必要地复制会破坏 Static 的 items 引用稳定）
    expect(r.plan).toBe(plan);
  });

  test("计划不超 maxLines 时不裁剪", () => {
    const plan = lines(10);
    const r = foldRenderPlan(plan, 16);
    expect(r.plan.length).toBe(10);
    expect(r.foldedLineCount).toBe(0);
    expect(r.plan).toBe(plan);
  });

  test("超出 maxLines：保留头部 N 行，foldedLineCount=剩余行数", () => {
    const plan = lines(50); // 新建 50 行文件
    const r = foldRenderPlan(plan, 16);
    expect(r.plan.length).toBe(16);
    expect(r.foldedLineCount).toBe(34); // 50 - 16
    // 保留的是**头部**（origIndex 0..15），不是尾部
    expect(r.plan[0].origIndex).toBe(0);
    expect(r.plan[15].origIndex).toBe(15);
  });

  test("边界：正好等于 maxLines 不裁剪", () => {
    const plan = lines(16);
    const r = foldRenderPlan(plan, 16);
    expect(r.plan.length).toBe(16);
    expect(r.foldedLineCount).toBe(0);
  });

  test("collapsed 项按 hiddenCount 计入被折叠行数（不是计 1）", () => {
    // 前 3 个 line + 1 个 collapsed（隐藏 20 行上下文）+ 5 个 line
    const plan: DiffRenderPlanItem[] = [
      ...lines(3),
      { kind: "collapsed", hiddenCount: 20 },
      ...lines(5),
    ];
    // maxLines=2 → 保留前 2 项(都是 line)，裁掉 [line, collapsed(20), 5*line]
    const r = foldRenderPlan(plan, 2);
    expect(r.plan.length).toBe(2);
    // 被裁掉：1 个 line(1) + collapsed(20) + 5 个 line(5) = 26
    expect(r.foldedLineCount).toBe(26);
  });

  test("collapsed.hiddenCount 缺省按 0 计（不 NaN）", () => {
    const plan: DiffRenderPlanItem[] = [
      ...lines(1),
      { kind: "collapsed" }, // 无 hiddenCount
    ];
    const r = foldRenderPlan(plan, 1);
    expect(r.foldedLineCount).toBe(0);
    expect(Number.isNaN(r.foldedLineCount)).toBe(false);
  });
});
