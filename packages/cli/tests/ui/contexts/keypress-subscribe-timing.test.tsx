/**
 * 回归：useKeypress 的订阅必须在「帧可见」之前完成。
 *
 * 2026-11-11 CI macOS 上 PluginsDialog「面板整帧」用例反复红：测试看到列表帧后立即按
 * Enter，帧却一直停在列表。根因是 useKeypress 用 useEffect（passive effect）订阅——
 * 渲染器在 commit 阶段已把帧写出，passive effect 被推迟到后续宏任务，中间这段窗口里
 * 到达的按键被 broadcast 给空订阅表，静默丢失。用户侧表现：对话框刚弹出时的预输入被吃。
 *
 * 本用例把窗口压到最窄：帧一出现（setImmediate 级轮询，不给 passive effect 留宏任务）
 * 就发按键。改回 useEffect 时这里稳定红（本机实测）。
 */

import { test, expect } from "bun:test";
import React, { useEffect, useState } from "react";
import { PassThrough } from "node:stream";
import { renderSync } from "@sid-code/cli/ui/render-port/testing.ts";
import { Text } from "@sid-code/cli/ui/render-port/components.ts";
import {
  KeypressProvider,
  KeypressPriority,
  useKeypress,
  type Key,
} from "@sid-code/cli/ui/contexts/KeypressContext.tsx";

/**
 * 订阅者必须在**异步更新之后**才挂载，才能复现：首次 render 会同步冲刷 effect，
 * 而 PluginsDialog 的列表（BaseSelectionList）是 refresh() 的 await 之后 setRows 才挂上的。
 */
function Host() {
  const [ready, setReady] = useState(false);
  useEffect(() => {
    const t = setTimeout(() => setReady(true), 10);
    return () => clearTimeout(t);
  }, []);
  return ready ? <Probe /> : <Text>加载中</Text>;
}

function Probe() {
  const [pressed, setPressed] = useState(false);
  useKeypress(KeypressPriority.Critical, (key: Key) => {
    if (key.name === "enter" || key.name === "return") {
      setPressed(true);
      return true;
    }
    return false;
  });
  return <Text>{pressed ? "已按下" : "就绪"}</Text>;
}

test("帧刚出现就按键：按键不丢（订阅早于帧可见）", async () => {
  let output = "";
  const stdout = new PassThrough() as unknown as NodeJS.WriteStream & {
    columns: number;
    rows: number;
  };
  stdout.columns = 80;
  stdout.rows = 24;
  (stdout as unknown as { isTTY: boolean }).isTTY = false;
  stdout.on("data", (chunk: Buffer) => {
    output += chunk.toString();
  });
  const stdin = new PassThrough() as unknown as NodeJS.ReadStream;
  const s = stdin as unknown as Record<string, unknown>;
  s.isTTY = true;
  s.setRawMode = () => stdin;
  s.setEncoding = () => stdin;
  s.ref = () => stdin;
  s.unref = () => stdin;

  const instance = renderSync(
    <KeypressProvider>
      <Host />
    </KeypressProvider>,
    { stdout, stdin, patchConsole: false, exitOnCtrlC: false },
  );
  try {
    const deadline = Date.now() + 2_000;
    while (!output.includes("就绪") && Date.now() < deadline) {
      await new Promise((r) => setImmediate(r));
    }
    expect(output).toContain("就绪");

    stdin.emit("data", "\r");

    const until = Date.now() + 2_000;
    while (!output.includes("已按下") && Date.now() < until) {
      await new Promise((r) => setTimeout(r, 10));
    }
    expect(output).toContain("已按下");
  } finally {
    instance.unmount();
  }
});
