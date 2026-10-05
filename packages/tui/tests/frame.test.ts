/**
 * 帧间增量对拍旧底座（B9 / T3.2，契约 R1 / R3–R6 / R12）。
 *
 * 向量由 `bun run tui:frame-vectors` 从旧底座 TTY 路径逐帧生成并入库；这里用新底座跑同一串帧，
 * 每帧写出的字节与 full reset 原因必须一致。只读向量与语料，不 import 旧底座。
 */
import { describe, expect, test } from "bun:test";
import React from "react";
import vectors from "./fixtures/frame-vectors.json";
import { FRAME_CORPUS } from "./fixtures/frame-corpus.ts";
import { driveFrames } from "./fixtures/frame-drive.tsx";
import { Box, render, Text } from "../src/index.ts";
import { Screen } from "../src/screen/index.ts";
import { diffMainScreen } from "../src/frame/main-screen.ts";

const engine = {
  React,
  Box: Box as never,
  Text: Text as never,
  renderSync: render as never,
};

describe("帧 diff 对拍旧底座（frame-vectors.json）", () => {
  test("语料与向量一一对应", () => {
    expect(Object.keys(vectors)).toEqual(FRAME_CORPUS.map((c) => c.name));
  });

  for (const c of FRAME_CORPUS) {
    test(c.name, async () => {
      const actual = await driveFrames(engine, c);
      const expected = (vectors as Record<string, unknown>)[c.name];
      expect(JSON.stringify(actual)).toBe(JSON.stringify(expected));
    });
  }
});

describe("diffMainScreen 单元规则", () => {
  const screen = (lines: string[], width = 10) => {
    const s = new Screen(width, lines.length);
    lines.forEach((l, y) => s.writeLine(0, y, l));
    return s;
  };

  test("R3：同一帧再 diff 一字节不写", () => {
    const a = screen(["ab", "cd"]);
    expect(diffMainScreen(a, screen(["ab", "cd"]), 24).bytes).toBe("");
  });

  test("R4：纯增长只追加新行，不 full reset", () => {
    const d = diffMainScreen(screen(["a"]), screen(["a", "b"]), 24);
    expect(d).toEqual({ bytes: "b\r\n" });
  });

  test("R5：变化落在 scrollback 里 → full reset（offscreen）", () => {
    const rows = (f: (i: number) => string) => screen(Array.from({ length: 10 }, (_, i) => f(i)));
    const d = diffMainScreen(
      rows(String),
      rows((i) => (i === 0 ? "X" : String(i))),
      6,
    );
    expect(d.bytes.startsWith("\x1b[2J\x1b[3J\x1b[H")).toBe(true);
    expect(d.flicker?.reason).toBe("offscreen");
  });

  test("R6：从溢出收缩回视口内 → full reset 恰好一次", () => {
    const rows = (n: number) => screen(Array.from({ length: n }, (_, i) => String(i)));
    const d = diffMainScreen(rows(10), rows(4), 6);
    expect(d.bytes.match(/\x1b\[2J/g)?.length).toBe(1);
  });

  test("宽度变化 → full reset", () => {
    const d = diffMainScreen(screen(["a"], 10), screen(["a"], 12), 24);
    expect(d.bytes.startsWith("\x1b[2J")).toBe(true);
  });
});
