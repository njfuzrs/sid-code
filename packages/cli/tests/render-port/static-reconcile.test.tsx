/**
 * 契约 R11 / R12（B9 / T0.3，D-3 定案 A）。
 *
 * R11：已完成区 `Static` 的项可以原地重渲。MainScreenLayout 把执行中的 tool_group 直接放进
 * staticItems，完成时靠原地 reconcile 变成终态。换成上游 ink 的 print-once `<Static>`，
 * 工具行会永远停在「执行中」，而布局测试照样全绿 —— 所以这条必须单独钉住。
 *
 * R12：非 TTY 输出每帧写整帧（testing shim 依赖这一点取 lastFrame）。
 */
import { describe, expect, test } from "bun:test";
import React from "react";
import stripAnsi from "strip-ansi";
import { Box, Static, Text } from "@sid-code/cli/ui/render-port/components.ts";
import { render } from "@sid-code/cli/ui/render-port/testing.ts";

const tick = (ms = 30) => new Promise((r) => setTimeout(r, ms));

type Item = { id: string; status: "executing" | "done" };

function Layout({ items, tail }: { items: Item[]; tail: string }) {
  return (
    <Box flexDirection="column">
      <Static items={items}>
        {(item) => (
          <Text key={item.id}>
            {item.id}:{item.status}
          </Text>
        )}
      </Static>
      <Text>{tail}</Text>
    </Box>
  );
}

const frame = (r: ReturnType<typeof render>) => stripAnsi(r.lastFrame() ?? "");

describe("R11 Static 项可原地重渲", () => {
  test("R11: 已渲染项的内容变化会反映到输出（执行中 → 完成）", async () => {
    const r = render(<Layout items={[{ id: "t1", status: "executing" }]} tail="…" />);
    await tick();
    expect(frame(r)).toContain("t1:executing");

    r.rerender(<Layout items={[{ id: "t1", status: "done" }]} tail="…" />);
    await tick();
    expect(frame(r)).toContain("t1:done");
    expect(frame(r)).not.toContain("t1:executing");
    r.unmount();
  });

  test("R11: 新增项追加在已有项之后，已有项不重复输出", async () => {
    const a: Item = { id: "a", status: "done" };
    const r = render(<Layout items={[a]} tail="x" />);
    await tick();
    r.rerender(<Layout items={[a, { id: "b", status: "executing" }]} tail="x" />);
    await tick();
    const lines = frame(r).split("\n");
    expect(lines.filter((l) => l.includes("a:done"))).toHaveLength(1);
    expect(lines.findIndex((l) => l.includes("a:done"))).toBeLessThan(
      lines.findIndex((l) => l.includes("b:executing")),
    );
    r.unmount();
  });

  test("R11: 移除项后它从输出中消失（不是 print-once 的「已打印就忘」）", async () => {
    const r = render(
      <Layout
        items={[
          { id: "a", status: "done" },
          { id: "b", status: "done" },
        ]}
        tail="x"
      />,
    );
    await tick();
    r.rerender(<Layout items={[{ id: "b", status: "done" }]} tail="x" />);
    await tick();
    expect(frame(r)).not.toContain("a:done");
    expect(frame(r)).toContain("b:done");
    r.unmount();
  });
});

describe("R12 非 TTY 整帧输出", () => {
  test("R12: 每次提交后最新一帧包含全部可见内容（不是只含变化的行）", async () => {
    const items: Item[] = [{ id: "a", status: "done" }];
    const r = render(<Layout items={items} tail="one" />);
    await tick();
    r.rerender(<Layout items={items} tail="two" />);
    await tick();
    // 只有 tail 变了，但最新帧里仍然有未变的 a:done
    expect(frame(r)).toContain("a:done");
    expect(frame(r)).toContain("two");
    expect(r.frames.length).toBeGreaterThanOrEqual(2);
    r.unmount();
  });
});
