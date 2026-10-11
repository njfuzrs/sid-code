// B9 / T7.1b：X3 卸载序列的子进程夹具，由 unmount.test.tsx 按不同变体运行。
// 结果就是 fd 1 原样：X3 兜底段同步直写 fd 1，不经 stdout 流对象。经 `process.stdout.write` 的每一块前插
// 一个 `<W>` 标记，以区分「经流写」与「直写 fd」—— 兜底段落在哪个通道也是契约的一部分。
// 用法：`bun unmount-app.tsx <变体>`，变体是 `-` 连接的开关：
//   empty（卸载前动态区已渲染为空）、toempty / fromempty（卸载前一刻改空 / 改回有内容）、static（有 <Static> 输出）、alt / mouse（<AlternateScreen> 与 mouseTracking）、noraw（不挂 KeypressProvider，没有 raw mode 使用者）、
//   notty（stdout 非 TTY）、pt（render 到另一个 TTY 流）、ptnotty（render 到非 TTY 流）、
//   change（卸载前一刻 rerender，有待发帧）、twice（unmount 两次）、sig（SIGTERM 结束而不是 unmount）、exit（直接 process.exit）、appexit（useApp().exit()）、susp（先 Ctrl+Z 挂起再 unmount）
import React from "react";
import { writeSync } from "node:fs";
import { PassThrough } from "node:stream";
import { AlternateScreen, Static, Text } from "@sid-code/cli/ui/render-port/components.ts";
import { render } from "@sid-code/cli/ui/render-port/runtime.ts";
import { useApp } from "@sid-code/cli/ui/render-port/hooks.ts";
import { KeypressProvider } from "@sid-code/cli/ui/contexts/KeypressContext.tsx";
import { SettingsProvider } from "@sid-code/cli/ui/contexts/SettingsContext.tsx";

const flags = new Set((process.argv[2] ?? "main").split("-"));
const mark = (m: string) => writeSync(1, `<${m}>`);
const tick = (ms = 150) => new Promise((r) => setTimeout(r, ms));

const out = process.stdout as unknown as Record<string, unknown>;
Object.defineProperty(out, "isTTY", { value: !flags.has("notty"), configurable: true });
Object.defineProperty(out, "columns", { value: 40, configurable: true, writable: true });
Object.defineProperty(out, "rows", { value: 8, configurable: true, writable: true });
const realWrite = process.stdout.write.bind(process.stdout);
(out as { write: unknown }).write = (c: unknown, ...a: unknown[]) => {
  if (String(c)) mark("W");
  return realWrite(c as string, ...(a as []));
};

let target: NodeJS.WriteStream = process.stdout;
if (flags.has("pt") || flags.has("ptnotty")) {
  const pt = new PassThrough();
  Object.assign(pt, { isTTY: !flags.has("ptnotty"), columns: 40, rows: 8 });
  pt.on("data", (d: Buffer) => writeSync(1, `<PT>${d.toString()}</PT>`));
  target = pt as unknown as NodeJS.WriteStream;
}

const stdin = new PassThrough() as unknown as NodeJS.ReadStream & { isRaw: boolean };
Object.assign(stdin, {
  isTTY: true,
  isRaw: false,
  setRawMode: (v: boolean) => ((stdin.isRaw = v), stdin),
  ref: () => stdin,
  unref: () => stdin,
});

let appExit: (() => void) | undefined;
function Exiter() {
  appExit = useApp().exit;
  return <Text>x</Text>;
}
let body: React.ReactNode = flags.has("static") ? (
  <>
    <Static items={["历史"]}>{(it) => <Text key={it}>{it}</Text>}</Static>
    <Exiter />
  </>
) : (
  <Exiter />
);
if (flags.has("alt"))
  body = <AlternateScreen mouseTracking={flags.has("mouse")}>{body}</AlternateScreen>;
if (!flags.has("noraw")) body = <KeypressProvider>{body}</KeypressProvider>;

const inst = await render(<SettingsProvider>{body}</SettingsProvider>, {
  stdout: target,
  stdin,
  stderr: process.stderr,
  patchConsole: false,
  exitOnCtrlC: false,
});
await tick();

if (flags.has("susp")) {
  // Ctrl+Z：拦下 SIGSTOP，只留标记（真停进程测试就挂了）
  const realKill = process.kill.bind(process);
  (process as { kill: unknown }).kill = (pid: number, sig?: string | number) =>
    sig === "SIGSTOP" ? (mark("STOP"), true) : realKill(pid, sig);
  (stdin as unknown as PassThrough).write("\x1a");
  await tick();
}

// empty：卸载前把动态区渲染成空（CLI 退出前 isQuitting 那一帧就是擦空动态区）
if (flags.has("empty")) {
  inst.rerender(<SettingsProvider>{null}</SettingsProvider>);
  await tick();
}
// toempty：卸载前一刻（同 tick、未出帧）改成空；fromempty：先空再在卸载前一刻改回有内容
if (flags.has("toempty")) inst.rerender(<SettingsProvider>{null}</SettingsProvider>);
if (flags.has("fromempty"))
  inst.rerender(
    <SettingsProvider>
      <Text>back</Text>
    </SettingsProvider>,
  );
mark("UNMOUNT");
if (flags.has("appexit")) {
  // useApp().exit()：CLI 正常退出（Ctrl+C 两次）走的就是这条
  if (flags.has("change"))
    inst.rerender(
      <SettingsProvider>
        <Text>changed</Text>
      </SettingsProvider>,
    );
  appExit?.();
  await tick();
} else if (flags.has("exit")) {
  // 不调 unmount，直接 process.exit：卸载由 signal-exit 的 exit 回调触发（CLI 的 Ctrl+C 退出路径）
  process.exit(0);
} else if (flags.has("sig")) {
  process.kill(process.pid, "SIGTERM");
  await tick(300);
} else {
  // change：卸载前一刻改内容，卸载时有一帧待发
  if (flags.has("change"))
    inst.rerender(
      <SettingsProvider>
        <Text>changed</Text>
      </SettingsProvider>,
    );
  inst.unmount();
  await tick();
  if (flags.has("twice")) {
    mark("AGAIN");
    inst.unmount();
    await tick();
  }
}
mark("END");
process.exit(0);
