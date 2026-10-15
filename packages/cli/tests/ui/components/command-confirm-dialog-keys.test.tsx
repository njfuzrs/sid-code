/**
 * 斜杠命令 confirm 结果（/login 重新登录、/logout 等）的确认框按键测试。
 *
 * 回归背景：app.ts 的 confirm 分支原先只把 message 当文本打到屏幕上，没有任何可操作的控件，
 * 用户既确认不了也取消不了，onConfirm 永远不被调用。现在复用 shellConfirmRequest 格子
 * （带 message）渲染确认框。这里钉住：说明文字可见、不出现 shell 命令文案、
 * 回车 = 确认（初始聚焦「确认」）、n = 取消、Esc = 取消。
 * harness 同 approval-dialogs-keys.test.tsx。
 */

import { test, expect, describe } from "bun:test";
import React from "react";
import { PassThrough } from "node:stream";
import { renderSync } from "@sid-code/cli/ui/render-port/testing.ts";
import { KeypressProvider, ESC_TIMEOUT } from "@sid-code/cli/ui/contexts/KeypressContext.tsx";
import { DialogRenderer } from "@sid-code/cli/ui/components/DialogManager.tsx";

const SYNC_START = "\x1b[?2026h";
const SYNC_END = "\x1b[?2026l";

function stripAnsi(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\x1b\[[0-9;]*m/g, "");
}

function extractLastFrame(output: string): string {
  const lastStart = output.lastIndexOf(SYNC_START);
  if (lastStart === -1) return output;
  const contentStart = lastStart + SYNC_START.length;
  const endIndex = output.indexOf(SYNC_END, contentStart);
  return endIndex === -1 ? output.slice(contentStart) : output.slice(contentStart, endIndex);
}

function renderWithKeys(node: React.ReactElement) {
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
  const instance = renderSync(<KeypressProvider>{node}</KeypressProvider>, {
    stdout,
    stdin,
    patchConsole: false,
    exitOnCtrlC: false,
  });
  return {
    lastFrame: () => stripAnsi(extractLastFrame(output)),
    press: async (seq: string) => {
      stdin.emit("data", seq);
      await new Promise((r) => setTimeout(r, ESC_TIMEOUT * 2));
    },
    unmount: () => instance.unmount(),
  };
}

const MESSAGE = "当前已登录：测试用户\n重新登录会让服务端吊销当前凭据。继续？";

function renderConfirm(decisions: boolean[]) {
  return renderWithKeys(
    <DialogRenderer
      permissionRequest={null}
      planApprovalRequest={null}
      shellConfirmRequest={{
        commands: [],
        message: MESSAGE,
        resolve: (ok) => decisions.push(ok),
      }}
    />,
  );
}

describe("命令 confirm 确认框（message 模式）", () => {
  test("展示说明与确认/取消，不出现 shell 命令文案；回车 = 确认", async () => {
    const decisions: boolean[] = [];
    const r = renderConfirm(decisions);
    await r.press("");
    const frame = r.lastFrame();
    expect(frame).toContain("重新登录会让服务端吊销当前凭据");
    expect(frame).toContain("确认");
    expect(frame).toContain("取消");
    expect(frame).not.toContain("Shell 命令");
    await r.press("\r");
    expect(decisions).toEqual([true]);
    r.unmount();
  });

  test("n = 取消", async () => {
    const decisions: boolean[] = [];
    const r = renderConfirm(decisions);
    await r.press("n");
    expect(decisions).toEqual([false]);
    r.unmount();
  });

  test("Esc = 取消", async () => {
    const decisions: boolean[] = [];
    const r = renderConfirm(decisions);
    await r.press("\x1b");
    expect(decisions).toEqual([false]);
    r.unmount();
  });
});
