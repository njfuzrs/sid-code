/**
 * 帧对拍的驱动（B9 / T3.2）：按 frame-corpus 逐帧提交，记下每帧写出的字节与 full reset 原因。
 *
 * 不 import 任何底座：`Box` / `Text` / `renderSync` 由调用方注入（生成器注入端口 legacy，测试注入新底座）。
 * 单进程跑：帧 diff 与环境变量无关，不需要像屏幕向量那样按环境分子进程。
 */
import { PassThrough } from "node:stream";
import type * as ReactNS from "react";
import type { FrameCase } from "./frame-corpus.ts";

export type FrameRecord = { bytes: string; flickers: string[] };

type Engine = {
  React: typeof ReactNS;
  Box: ReactNS.ComponentType<Record<string, unknown>>;
  Text: ReactNS.ComponentType<Record<string, unknown>>;
  renderSync: (
    node: ReactNS.ReactElement,
    options: Record<string, unknown>,
  ) => {
    rerender: (node: ReactNS.ReactElement) => void;
    unmount: () => void;
  };
  /** 按 stdout 取渲染实例（forceRedraw 步骤用）；生成器注入端口 getRenderInstance，测试注入新底座 instances */
  instanceOf: (stdout: NodeJS.WriteStream) => { forceRedraw(): void } | undefined;
};

const tick = (ms = 20) => new Promise((r) => setTimeout(r, ms));

export async function driveFrames(engine: Engine, c: FrameCase): Promise<FrameRecord[]> {
  const { React, Box, Text, renderSync, instanceOf } = engine;
  const tree = (lines: string[]) =>
    React.createElement(
      Box,
      { flexDirection: "column" },
      ...lines.map((l, i) => React.createElement(Text, { key: i }, l)),
    );

  const stdout = Object.assign(new PassThrough(), {
    columns: c.cols ?? 20,
    rows: c.rows ?? 6,
    isTTY: c.tty ?? true,
  });
  let buf = "";
  stdout.on("data", (d: Buffer) => {
    buf += d.toString();
  });
  const stdin = new PassThrough() as PassThrough & Record<string, unknown>;
  Object.assign(stdin, {
    isTTY: true,
    isRaw: false,
    setRawMode: () => stdin,
    ref: () => stdin,
    unref: () => stdin,
  });
  let flickers: string[] = [];
  const onFrame = (e: { flickers?: Array<{ reason: string }> }) => {
    flickers.push(...(e.flickers ?? []).map((f) => f.reason));
  };

  const take = (): FrameRecord => {
    const r = { bytes: buf, flickers };
    buf = "";
    flickers = [];
    return r;
  };

  const [first, ...rest] = c.frames;
  const inst = renderSync(tree(first as string[]), {
    stdout,
    stdin,
    patchConsole: false,
    exitOnCtrlC: false,
    onFrame,
  });
  await tick();
  const out = [take()];
  for (const f of rest) {
    if (Array.isArray(f)) {
      inst.rerender(tree(f));
    } else if ("sigcont" in f) {
      process.emit("SIGCONT" as NodeJS.Signals);
    } else if ("forceRedraw" in f) {
      if (f.resizeFirst) {
        [stdout.columns, stdout.rows] = f.resizeFirst;
        stdout.emit("resize");
      }
      instanceOf(stdout as unknown as NodeJS.WriteStream)!.forceRedraw();
      if (f.then) inst.rerender(tree(f.then));
    } else {
      // 同一 tick 内连发（R7 合并）
      for (const [cols, rows] of "resize" in f ? [f.resize] : f.resizes) {
        stdout.columns = cols;
        stdout.rows = rows;
        stdout.emit("resize");
      }
    }
    await tick();
    out.push(take());
  }
  // 卸载字节不比：非 TTY 收尾与 TTY 显示光标是生命周期（X 组），不是帧 diff
  stdout.isTTY = false;
  inst.unmount();
  return out;
}
