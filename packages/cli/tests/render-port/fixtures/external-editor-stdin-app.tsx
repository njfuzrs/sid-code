// 外部编辑器 handoff 期间 stdin 流必须 pause 的子进程夹具，由 external-editor-stdin.test.tsx 运行。
//
// 复现生产形态：CLI 的 KeypressContext 等直接挂 `stdin.on('data')`，流处于 flowing。让渡期间父进程若继续读
// tty fd，就会和编辑器抢按键（Ctrl+G 后 vi 收不到任何输入）。这里用 PassThrough 模拟 stdin，
// 在让渡前后打印 isPaused() 与 data 监听收到的内容，结果以一行 JSON 写到 stdout。
import { writeSync } from "node:fs";
import { PassThrough } from "node:stream";
import React from "react";
import { Text } from "@sid-code/cli/ui/render-port/components.ts";
import { useInput } from "@sid-code/cli/ui/render-port/hooks.ts";
import { getRenderInstance, render } from "@sid-code/cli/ui/render-port/runtime.ts";

const out = process.stdout as unknown as Record<string, unknown>;
Object.defineProperty(out, "isTTY", { value: true, configurable: true });
Object.defineProperty(out, "columns", { value: 20, configurable: true, writable: true });
Object.defineProperty(out, "rows", { value: 6, configurable: true, writable: true });
const stdin = new PassThrough() as unknown as NodeJS.ReadStream & { isRaw: boolean };
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
const settle = () => new Promise((r) => setTimeout(r, 80));

// 记录 pause / resume 调用：PassThrough 挂了 readable 监听后 isPaused() 恒 true，状态位不能当判据
const calls: string[] = [];
const origPause = stdin.pause.bind(stdin);
const origResume = stdin.resume.bind(stdin);
stdin.pause = () => (calls.push("pause"), origPause());
stdin.resume = () => (calls.push("resume"), origResume());

const seen: string[] = [];
const inputs: string[] = [];
// 与 KeypressContext 相同：直接挂 data 监听（会把流切到 flowing）
stdin.on("data", (d) => seen.push(String(d)));

function In() {
  useInput((i) => inputs.push(i));
  return <Text>x</Text>;
}

const inst = await render(<In />, {
  stdout: process.stdout,
  stdin,
  stderr: process.stderr,
  patchConsole: false,
  exitOnCtrlC: false,
});
await settle();
const ink = getRenderInstance(process.stdout)!;
const result: Record<string, unknown> = {};
calls.length = 0;

ink.enterAlternateScreen();
ink.enterAlternateScreen(); // 重复让渡只 pause 一次
result.callsAfterEnter = calls.join(",");
stdin.write("q");
await settle();
result.seenDuring = seen.join("");

ink.exitAlternateScreen();
result.callsAfterExit = calls.join(",");
ink.exitAlternateScreen(); // 重复收回不再 resume
result.callsAfterExit2 = calls.join(",");
await settle();
result.seenAfter = seen.join("");
result.inputsAfter = inputs.join("");

inst.unmount();
await settle();
writeSync(1, `\n@@RESULT@@${JSON.stringify(result)}\n`);
process.exit(0);
