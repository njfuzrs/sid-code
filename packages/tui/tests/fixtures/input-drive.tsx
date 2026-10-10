/**
 * 键位对拍的驱动（B9 / T5.1）：每条语料挂一个 `useInput` 组件，按块写 stdin，记下回调收到的 `(input, key)`。
 *
 * 不 import 任何底座：`Text` / `useInput` / `renderSync` 由调用方注入（生成器注入端口 legacy，测试注入新底座）。
 * key 记**完整对象**（含值为 false 的字段）：字段集合本身就是端口面，少一个多一个都要红。
 * 语料之间互不共享解析器状态，所以每条单独挂载；按批并发跑，批内每条有自己的 stdin / stdout。
 */
import { PassThrough } from "node:stream";
import type * as ReactNS from "react";
import type { InputCase } from "./input-corpus.ts";

export type InputEventRecord = [string, Record<string, unknown>];

type Engine = {
  React: typeof ReactNS;
  Text: ReactNS.ComponentType<Record<string, unknown>>;
  useInput: (handler: (input: string, key: Record<string, unknown>) => void) => void;
  renderSync: (
    node: ReactNS.ReactElement,
    options: Record<string, unknown>,
  ) => { unmount: () => void };
  forget: (stdout: NodeJS.WriteStream) => void;
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** 最后一块写完后的等待：要盖过 ESC 冲刷的超时（旧底座约 50ms） */
const TAIL_MS = 90;

async function driveOne(engine: Engine, c: InputCase): Promise<InputEventRecord[]> {
  const { React, Text, useInput, renderSync, forget } = engine;
  const log: InputEventRecord[] = [];
  function Probe() {
    useInput((input, key) => {
      // 字段按名排序，顺序不算行为
      const sorted = Object.fromEntries(Object.entries(key).sort(([a], [b]) => (a < b ? -1 : 1)));
      log.push([input, sorted]);
    });
    return React.createElement(Text, null, "k");
  }
  const stdout = Object.assign(new PassThrough(), { columns: 20, rows: 5, isTTY: false });
  stdout.resume();
  const stdin = new PassThrough() as PassThrough & Record<string, unknown>;
  Object.assign(stdin, {
    isTTY: true,
    isRaw: false,
    setRawMode(v: boolean) {
      stdin.isRaw = v;
      return stdin;
    },
    ref: () => stdin,
    unref: () => stdin,
  });
  const inst = renderSync(React.createElement(Probe), {
    stdout,
    stdin,
    patchConsole: false,
    exitOnCtrlC: false,
  });
  await sleep(10);
  for (const ch of c.chunks) {
    if (typeof ch === "number") await sleep(ch);
    else stdin.write(ch);
  }
  await sleep(TAIL_MS);
  inst.unmount();
  forget(stdout as unknown as NodeJS.WriteStream);
  return log;
}

export async function driveInputs(
  engine: Engine,
  corpus: InputCase[],
  batch = 64,
): Promise<Record<string, InputEventRecord[]>> {
  const out: Record<string, InputEventRecord[]> = {};
  for (let i = 0; i < corpus.length; i += batch) {
    const part = corpus.slice(i, i + batch);
    const res = await Promise.all(part.map((c) => driveOne(engine, c)));
    part.forEach((c, j) => (out[c.name] = res[j]!));
  }
  return out;
}
