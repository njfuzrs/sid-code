/**
 * 空 bracketed paste 必须下发成 `paste` 事件（剪贴板截图粘贴的入口）。
 *
 * 终端对「剪贴板里只有图片」的典型信号是一对空的 `\x1b[200~` / `\x1b[201~`。
 * InputArea 靠「收到空 paste → 读剪贴板图片」接住截图粘贴（P2-6），但 KeypressContext 的
 * bufferPaste 此前 `buffer.length > 0` 才下发——空 paste 在这里就被吞了，
 * 截图粘贴整条链路是死的，单测（只测 clipboard-image 纯函数）全绿放过。
 *
 * 本文件经真实 KeypressProvider 的转义序列解析链驱动，stdin harness 沿用
 * HotkeyChoiceList.test.tsx 的做法（emit 字符串，与生产 setEncoding("utf8") 同形态）。
 */

import { test, expect, describe } from "bun:test";
import React from "react";
import { PassThrough } from "node:stream";
import { renderSync } from "@sid-code/cli/ui/render-port/testing.ts";
import { Text } from "@sid-code/cli/ui/render-port/components.ts";
import {
  KeypressProvider,
  KeypressPriority,
  useKeypress,
  ESC_TIMEOUT,
  type Key,
} from "@sid-code/cli/ui/contexts/KeypressContext.tsx";

function mountProbe() {
  const got: Key[] = [];
  const stdout = new PassThrough() as unknown as NodeJS.WriteStream & {
    columns: number;
    rows: number;
  };
  stdout.columns = 80;
  stdout.rows = 24;
  (stdout as unknown as { isTTY: boolean }).isTTY = false;
  stdout.on("data", () => {});

  const stdin = new PassThrough() as unknown as NodeJS.ReadStream;
  const stdinAny = stdin as unknown as Record<string, unknown>;
  stdinAny.isTTY = true;
  stdinAny.setRawMode = () => stdin;
  stdinAny.setEncoding = () => stdin;
  stdinAny.ref = () => stdin;
  stdinAny.unref = () => stdin;

  function Probe() {
    useKeypress(KeypressPriority.Normal, (key) => {
      got.push(key);
      return true;
    });
    return <Text>probe</Text>;
  }

  const instance = renderSync(
    <KeypressProvider>
      <Probe />
    </KeypressProvider>,
    { stdout, stdin, patchConsole: false, exitOnCtrlC: false },
  );

  return {
    got,
    send: async (seq: string) => {
      stdin.emit("data", seq);
      await new Promise((r) => setTimeout(r, ESC_TIMEOUT * 2));
    },
    unmount: () => instance.unmount(),
  };
}

describe("bracketed paste 下发", () => {
  test("空 paste（剪贴板只有图片）→ 下发 sequence 为空串的 paste 事件", async () => {
    const m = mountProbe();
    await m.send("\x1b[200~\x1b[201~");
    const pastes = m.got.filter((k) => k.name === "paste");
    expect(pastes.length).toBe(1);
    expect(pastes[0]!.sequence).toBe("");
    m.unmount();
  });

  test("非空 paste 照常下发原文", async () => {
    const m = mountProbe();
    await m.send("\x1b[200~hello\x1b[201~");
    const pastes = m.got.filter((k) => k.name === "paste");
    expect(pastes.map((k) => k.sequence)).toEqual(["hello"]);
    m.unmount();
  });
});
