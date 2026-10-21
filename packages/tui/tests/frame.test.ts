/**
 * 帧间增量对拍冻结的行为基线（B9 / T3.2–T3.3，契约 R1 / R3–R8 / R10 / R12）。
 *
 * 向量由 `bun run tui:frame-vectors` 按冻结行为基线的 TTY 路径逐帧生成并入库；这里用渲染底座跑同一串帧，
 * 每帧写出的字节与 full reset 原因必须一致。只读向量与语料，不 import 生成器。
 */
import { describe, expect, test } from "bun:test";
import React from "react";
import vectors from "./fixtures/frame-vectors.json";
import { FRAME_CORPUS } from "./fixtures/frame-corpus.ts";
import { driveFrames } from "./fixtures/frame-drive.tsx";
import { Box, render, Text } from "../src/index.ts";
import { Screen } from "../src/screen/index.ts";
import instances from "../src/instances.ts";
import { diffMainScreen } from "../src/frame/main-screen.ts";

const engine = {
  React,
  Box: Box as never,
  Text: Text as never,
  renderSync: render as never,
  instanceOf: (stdout: NodeJS.WriteStream) => instances.get(stdout),
};

describe("帧 diff 对拍冻结的行为基线（frame-vectors.json）", () => {
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

// 溢出后收缩补空行（sid-code 有意偏离冻结基线）：主屏帧高常年超视口，动态区（spinner / 流式正文）一收缩，
// 旧行为擦掉底部 → 整帧上移，footer 下面留 p - n 行空白，输入框 / 状态栏被顶到屏幕中间。
// 断言落在终端画面上（xterm 重放字节），不落在字节上：字节对不对只有画面说了算。
describe("溢出后收缩：footer 钉在视口底部", () => {
  const W = 20;
  const H = 10;
  const mk = (lines: string[]) => {
    const s = new Screen(W, lines.length);
    lines.forEach((l, y) => s.writeLine(0, y, l));
    return s;
  };
  const frame = (hist: number, dyn: number) =>
    mk([
      ...Array.from({ length: hist }, (_, i) => `hist${i}`),
      ...Array.from({ length: dyn }, (_, i) => `spin${i}`),
      "[input]",
      "[FOOTER]",
    ]);

  async function replay(frames: Screen[]) {
    const { Terminal } = await import("@xterm/headless");
    const term = new Terminal({ cols: W, rows: H, allowProposedApi: true });
    const write = (s: string) => new Promise<void>((r) => term.write(s, r));
    let prev: Screen | undefined;
    for (const f of frames) {
      const d = diffMainScreen(prev, f, H);
      await write(d.bytes);
      prev = d.screen ?? f;
    }
    const b = term.buffer.active;
    const view: string[] = [];
    for (let y = 0; y < H; y++)
      view.push(
        b
          .getLine(b.viewportY + y)!
          .translateToString(true)
          .trimEnd(),
      );
    return view;
  }

  test("动态区清空后 footer 仍在最后一行内容行，下面没有空白", async () => {
    const view = await replay([frame(20, 4), frame(20, 0)]);
    // 光标停在内容下一行（第 H-1 行），所以 footer 在第 H-2 行、输入框在 H-3 行
    expect(view[H - 2]).toBe("[FOOTER]");
    expect(view[H - 3]).toBe("[input]");
    // 空行补在消失的动态区位置（footer 上方），历史尾部仍可见
    expect(view.slice(0, 3)).toEqual(["hist17", "hist18", "hist19"]);
  });

  test("补空行后再增长、再收缩，footer 始终不离开底部，内容不错位", async () => {
    const view = await replay([
      frame(20, 4),
      frame(20, 0),
      frame(20, 2),
      frame(20, 6),
      frame(21, 0),
    ]);
    expect(view[H - 2]).toBe("[FOOTER]");
    expect(view[H - 3]).toBe("[input]");
    expect(view.slice(0, 2)).toEqual(["hist19", "hist20"]);
  });

  test("补过的帧经 screen 返回，高度撑回 p；没溢出的收缩不补", () => {
    const d = diffMainScreen(frame(20, 4), frame(20, 0), H);
    expect(d.screen?.height).toBe(26);
    expect(d.flicker).toBeUndefined();
    const small = diffMainScreen(frame(2, 4), frame(2, 0), H);
    expect(small.screen).toBeUndefined();
  });
});

// 2026-10-22 复现：#390 的插入点按「两帧公共尾部」猜，在真实 TUI 里两头切错组件——
// 状态栏计费同帧变了 → 空行插进状态栏两行之间；输入框变矮 → 空行插进输入框里面。
// 走真实 render + History，空行必须落在历史区下沿，动态区整块贴底、内部零空行。
describe("溢出后收缩：空行补在历史区下沿，不切进动态区组件", () => {
  const W = 30;
  const H = 12;
  const hist = Array.from({ length: 20 }, (_, i) => `hist${i}`);

  async function drive(frames: string[][]) {
    const { PassThrough } = await import("node:stream");
    const { Terminal } = await import("@xterm/headless");
    const { History } = await import("../src/index.ts");
    const term = new Terminal({ cols: W, rows: H, allowProposedApi: true });
    let pending = Promise.resolve();
    const stdout = Object.assign(new PassThrough(), { columns: W, rows: H, isTTY: true });
    stdout.on("data", (d: Buffer) => {
      const s = d.toString();
      pending = pending.then(() => new Promise<void>((r) => term.write(s, r)));
    });
    const stdin = Object.assign(new PassThrough(), {
      isTTY: true,
      isRaw: false,
      setRawMode: () => stdin,
      ref: () => stdin,
      unref: () => stdin,
    });
    const h = React.createElement;
    const renderItem = (item: string) => h(Text, { key: item }, item);
    const tree = (dyn: string[]) =>
      h(
        Box,
        { flexDirection: "column" },
        h(History, { items: hist, children: renderItem }),
        h(Box, { flexDirection: "column" }, ...dyn.map((l, i) => h(Text, { key: i }, l))),
      );
    const tick = () => new Promise((r) => setTimeout(r, 20));
    const inst = render(tree(frames[0]!), {
      stdout: stdout as never,
      stdin: stdin as never,
      patchConsole: false,
      exitOnCtrlC: false,
    });
    await tick();
    for (const f of frames.slice(1)) {
      inst.rerender(tree(f));
      await tick();
    }
    await pending;
    const b = term.buffer.active;
    const view: string[] = [];
    for (let y = 0; y < H; y++)
      view.push(
        b
          .getLine(b.viewportY + y)!
          .translateToString(true)
          .trimEnd(),
      );
    stdout.isTTY = false;
    inst.unmount();
    return view;
  }

  // 视口最后一行是光标行（内容下一行），动态区占 H-1 之上的若干行
  const bottom = (view: string[], k: number) => view.slice(H - 1 - k, H - 1);

  test("spinner 消失且状态栏同帧变化：状态栏两行之间不插空行", async () => {
    const view = await drive([
      ["* spin", "", "────", "> ", "────", "status $1", "sid main"],
      ["────", "> ", "────", "status $2", "sid main"],
    ]);
    expect(bottom(view, 5)).toEqual(["────", ">", "────", "status $2", "sid main"]);
    // 空 Text 高 0：两帧 26 → 25 行，补的 1 行空行落在历史尾与动态区之间
    expect(view.slice(0, 6)).toEqual(["hist15", "hist16", "hist17", "hist18", "hist19", ""]);
  });

  test("输入框变矮：输入框内部不插空行", async () => {
    const view = await drive([
      ["────", "> abc", "  def", "  ghi", "────", "status", "sid main"],
      ["────", "> abc", "────", "status", "sid main"],
    ]);
    expect(bottom(view, 5)).toEqual(["────", "> abc", "────", "status", "sid main"]);
  });

  test("历史区下沿已滚出视口（长流式正文）：不 full reset，空行不插进正文", async () => {
    const W2 = 20;
    const H2 = 8;
    const mk = (lines: string[]) => {
      const s = new Screen(W2, lines.length);
      lines.forEach((l, y) => s.writeLine(0, y, l));
      return s;
    };
    const head = Array.from({ length: 10 }, (_, i) => `hist${i}`);
    const msg = Array.from({ length: 12 }, (_, i) => `msg${i}`);
    const { Terminal } = await import("@xterm/headless");
    const term = new Terminal({ cols: W2, rows: H2, allowProposedApi: true });
    let prev: Screen | undefined;
    for (const f of [
      mk([...head, ...msg, "* spin", "> ", "status"]),
      mk([...head, ...msg, "> ", "status"]),
    ]) {
      const d = diffMainScreen(prev, f, H2, head.length);
      expect(d.flicker).toBeUndefined();
      await new Promise<void>((r) => term.write(d.bytes, r));
      prev = d.screen ?? f;
    }
    const b = term.buffer.active;
    const view = Array.from({ length: H2 }, (_, y) =>
      b
        .getLine(b.viewportY + y)!
        .translateToString(true)
        .trimEnd(),
    );
    expect(view).toEqual(["msg8", "msg9", "msg10", "msg11", "", ">", "status", ""]);
  });
});
