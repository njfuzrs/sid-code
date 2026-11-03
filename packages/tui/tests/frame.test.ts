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

// 溢出后收缩一律整帧重画（sid-code 有意偏离冻结基线，2026-11-03）。
// 断言落在终端画面上（xterm 重放字节），不落在字节上：字节对不对只有画面说了算。
//
// 历史：#390 / #402 / #408 用「补空行撑高度」避免重画，结果空白只是换了位置——留在历史尾与动态区之间，
// 之后的流式正文贴着输入框从下往上长。下面「最后一条消息」那组用例就是 2026-11-03 的用户现象。

const W = 30;
const H = 12;

/** 视口逐行文本 + scrollback 逐行文本 */
function dump(term: import("@xterm/headless").Terminal) {
  const b = term.buffer.active;
  const line = (y: number) => b.getLine(y)!.translateToString(true).trimEnd();
  return {
    view: Array.from({ length: H }, (_, y) => line(b.viewportY + y)),
    scrollback: Array.from({ length: b.viewportY }, (_, y) => line(y)),
  };
}

type Frame = { items: string[]; dyn: string[]; overlay?: string[] };

/** 真实 render + History：历史区 + 动态区（可选 Transient 浮层），每帧后取画面 */
async function drive(frames: Frame[]) {
  const { PassThrough } = await import("node:stream");
  const { Terminal } = await import("@xterm/headless");
  const { History, Transient } = await import("../src/index.ts");
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
  const lines = (ls: string[], p: string) => ls.map((l, i) => h(Text, { key: p + i }, l));
  const tree = (f: Frame) =>
    h(
      Box,
      { flexDirection: "column" },
      h(History, {
        items: f.items,
        children: (item: string) => h(Text, { key: item }, item),
      }),
      h(
        Box,
        { flexDirection: "column" },
        f.overlay ? h(Transient, null, ...lines(f.overlay, "o")) : null,
        ...lines(f.dyn, "d"),
      ),
    );
  const flickers: unknown[] = [];
  const steps: Array<ReturnType<typeof dump>> = [];
  const tick = () => new Promise((r) => setTimeout(r, 20));
  const inst = render(tree(frames[0]!), {
    stdout: stdout as never,
    stdin: stdin as never,
    patchConsole: false,
    exitOnCtrlC: false,
    onFrame: (e: { flickers: unknown[] }) => flickers.push(...e.flickers),
  } as never);
  await tick();
  await pending;
  steps.push(dump(term));
  for (const f of frames.slice(1)) {
    inst.rerender(tree(f));
    await tick();
    await pending;
    steps.push(dump(term));
  }
  stdout.isTTY = false;
  inst.unmount();
  return { steps, flickers };
}

/** 终端里应有的全部行：帧内容 + 光标所在的空行（光标停在内容下一行） */
const expectedLines = (f: Frame) => [...f.items, ...(f.overlay ?? []), ...f.dyn, ""];

/** 画面 = 目标帧的尾部 H 行，scrollback = 其余（不重复、不缺行、不夹空白） */
function expectExact(step: ReturnType<typeof dump>, f: Frame) {
  const all = expectedLines(f).map((l) => l.trimEnd());
  expect(step.view).toEqual(all.slice(-H));
  expect(step.scrollback).toEqual(all.slice(0, -H));
}

const hist = Array.from({ length: 20 }, (_, i) => `hist${i}`);
const footer = ["────", "> ", "────", "status"];

