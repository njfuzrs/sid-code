/**
 * 新增的两个 TUI 审批框（项目扩展信任 / Bridge 准入）真实按键测试。
 *
 * 它们替代的是终端里的 readline `[y/N]`。要钉住的是：按键经 KeypressProvider 真能到组件，
 * 安全默认（初始聚焦「不信任 / 拒绝」，手滑回车不放行），Esc 等同拒绝。
 * harness 同 HotkeyChoiceList.test.tsx（stdin emit 字符串，与生产 setEncoding("utf8") 同形）。
 */

import { test, expect, describe } from "bun:test";
import React from "react";
import { PassThrough } from "node:stream";
import { renderSync } from "@sid-code/cli/ui/render-port/testing.ts";
import { KeypressProvider, ESC_TIMEOUT } from "@sid-code/cli/ui/contexts/KeypressContext.tsx";
import { ExtensionTrustDialog } from "@sid-code/cli/ui/components/ExtensionTrustDialog.tsx";
import { BridgeAdmissionDialog } from "@sid-code/cli/ui/components/BridgeAdmissionDialog.tsx";

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

const KEY = { up: "\x1b[A", enter: "\r", escape: "\x1b" } as const;

describe("ExtensionTrustDialog", () => {
  const items = [
    { kind: "命令", displayPath: ".sid-code/commands/evil.md" },
    { kind: "skill", displayPath: ".claude/skills/x/SKILL.md" },
  ];

  test("列出待确认扩展；直接回车 = 不信任（安全默认）", async () => {
    const decisions: boolean[] = [];
    const r = renderWithKeys(
      <ExtensionTrustDialog
        items={items}
        workspacePath="/repo"
        onDecision={(v) => decisions.push(v)}
        onClose={() => decisions.push(false)}
      />,
    );
    await r.press("");
    const frame = r.lastFrame();
    expect(frame).toContain("发现 2 个未信任的项目级扩展");
    expect(frame).toContain("[命令] .sid-code/commands/evil.md");
    expect(frame).not.toContain("[y/N]");
    await r.press(KEY.enter);
    expect(decisions).toEqual([false]);
    r.unmount();
  });

  test("↑ 选「信任」再回车 = 批准；Esc = 不信任", async () => {
    const decisions: boolean[] = [];
    const r = renderWithKeys(
      <ExtensionTrustDialog
        items={items}
        workspacePath="/repo"
        onDecision={(v) => decisions.push(v)}
        onClose={() => decisions.push(false)}
      />,
    );
    await r.press(KEY.up);
    await r.press(KEY.enter);
    await r.press(KEY.escape);
    expect(decisions).toEqual([true, false]);
    r.unmount();
  });
});

describe("BridgeAdmissionDialog", () => {
  test("展示准入说明；回车默认拒绝，↑ 后回车允许，Esc 拒绝", async () => {
    const decisions: boolean[] = [];
    const r = renderWithKeys(
      <BridgeAdmissionDialog
        message={"即将启用 Bridge 远程控制：\n  wss://relay.example.com"}
        onDecision={(v) => decisions.push(v)}
      />,
    );
    await r.press("");
    expect(r.lastFrame()).toContain("wss://relay.example.com");
    await r.press(KEY.enter);
    await r.press(KEY.up);
    await r.press(KEY.enter);
    await r.press(KEY.escape);
    expect(decisions).toEqual([false, true, false]);
    r.unmount();
  });
});
