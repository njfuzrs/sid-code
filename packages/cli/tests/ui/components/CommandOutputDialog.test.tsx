/**
 * 命令输出面板的键盘交互：Esc / q 关闭，↑↓ / PgDn / End 滚动，长输出不顶出屏幕。
 *
 * 渲染 harness 沿用 HotkeyChoiceList.test.tsx 的做法：自建 stdin 并 emit **字符串**，
 * 让 KeypressProvider 走生产同形态的转义序列解析（vendor shim 发 Buffer，解析不了）。
 */

import { test, expect, describe } from "bun:test";
import React from "react";
import { PassThrough } from "node:stream";
import { renderSync } from "@sid-code/cli/ui/render-port/testing.ts";
import { KeypressProvider, ESC_TIMEOUT } from "@sid-code/cli/ui/contexts/KeypressContext.tsx";
import { TerminalProvider } from "@sid-code/cli/ui/contexts/TerminalContext.tsx";
import {
  CommandOutputDialog,
  type CommandPanelInfo,
} from "@sid-code/cli/ui/components/CommandOutputDialog.tsx";

const SYNC_START = "\x1b[?2026h";
const SYNC_END = "\x1b[?2026l";

function stripAnsi(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, "");
}

function extractLastFrame(output: string): string {
  const lastStart = output.lastIndexOf(SYNC_START);
  if (lastStart === -1) return output;
  const contentStart = lastStart + SYNC_START.length;
  const endIndex = output.indexOf(SYNC_END, contentStart);
  return endIndex === -1 ? output.slice(contentStart) : output.slice(contentStart, endIndex);
}

function mount(panel: CommandPanelInfo, rows = 24) {
  let output = "";
  const stdout = new PassThrough() as unknown as NodeJS.WriteStream & {
    columns: number;
    rows: number;
  };
  stdout.columns = 80;
  stdout.rows = rows;
  (stdout as unknown as { isTTY: boolean }).isTTY = false;
  stdout.on("data", (chunk: Buffer) => {
    output += chunk.toString();
  });

  const stdin = new PassThrough() as unknown as NodeJS.ReadStream;
  const stdinAny = stdin as unknown as Record<string, unknown>;
  stdinAny.isTTY = true;
  stdinAny.setRawMode = () => stdin;
  stdinAny.setEncoding = () => stdin;
  stdinAny.ref = () => stdin;
  stdinAny.unref = () => stdin;

  let closed = 0;
  const instance = renderSync(
    <TerminalProvider>
      <KeypressProvider>
        <CommandOutputDialog panel={panel} onClose={() => (closed += 1)} />
      </KeypressProvider>
    </TerminalProvider>,
    { stdout, stdin, patchConsole: false, exitOnCtrlC: false },
  );

  return {
    frame: () => stripAnsi(extractLastFrame(output)),
    closed: () => closed,
    press: async (seq: string) => {
      stdin.emit("data", seq);
      await new Promise((r) => setTimeout(r, ESC_TIMEOUT * 2));
    },
    unmount: () => instance.unmount(),
  };
}

const KEY = { up: "\x1b[A", down: "\x1b[B", pageDown: "\x1b[6~", end: "\x1b[F", escape: "\x1b" };
const LONG: CommandPanelInfo = {
  title: "/doctor",
  content: Array.from({ length: 60 }, (_, i) => `行${i + 1}`).join("\n"),
};

describe("CommandOutputDialog", () => {
  test("渲染标题与内容；短内容无滚动提示", () => {
    const m = mount({ title: "/status", content: "模型: x\n目录: y\n上下文: 3%" });
    const f = m.frame();
    expect(f).toContain("/status");
    expect(f).toContain("上下文: 3%");
    expect(f).toContain("Esc 关闭");
    expect(f).not.toContain("↑↓ 滚动");
    m.unmount();
  });

  test("长内容按终端高度截断，不把面板顶出屏幕", () => {
    const m = mount(LONG, 24);
    const f = m.frame();
    expect(f).toContain("行1");
    expect(f).not.toContain("行60");
    expect(f).toMatch(/1–\d+ \/ 60 行/);
    expect(f.split("\n").length).toBeLessThanOrEqual(24);
    m.unmount();
  });

  test("↓ 滚一行、↑ 滚回；顶部再按 ↑ 不越界", async () => {
    const m = mount(LONG);
    await m.press(KEY.down);
    expect(m.frame()).toMatch(/2–\d+ \/ 60 行/);
    await m.press(KEY.up);
    await m.press(KEY.up);
    expect(m.frame()).toMatch(/1–\d+ \/ 60 行/);
    m.unmount();
  });

  test("End 跳到底、PgDn 不越过底部", async () => {
    const m = mount(LONG);
    await m.press(KEY.end);
    expect(m.frame()).toContain("行60");
    expect(m.frame()).toMatch(/–60 \/ 60 行/);
    await m.press(KEY.pageDown);
    expect(m.frame()).toMatch(/–60 \/ 60 行/);
    m.unmount();
  });

  test("Esc 关闭", async () => {
    const m = mount(LONG);
    await m.press(KEY.escape);
    expect(m.closed()).toBe(1);
    m.unmount();
  });

  test("q 关闭（分页器习惯）", async () => {
    const m = mount(LONG);
    await m.press("q");
    expect(m.closed()).toBe(1);
    m.unmount();
  });

  test("错误输出：标题换错误字形", () => {
    const m = mount({ title: "/trace", content: "读取失败\n原因: x\n路径: y", isError: true });
    expect(m.frame()).toContain("✘ /trace");
    m.unmount();
  });

  test("不画左右竖线（命令输出要能干净地拖选复制，ui/CLAUDE.md L2.2）", () => {
    const m = mount({ title: "/status", content: "a\nb\nc" });
    expect(m.frame()).not.toMatch(/[│┃]/);
    m.unmount();
  });
});
