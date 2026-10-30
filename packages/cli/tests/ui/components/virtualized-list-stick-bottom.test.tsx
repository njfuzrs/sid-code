/**
 * 全屏模式「内容整个消失」回归（docs-research 20261020 全屏排查 §1 P0-1）。
 *
 * 根因：普通模式下 VirtualizedList 用 overflowY="scroll" 且内容盒 marginTop 恒 0，
 * 而渲染底座的 renderScrollContent 按「滚动位置为 0」剔除、不看内容盒偏移，
 * 视口于是永远停在 top spacer 上：条数多时粘底整屏空白，条数中等时停在开头不跟随。
 * Copy Mode 用 marginTop=-scrollTop + overflowY="hidden" 一直是对的，修复让普通模式走同一条路径。
 */

import { describe, test, expect } from "bun:test";
import React from "react";
import stripAnsi from "strip-ansi";
import { Box, Text } from "@sid-code/cli/ui/render-port/components.ts";
import { render } from "@sid-code/cli/ui/render-port/testing.ts";
import {
  VirtualizedList,
  SCROLL_TO_ITEM_END,
} from "@sid-code/cli/ui/components/VirtualizedList.tsx";

const ROWS = 12;

function App({ count, copyMode }: { count: number; copyMode?: boolean }) {
  const data = Array.from({ length: count }, (_, i) => i);
  return (
    <Box flexDirection="column" height={ROWS} width={30}>
      <Box flexDirection="column" flexGrow={1}>
        <VirtualizedList
          data={data}
          keyExtractor={(n) => `k${n}`}
          estimatedItemHeight={() => 1}
          initialScrollIndex={SCROLL_TO_ITEM_END}
          initialScrollOffsetInIndex={SCROLL_TO_ITEM_END}
          copyModeEnabled={copyMode}
          renderItem={({ item }) => <Text>item-{item}</Text>}
        />
      </Box>
      <Text>FOOTER</Text>
    </Box>
  );
}

async function frameLines(count: number, copyMode?: boolean): Promise<string[]> {
  const inst = render(<App count={count} copyMode={copyMode} />, { columns: 30, rows: ROWS });
  // ResizeObserver 测量回灌需要若干轮提交才稳定
  await new Promise((r) => setTimeout(r, 200));
  const lines = stripAnsi(inst.lastFrame() ?? "")
    .split("\n")
    .map((l) => l.trimEnd());
  inst.unmount();
  return lines;
}

const items = (lines: string[]) => lines.map((l) => l.trim()).filter((l) => /^item-\d+$/.test(l));

describe("VirtualizedList 粘底（普通模式 = Copy Mode 同一滚动表达）", () => {
  test("条数少于视口：从首条起画，不被负偏移推走", async () => {
    const lines = await frameLines(3);
    expect(items(lines)).toEqual(["item-0", "item-1", "item-2"]);
    expect(lines.some((l) => l.includes("FOOTER"))).toBe(true);
  });

  test("40 条：粘底显示末尾，不停在开头", async () => {
    const shown = items(await frameLines(40));
    expect(shown.at(-1)).toBe("item-39");
    expect(shown).not.toContain("item-0");
    expect(shown.length).toBe(ROWS - 1);
  });

  test("200 条：内容区不得整块空白，必须含末条且不含首条", async () => {
    const shown = items(await frameLines(200));
    expect(shown.at(-1)).toBe("item-199");
    expect(shown).not.toContain("item-0");
    expect(shown.length).toBe(ROWS - 1);
  });

  test("普通模式与 Copy Mode 画出同一组条目", async () => {
    expect(items(await frameLines(200))).toEqual(items(await frameLines(200, true)));
  });
});
