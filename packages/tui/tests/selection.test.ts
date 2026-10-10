/**
 * 选区引擎对拍旧底座（B9 / T6.2a，契约 M2）。
 *
 * 向量由 `bun run tui:selection-vectors` 在旧底座上跑同一份语料生成并入库；这里用新底座的布局
 * （`renderToScreen`）出屏幕缓冲、把同一串鼠标字节喂给选区引擎，复制文本与高亮单元必须一致。
 * 只读向量与语料，不 import 旧底座（D-5）。
 */
import { describe, expect, test } from "bun:test";
import vectors from "./fixtures/selection-vectors.json";
import { buildSelectionCases, ROWS } from "./fixtures/selection-corpus.tsx";
import { Box, Text } from "../src/index.ts";
import { renderToScreen } from "../src/render-to-string.ts";
import {
  applySelectionEvent,
  clearSelection,
  createSelectionState,
  decodeSelectionMouse,
  hasSelection,
  MULTI_CLICK_MS,
  selectionHighlight,
  selectionText,
} from "../src/selection.ts";
import type { Screen } from "../src/screen/index.ts";
import React from "react";

const expected = vectors as unknown as Record<
  string,
  { text: string; cells: string[]; blindRows?: number[] }
>;
const cases = buildSelectionCases({ Box, Text });

/** 与旧底座同一棵树：外面包一个 10 行高的根（alt-screen 视口） */
function screenOf(node: React.ReactNode, cols: number): Screen {
  return renderToScreen(React.createElement(Box, { flexDirection: "column", height: ROWS }, node), {
    columns: cols,
  });
}

/** 高亮段渲染成向量里的形态 `y:x0-x1:文字`（spacer 不出字，空格单元出空格） */
function cellsOf(screen: Screen, spans: { y: number; x0: number; x1: number }[]): string[] {
  return spans.map(({ y, x0, x1 }) => {
    let text = "";
    for (let x = x0; x <= x1; x++) text += screen.charAt(screen.index(x, y)) || "";
    return `${y}:${x0}-${x1}:${text}`;
  });
}

function drive(seq: (string | number)[], screen: Screen) {
  const state = createSelectionState();
  let time = 10_000;
  for (const step of seq) {
    if (typeof step === "number") {
      time += step;
      continue;
    }

    const event = decodeSelectionMouse(step, time);
    if (event) applySelectionEvent(state, screen, event);
  }

  return state;
}

describe("选区引擎对拍旧底座", () => {
  test("向量与语料同一批条目（语料改了要重生成向量）", () => {
    expect(Object.keys(expected).sort()).toEqual(cases.map((c) => c.name).sort());
  });

  for (const c of cases) {
    test(c.name, () => {
      const screen = screenOf(c.node, c.cols);
      const state = drive(c.seq, screen);
      const want = expected[c.name]!;
      expect(selectionText(state, screen)).toBe(want.text);
      // blindRows：生成器的 xterm 在这些行上量不准高亮位置（行里有 emoji，见 selection-drive.tsx），只比文本
      const blind = new Set(want.blindRows ?? []);
      const spans = selectionHighlight(state, screen).filter((span) => !blind.has(span.y));
      expect(cellsOf(screen, spans)).toEqual(want.cells);
    });
  }
});

describe("选区状态", () => {
  const L = ["hello world"];
  const node = React.createElement(Text, null, L[0]);

  test("clearSelection 清选区不清连击计数", () => {
    const screen = screenOf(node, 20);
    const state = drive(["\x1b[<0;1;1M", "\x1b[<32;5;1M", "\x1b[<0;5;1m"], screen);
    expect(hasSelection(state)).toBe(true);
    clearSelection(state);
    expect(hasSelection(state)).toBe(false);
    expect(selectionText(state, screen)).toBe("");
    expect(state.clickCount).toBe(1);
  });

  test("连击阈值是右开的 MULTI_CLICK_MS", () => {
    const screen = screenOf(node, 20);
    const click = ["\x1b[<0;2;1M", "\x1b[<0;2;1m"];
    expect(selectionText(drive([...click, MULTI_CLICK_MS - 1, ...click], screen), screen)).toBe(
      "hello",
    );
    expect(selectionText(drive([...click, MULTI_CLICK_MS, ...click], screen), screen)).toBe("");
  });

  test("非左键与非 SGR 编码不出选区事件", () => {
    for (const seq of [
      "\x1b[<1;1;1M",
      "\x1b[<2;1;1M",
      "\x1b[<35;1;1M",
      "\x1b[<64;1;1M",
      "\x1b[M !!",
      "x",
    ]) {
      expect(decodeSelectionMouse(seq, 0)).toBeUndefined();
    }

    expect(decodeSelectionMouse("\x1b[<4;3;2M", 0)).toEqual({
      action: "press",
      x: 2,
      y: 1,
      time: 0,
    });
    expect(decodeSelectionMouse("\x1b[<36;1;1M", 0)).toEqual({
      action: "drag",
      x: 0,
      y: 0,
      time: 0,
    });
    expect(decodeSelectionMouse("\x1b[<0;1;1m", 0)).toEqual({
      action: "release",
      x: 0,
      y: 0,
      time: 0,
    });
  });
});