describe("溢出后收缩：整帧重画，画面与目标帧逐行一致", () => {
  test("最后一条消息：todo 收起 → 流式逐行增长 → 并入历史，全程无空白、从上往下长", async () => {
    const todo = ["› 任务清单 6/6", "● a", "● b", "● c", "● d", "● e"];
    const msg = ["⏺ msg0", "msg1", "msg2", "msg3", "msg4"];
    const frames: Frame[] = [
      { items: hist, dyn: [...todo, "* spin", ...footer] },
      { items: hist, dyn: ["* spin", ...footer] },
      { items: hist, dyn: [...msg.slice(0, 1), ...footer] },
      { items: hist, dyn: [...msg.slice(0, 3), ...footer] },
      { items: hist, dyn: [...msg, ...footer] },
      { items: [...hist, ...msg], dyn: footer },
    ];
    const { steps, flickers } = await drive(frames);
    steps.forEach((s, i) => expectExact(s, frames[i]!));
    // 流式第一行紧跟在历史尾之后（修复前中间隔着 todo 收起留下的 6 行空白，正文从输入框上方往上长）
    expect(steps[2]!.view.slice(-7, -5)).toEqual(["hist19", "⏺ msg0"]);
    // 只有 todo 收起那一帧在收缩（spinner→正文同高、并入历史帧高不变）
    expect(flickers).toHaveLength(1);
  });

  test("spinner 消失且状态栏同帧变化：画面逐行一致", async () => {
    const frames: Frame[] = [
      { items: hist, dyn: ["* spin", " ", "────", "> ", "────", "status $1", "sid main"] },
      { items: hist, dyn: ["────", "> ", "────", "status $2", "sid main"] },
    ];
    const { steps } = await drive(frames);
    steps.forEach((s, i) => expectExact(s, frames[i]!));
  });

  test("输入框变矮：画面逐行一致", async () => {
    const frames: Frame[] = [
      { items: hist, dyn: ["────", "> abc", "  def", "  ghi", "────", "status", "sid main"] },
      { items: hist, dyn: ["────", "> abc", "────", "status", "sid main"] },
    ];
    const { steps } = await drive(frames);
    steps.forEach((s, i) => expectExact(s, frames[i]!));
  });

  test("动态区比视口还高（长流式正文）时收缩：画面逐行一致，不把空行插进正文", async () => {
    const msg = Array.from({ length: 14 }, (_, i) => `msg${i}`);
    const frames: Frame[] = [
      { items: hist.slice(0, 10), dyn: [...msg, "* spin", ...footer] },
      { items: hist.slice(0, 10), dyn: [...msg, ...footer] },
    ];
    const { steps } = await drive(frames);
    steps.forEach((s, i) => expectExact(s, frames[i]!));
  });

  test("没溢出视口的收缩照旧擦底部，不重画", async () => {
    const frames: Frame[] = [
      { items: hist.slice(0, 2), dyn: ["* spin", "x", ...footer] },
      { items: hist.slice(0, 2), dyn: footer },
    ];
    const { steps, flickers } = await drive(frames);
    expect(flickers).toHaveLength(0);
    expect(steps[1]!.view.slice(0, 6)).toEqual([
      "hist0",
      "hist1",
      ...footer.map((l) => l.trimEnd()),
    ]);
  });

  test("diffMainScreen：p ≥ H 且变矮 → full reset（offscreen）；没溢出的收缩不 reset", () => {
    const mk = (n: number) => {
      const s = new Screen(W, n);
      for (let y = 0; y < n; y++) s.writeLine(0, y, `r${y}`);
      return s;
    };
    const d = diffMainScreen(mk(H + 5), mk(H + 4), H);
    expect(d.flicker?.reason).toBe("offscreen");
    expect(d.bytes.startsWith("\x1b[2J\x1b[3J\x1b[H")).toBe(true);
    expect(diffMainScreen(mk(H - 2), mk(H - 4), H).flicker).toBeUndefined();
  });
});

// 2026-10-22 复现：长对话里打开 /model 再 Esc 关掉，打开时被顶进 scrollback 的历史拉不回来。
// 当时靠 Transient 标记单独判「关浮层 → 重画」；现在任何溢出后收缩都重画，浮层关闭是其中一种，这里锁住不回退。
describe("关闭临时浮层：画面回到打开前，scrollback 里历史不重复", () => {
  const dialog = ["┌ model ┐", "a", "b", "c", "d", "e", "└───────┘"];

  test("打开对话框再关掉", async () => {
    const frames: Frame[] = [
      { items: hist, dyn: footer },
      { items: hist, overlay: dialog, dyn: footer },
      { items: hist, dyn: footer },
    ];
    const { steps, flickers } = await drive(frames);
    steps.forEach((s, i) => expectExact(s, frames[i]!));
    expect(flickers).toHaveLength(1);
  });

  test("对话框里内容变化不重画，变矮与关闭各重画一次", async () => {
    const moved = dialog.map((l) => (l === "a" ? "> a" : l));
    const frames: Frame[] = [
      { items: hist, dyn: footer },
      { items: hist, overlay: dialog, dyn: footer },
      { items: hist, overlay: moved, dyn: footer },
      { items: hist, overlay: dialog.slice(0, 4), dyn: footer },
      { items: hist, dyn: footer },
    ];
    const { steps, flickers } = await drive(frames);
    steps.forEach((s, i) => expectExact(s, frames[i]!));
    expect(flickers).toHaveLength(2);
  });
});
