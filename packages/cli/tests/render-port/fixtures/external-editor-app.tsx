// B9 / T6.1b：契约 X5（外部编辑器前后 enter/exitAlternateScreen）的子进程夹具，由 external-editor.test.tsx 运行。
//
// 渲染到 process.stdout、fd 1 由父进程重定向到文件（同 alt-screen-app.tsx）。stdin 的 setRawMode / ref / unref
// 调用以 `{raw:…}` / `{ref}` / `{unref}` 写进同一字节流，`useInput` 收到的按键写成 `{input:…}`，
// 步骤边界用 OSC 7777 标记。环境变量：FIXTURE_TTY=0 让 stdout 非 TTY；FIXTURE_INPUT=0 不挂 useInput（没人要 raw mode）。
import { writeSync } from "node:fs";
import { PassThrough } from "node:stream";
import React from "react";
import { AlternateScreen, Text } from "@sid-code/cli/ui/render-port/components.ts";
import { useInput } from "@sid-code/cli/ui/render-port/hooks.ts";
import { getRenderInstance, render } from "@sid-code/cli/ui/render-port/runtime.ts";

const out = process.stdout as unknown as Record<string, unknown>;
Object.defineProperty(out, "isTTY", { value: process.env.FIXTURE_TTY !== "0", configurable: true });
Object.defineProperty(out, "columns", { value: 20, configurable: true, writable: true });
Object.defineProperty(out, "rows", { value: 6, configurable: true, writable: true });
const log = (s: string) => writeSync(1, s);
const mark = (label: string) => log(`\x1b]7777;${label}\x07`);
const stdin = new PassThrough() as unknown as NodeJS.ReadStream & { isRaw: boolean };
Object.assign(stdin, {
  isTTY: true,
  isRaw: false,
  setRawMode(v: boolean) {
    log(`{raw:${v}}`);
    stdin.isRaw = v;
    return stdin;
  },
  ref: () => (log("{ref}"), stdin),
  unref: () => (log("{unref}"), stdin),
});
const settle = () => new Promise((r) => setTimeout(r, 80));

function In({ t }: { t: string }) {
  useInput((i) => log(`{input:${i}}`));
  return <Text>{t}</Text>;
}

const name = process.argv[2]!;
const inAlt = name.startsWith("alt");
const withInput = process.env.FIXTURE_INPUT !== "0";
const body = (t: string, extraLine = false) => {
  const one = withInput ? <In t={t} /> : <Text>{t}</Text>;
  const inner = extraLine ? (
    <>
      {one}
      <Text>line2</Text>
    </>
  ) : (
    one
  );
  return inAlt ? (
    <AlternateScreen mouseTracking={name !== "altNoMouse"}>{inner}</AlternateScreen>
  ) : (
    inner
  );
};

const inst = await render(body("main", name === "shrink"), {
  stdout: process.stdout,
  stdin,
  stderr: process.stderr,
  patchConsole: false,
  exitOnCtrlC: false,
});
await settle();
mark("mounted");
const ink = getRenderInstance(process.stdout)!;

if (name === "exitOnly") {
  ink.exitAlternateScreen();
  mark("exited");
} else {
  ink.enterAlternateScreen();
  mark("entered");
  if (name === "double") {
    ink.enterAlternateScreen();
    mark("entered2");
  }
  // 编辑器自己的输出
  process.stdout.write("EDITOR");
  if (name === "commit" || name === "shrink" || inAlt) inst.rerender(body("during"));
  if (name === "resize" || name === "altResize") {
    out.columns = 30;
    process.stdout.emit("resize");
  }
  if (name === "input") stdin.write("q");
  if (name === "redraw") ink.forceRedraw();
  if (name === "sigcont" || name === "altSigcont") process.emit("SIGCONT" as NodeJS.Signals);
  await settle();
  mark("during");
  ink.exitAlternateScreen();
  mark("exited");
  if (name === "double") {
    ink.exitAlternateScreen();
    mark("exited2");
  }
}
await settle();
mark("afterExit");
inst.rerender(body("post"));
await settle();
mark("post");
mark("unmount");
inst.unmount();
await settle();
process.exit(0);
