/**
 * 会话回退面板（A1）的 Esc 语义：每一阶段按一次 Esc 就要有看得见的反应。
 *
 * 回归来源（2026-11-08，写 G4 用例 `A1-dialog` 时在真 TUI 里发现）：
 * 回退完成后的结果页写着「Esc 关闭」，按一次 Esc 却没反应，要按两次才关。
 * 根因是 Esc 处理先看 `selectedPoint`（阶段 2 → 退回阶段 1），而结果页渲染先看 `result`：
 * 第一次 Esc 只清掉了 `selectedPoint`，画面仍是结果页；第二次才走到 `onClose`。
 *
 * 渲染 harness 沿用 CommandOutputDialog.test.tsx：自建 stdin emit 字符串，走生产同形态的按键解析。
 */

import { describe, expect, test } from "bun:test";
import React from "react";
import { PassThrough } from "node:stream";
import { renderSync } from "@sid-code/cli/ui/render-port/testing.ts";
import { KeypressProvider, ESC_TIMEOUT } from "@sid-code/cli/ui/contexts/KeypressContext.tsx";
import { TerminalProvider } from "@sid-code/cli/ui/contexts/TerminalContext.tsx";
import { RewindDialog } from "@sid-code/cli/ui/components/RewindDialog.tsx";
import type { RewindPointInfo, RewindResultInfo } from "@sid-code/cli/ui/App.tsx";

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

const POINT: RewindPointInfo = {
  id: 1,
  inputPreview: "把 hello.txt 的 hello world 改成 hello sid-code",
  timestamp: Date.now(),
  hasSnapshot: true,
};

const OK_RESULT: RewindResultInfo = {
  mode: "code",
  messagesDropped: 0,
  filesRestored: 1,
  filesFailed: 0,
  fileRestoreSkipped: false,
};

function mount() {
  let output = "";
  const stdout = new PassThrough() as unknown as NodeJS.WriteStream & {
    columns: number;
    rows: number;
  };
  stdout.columns = 100;
  stdout.rows = 30;
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
        <RewindDialog
          onClose={() => (closed += 1)}
          getRewindPoints={() => [POINT]}
          onRewind={async () => OK_RESULT}
        />
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

const ENTER = "\r";
const ESC = "\x1b";

describe("RewindDialog：Esc 每按一次都要有反应", () => {
  test("结果页按一次 Esc 就关闭面板", async () => {
    const ui = mount();
    try {
      await ui.press(ENTER); // 选回退点
      expect(ui.frame()).toContain("回退范围");
      await ui.press(ENTER); // 选「仅代码」
      expect(ui.frame()).toContain("已回退（仅代码）");
      await ui.press(ESC);
      expect(ui.closed()).toBe(1);
    } finally {
      ui.unmount();
    }
  });

  test("模式选择页按 Esc 退回选点页，不关闭", async () => {
    const ui = mount();
    try {
      await ui.press(ENTER);
      expect(ui.frame()).toContain("回退范围");
      await ui.press(ESC);
      expect(ui.closed()).toBe(0);
      expect(ui.frame()).toContain("选择回退到哪一轮之前");
      await ui.press(ESC);
      expect(ui.closed()).toBe(1);
    } finally {
      ui.unmount();
    }
  });
});
