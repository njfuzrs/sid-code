/**
 * `<Transient float>`（长会话按键延迟 PR4）：补全菜单在帧已溢出视口时叠画在上方的历史行上，不占帧高。
 *
 * 2026-10-30 实测：长会话（ce7，6,970 行）里按 `/` 打开补全再退格关掉，关闭那一帧走 offscreen full reset，
 * 写出 763,813 字节并 `ESC[3J` 清掉 scrollback 重建。这里锁：
 * 1. 溢出时开关菜单：不 full reset、写出字节与帧高无关、关闭后画面与 scrollback 回到打开前；
 * 2. 菜单打开时盖住输入框上方那几行（短于历史行的菜单行不露出历史字符）；
 * 3. 短会话（帧未溢出）：float 与不 float 每帧写出的字节逐字节相同；
 * 4. 菜单打开期间历史增长（流式输出）、关闭后不留空白块。
 *
 * 变异自证：layoutFloatingTransients 里 `n >= rows` 条件去掉 → 用例 3 红；整个函数提前 return → 用例 1 红。
 */
import { describe, expect, test } from "bun:test";
import { PassThrough } from "node:stream";
import { Terminal } from "@xterm/headless";
import React from "react";
import { Box, History, render, Text, Transient } from "../src/index.ts";

const W = 30;
const H = 12;
const base = ["────", "> ", "────", "status"];
const menu = ["/help  帮助", "/model 换模型", "/clear 清屏"];

type Frame = { menu?: string[]; hist: number; dyn?: string[] };

async function drive(frames: Frame[], float: boolean) {
  const term = new Terminal({ cols: W, rows: H, allowProposedApi: true });
  let pending = Promise.resolve();
  const writes: string[] = [];
  const stdout = Object.assign(new PassThrough(), { columns: W, rows: H, isTTY: true });
  stdout.on("data", (d: Buffer) => {
    const s = d.toString();
    writes.push(s);
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
        items: Array.from({ length: f.hist }, (_, i) => `hist${i}`),
        children: (item: unknown) => h(Text, { key: String(item) }, String(item)),
      }),
      h(
        Box,
        { flexDirection: "column" },
        f.menu ? h(Transient, { float }, ...lines(f.menu, "m")) : null,
        ...lines(f.dyn ?? base, "d"),
      ),
    );
  const flickers: unknown[] = [];
  const tick = () => new Promise((r) => setTimeout(r, 20));
  const frameWrites: string[] = [];
  const inst = render(tree(frames[0]!), {
    stdout: stdout as never,
    stdin: stdin as never,
    patchConsole: false,
    exitOnCtrlC: false,
    onFrame: (e: { flickers: unknown[] }) => flickers.push(...e.flickers),
  } as never);
  await tick();
  frameWrites.push(writes.splice(0).join(""));
  for (const f of frames.slice(1)) {
    inst.rerender(tree(f));
    await tick();
    frameWrites.push(writes.splice(0).join(""));
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
  const scrollback: string[] = [];
  for (let y = 0; y < b.viewportY; y++)
    scrollback.push(b.getLine(y)!.translateToString(true).trimEnd());
  stdout.isTTY = false;
  inst.unmount();
  return { view, scrollback, flickers, frameWrites };
}

describe("Transient float：溢出时叠画，关闭不整帧重画", () => {
  test("长会话开关菜单：不 full reset，画面与 scrollback 回到打开前", async () => {
    const before = await drive([{ hist: 40 }], true);
    const r = await drive([{ hist: 40 }, { hist: 40, menu }, { hist: 40 }], true);
    expect(r.flickers).toHaveLength(0);
    expect(r.view).toEqual(before.view);
    expect(r.scrollback).toEqual(before.scrollback);
    expect(r.frameWrites[2]).not.toContain("\x1b[2J");
  });

  test("开关菜单写出的字节与历史长度无关（只写视口内被盖住 / 复原的几行）", async () => {
    const long = await drive([{ hist: 2000 }, { hist: 2000, menu }, { hist: 2000 }], true);
    // 2000 行历史整帧重画约 2 万字节；这里只允许视口内几行的量级。
    // 不比两种历史长度的字节相等：被复原的行文本本身不同（hist37 vs hist1997），差几个字节是正常的
    expect(long.frameWrites[1]!.length).toBeLessThan(500);
    expect(long.frameWrites[2]!.length).toBeLessThan(500);
    expect(long.flickers).toHaveLength(0);
  });

  test("菜单打开时盖住输入框正上方的历史行，不顶走历史、帧高不变", async () => {
    const r = await drive([{ hist: 40 }, { hist: 40, menu }], true);
    // 视口 12 行 = 帧末 11 行 + 光标行：hist33..36、菜单三行（盖住 hist37..39）、输入框四行
    expect(r.view.slice(0, 7)).toEqual(["hist33", "hist34", "hist35", "hist36", ...menu]);
    expect(r.view.slice(7, 11)).toEqual(base.map((l) => l.trimEnd()));
    // 菜单行比历史行短也不能露出底下的字（`/help  帮助` 后面不能跟着 hist 的尾巴）
    for (const line of r.view.slice(4, 7)) expect(line).not.toContain("hist");
  });

  test("短会话（帧未溢出）：float 与在流布局每帧字节逐字节相同", async () => {
    // hist=6：菜单上方放得下（锚点之上 6 行 ≥ 菜单 3 行），只有「帧未溢出」这一条挡着叠画——
    // hist=2 时「上方放不下」也会挡住，单靠它测不出溢出条件被删
    for (const hist of [2, 6]) {
      const frames: Frame[] = [{ hist }, { hist, menu }, { hist }];
      const a = await drive(frames, true);
      const b = await drive(frames, false);
      expect(a.frameWrites).toEqual(b.frameWrites);
    }
  });

  test("打开期间历史增长，关闭后不留空白块", async () => {
    const after = await drive([{ hist: 45 }], true);
    const r = await drive(
      [{ hist: 40 }, { hist: 40, menu }, { hist: 45, menu }, { hist: 45 }],
      true,
    );
    expect(r.view).toEqual(after.view);
    expect(r.view.filter((l) => l === "").length).toBe(after.view.filter((l) => l === "").length);
  });

  // 真实 TUI 里关菜单的同一帧输入区还会少一行提示（帧变矮）。叠画态的浮层若仍算作「在流浮层」，
  // diffFrame 会把这次收缩判成「关浮层」走整帧重画——ce7 实测 763,855 字节，单测里帧高不变时测不出来
  test("关菜单同一帧输入区变矮：仍不整帧重画", async () => {
    const hint = ["(提示行)", ...base];
    const r = await drive([{ hist: 40 }, { hist: 40, menu, dyn: hint }, { hist: 40 }], true);
    expect(r.flickers).toHaveLength(0);
    expect(r.frameWrites[2]).not.toContain("\x1b[2J");
  });

  test("菜单比视口还高：不叠画（退回在流布局，关闭时照旧整帧重画）", async () => {
    const tall = Array.from({ length: 10 }, (_, i) => `item${i}`);
    const r = await drive([{ hist: 40 }, { hist: 40, menu: tall }, { hist: 40 }], true);
    expect(r.flickers).toHaveLength(1);
  });
});
