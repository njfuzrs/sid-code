// B9 / T5.3a：契约 I4 的子进程夹具。由 terminal-modes.test.tsx 按不同环境运行。
// 必须是子进程：扩展键开不开在底座模块加载时按环境变量判定一次，进程内改 env 不生效。
// 用法：`bun terminal-modes-app.tsx <场景>`；stdout 是 PassThrough 之外的真 fd，结果以一行 `JSON:` 写到 stderr，
// 是 stdout.write 的逐次入参，夹着 `<<标记>>` 与 `{ref} / {unref} / {raw:…}` 调用记录。
// `unmount-fd1` 场景例外：render 到 process.stdout，fd 1 原样就是结果（X3 那段直写 fd 1，PassThrough 截不到）。
import React, { useState } from "react";
import { writeSync } from "node:fs";
import { PassThrough } from "node:stream";
import { Text } from "@sid-code/cli/ui/render-port/components.ts";
import { useApp, useInput, useStdin } from "@sid-code/cli/ui/render-port/hooks.ts";
import { render } from "@sid-code/cli/ui/render-port/runtime.ts";
import { mountTTY, tick, ttyStreams } from "../tty-streams.ts";

const scenario = process.argv[2] ?? "mount";
const stdoutTTY = process.env.FIXTURE_TTY !== "0";

// I1c 的 5s 静默：拨快 Date.now，而不是真等
let skew = 0;
const realNow = Date.now.bind(Date);
Date.now = () => realNow() + skew;

(process as unknown as { kill: (pid: number, sig: string) => boolean }).kill = (_pid, sig) => {
  log.push(`{kill:${sig}}`);
  return true;
};

const log: string[] = [];
const mark = (m: string) => log.push(`<<${m}>>`);

if (scenario === "unmount-fd1") {
  const out = process.stdout as unknown as Record<string, unknown>;
  Object.defineProperty(out, "isTTY", { value: stdoutTTY, configurable: true });
  Object.defineProperty(out, "columns", { value: 40, configurable: true, writable: true });
  Object.defineProperty(out, "rows", { value: 10, configurable: true, writable: true });
  const stdin = new PassThrough() as unknown as NodeJS.ReadStream & { isRaw: boolean };
  Object.assign(stdin, {
    isTTY: true,
    isRaw: false,
    setRawMode: (v: boolean) => ((stdin.isRaw = v), stdin),
    ref: () => stdin,
    unref: () => stdin,
  });
  function In() {
    useInput(() => {});
    return <Text>i</Text>;
  }
  const inst = await render(process.env.FIXTURE_INPUT === "0" ? <Text>x</Text> : <In />, {
    stdout: process.stdout,
    stdin,
    stderr: process.stderr,
    patchConsole: false,
    exitOnCtrlC: false,
  } as never);
  await tick(60);
  writeSync(1, "<UNMOUNT>");
  inst.unmount();
  await tick(60);
  writeSync(1, "<END>");
  process.exit(0);
}

const s = ttyStreams({ stdoutTTY });
s.stdout.on("data", (c: Buffer) => log.push(c.toString()));
{
  const st = s.stdin as unknown as Record<string, unknown>;
  const raw = (st.setRawMode as (v: boolean) => unknown).bind(s.stdin);
  st.setRawMode = (v: boolean) => (log.push(`{raw:${v}}`), raw(v));
  st.ref = () => (log.push("{ref}"), s.stdin);
  st.unref = () => (log.push("{unref}"), s.stdin);
}

let stdinApi: { setRawMode(v: boolean): void } | undefined;
let exitApp: (() => void) | undefined;
let setActive: (b: boolean) => void = () => {};
function Raw() {
  stdinApi = useStdin() as never;
  exitApp = useApp().exit;
  return <Text>h</Text>;
}
function Input() {
  const [active, set] = useState(true);
  setActive = set;
  useInput(() => {}, { isActive: active });
  return <Text>i</Text>;
}
function TwoInputs() {
  useInput(() => {});
  useInput(() => {});
  return <Text>t</Text>;
}
const tree = scenario === "two" ? <TwoInputs /> : scenario.startsWith("raw") ? <Raw /> : <Input />;
const m = mountTTY(tree, s);
await tick();
mark("mounted");

const cont = async () => {
  process.emit("SIGCONT" as never);
  await tick();
};

switch (scenario) {
  case "mount":
  case "two":
    break;
  case "raw-count": {
    const api = stdinApi!;
    api.setRawMode(true);
    mark("r1");
    api.setRawMode(true);
    mark("r2");
    api.setRawMode(false);
    mark("f1");
    api.setRawMode(false);
    mark("f0");
    api.setRawMode(false);
    mark("neg");
    api.setRawMode(true);
    mark("back0");
    api.setRawMode(true);
    mark("on");
    break;
  }
  case "active":
    setActive(false);
    await tick();
    mark("off");
    setActive(true);
    await tick();
    mark("on");
    break;
  case "raw-exit":
    stdinApi!.setRawMode(true);
    mark("on");
    exitApp!();
    await tick();
    mark("exited");
    break;
  case "suspend":
    s.stdin.write("\x1a");
    await tick();
    mark("stopped");
    await cont();
    mark("cont");
    break;
  case "suspend-drop":
    // 挂起期间计数降到 0：恢复时不重开输入模式，之后再 0 → 1 照常开
    s.stdin.write("\x1a");
    await tick();
    mark("stopped");
    setActive(false);
    await tick();
    mark("cnt0");
    await cont();
    mark("cont");
    setActive(true);
    await tick();
    mark("on");
    break;
  case "suspend-unmount":
    s.stdin.write("\x1a");
    await tick();
    mark("stopped");
    m.teardown();
    await tick();
    mark("unmounted");
    await cont();
    mark("cont");
    console.error(`JSON:${JSON.stringify(log)}`);
    process.exit(0);
  // eslint-disable-next-line no-fallthrough
  case "probe-reply":
    // 终端探查的回复不影响扩展键（只看环境变量）
    s.stdin.write("\x1bP>|kitty(0.35.2)\x1b\\");
    s.stdin.write("\x1b[?62;22c");
    await tick();
    setActive(false);
    await tick();
    mark("off");
    setActive(true);
    await tick();
    mark("on");
    break;
  case "silence":
  case "silence-short":
  case "silence-alt":
  case "silence-alt-mouse":
    if (scenario.startsWith("silence-alt")) {
      m.ink.setAltScreenActive(true, scenario === "silence-alt-mouse");
      await tick();
    }
    mark("before");
    skew += scenario === "silence-short" ? 4000 : 5300;
    s.stdin.write("a");
    await tick();
    mark("after");
    break;
  default:
    throw new Error(`未知场景 ${scenario}`);
}

mark("unmount");
m.teardown();
await tick();
console.error(`JSON:${JSON.stringify(log)}`);
process.exit(0);
