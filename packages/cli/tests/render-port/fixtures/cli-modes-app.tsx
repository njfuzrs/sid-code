// B9 / T5.3b：I4 归属表「CLI：开 / 关」两列的子进程夹具。由 cli-modes.test.tsx 按不同环境运行。
// 走生产入口 createFullScreen（fullscreen.ts 的 ?7）+ 真实 KeypressProvider（terminalCapabilityManager 的 ?2004h）
// + MouseProvider（MouseContext 的鼠标全套），底座与 CLI 写的是同一个 process.stdout。
// 每次 process.stdout.write 按调用栈归属：栈上第一个仓内源码帧在 `packages/cli/src/`（render-port 除外）记 `cli:`，
// 否则记 `base:`。结果以一行 `JSON:` 写到 stderr，夹着 `<<标记>>`。
// 卸载时底座 writeSync(1) 直写 fd 1 的那段（X3）不经 stdout.write，不在记录里 —— 它归底座，本夹具只关心 CLI 那几列。
// 用法：`bun cli-modes-app.tsx <main|alt|alt-copy>`
import React from "react";
import { PassThrough } from "node:stream";
import { Text } from "../../../src/ui/render-port/components.ts";
import { createFullScreen } from "../../../src/ui/fullscreen.ts";
import { KeypressProvider } from "../../../src/ui/contexts/KeypressContext.tsx";
import {
  MouseProvider,
  disableMouseEvents,
  enableMouseEvents,
} from "../../../src/ui/contexts/MouseContext.tsx";
import { cleanupTerminalOnExit } from "../../../src/ui/utils/terminalCapabilityManager.ts";

const scenario = process.argv[2] ?? "main";
const alternateBuffer = scenario !== "main";

const out = process.stdout as unknown as Record<string, unknown>;
Object.defineProperty(out, "isTTY", { value: true, configurable: true });
Object.defineProperty(out, "columns", {
  value: 40,
  configurable: true,
  writable: true,
});
Object.defineProperty(out, "rows", {
  value: 10,
  configurable: true,
  writable: true,
});

// createFullScreen 固定用 process.stdin：换成可控的假 TTY
const stdin = new PassThrough() as unknown as NodeJS.ReadStream & {
  isRaw: boolean;
};
Object.assign(stdin, {
  isTTY: true,
  isRaw: false,
  setRawMode: (v: boolean) => ((stdin.isRaw = v), stdin),
  ref: () => stdin,
  unref: () => stdin,
});
Object.defineProperty(process, "stdin", { value: stdin, configurable: true });

const tick = (ms = 60) => new Promise((r) => setTimeout(r, ms));
const log: string[] = [];
const mark = (m: string) => void log.push(`<<${m}>>`);

const SRC = /\/packages\/(cli|tui)\/src\//;
function owner(): "cli" | "base" {
  for (const line of (new Error().stack ?? "").split("\n").slice(2)) {
    if (!SRC.test(line)) continue;
    return line.includes("/packages/cli/src/") && !line.includes("/render-port/") ? "cli" : "base";
  }
  return "base";
}
const realWrite = process.stdout.write.bind(process.stdout);
(
  process.stdout as unknown as {
    write: (c: unknown, ...a: unknown[]) => boolean;
  }
).write = (c, ...a) => {
  log.push(`${owner()}:${String(c)}`);
  return realWrite(c as string, ...(a as []));
};

const app = createFullScreen(
  <KeypressProvider>
    <MouseProvider mouseEventsEnabled={alternateBuffer}>
      <Text>主界面</Text>
    </MouseProvider>
  </KeypressProvider>,
  { alternateBuffer },
);
await app.start();
await tick();
mark("mounted");

if (scenario === "alt-copy") {
  // App.tsx 的 Copy Mode 切换：Ctrl+S 进入关鼠标，任意非导航键退出重开
  disableMouseEvents();
  await tick();
  mark("copy-on");
  enableMouseEvents();
  await tick();
  mark("copy-off");
}

mark("unmount");
app.instance.unmount();
await app.waitUntilExit();
await tick();
mark("exited");
// 退出清理只在 detectCapabilities() 里注册，而生产代码没有调用它：钉住「CLI 不关 ?2004」这一事实
mark(`exit-cleanup=${process.listeners("exit").includes(cleanupTerminalOnExit as never)}`);
console.error(`JSON:${JSON.stringify(log)}`);
process.exit(0);
