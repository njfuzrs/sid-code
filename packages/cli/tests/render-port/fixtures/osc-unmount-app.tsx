// B9 / T7.2b：契约 O3 的子进程夹具。由 terminal-progress.test.tsx 按不同 SID_TUI_RENDERER / 环境运行。
// 必须是子进程：旧底座卸载时 `writeSync(1)` 直写 fd 1，进程内 PassThrough 截不到（同 term-bench）。
// 输出：`<RAW>` 之前是挂载期，`<UNMOUNT>` 之后是卸载序列，`<END …>` 带上 TerminalWriteContext 的观测。
import React, { useContext, useEffect } from "react";
import { writeSync } from "node:fs";
import { Text } from "@sid-code/cli/ui/render-port/components.ts";
import { TerminalWriteContext } from "@sid-code/cli/ui/render-port/hooks.ts";
import { render } from "@sid-code/cli/ui/render-port/runtime.ts";

const out = process.stdout as unknown as Record<string, unknown>;
Object.defineProperty(out, "isTTY", { value: process.env.FIXTURE_TTY !== "0", configurable: true });
Object.defineProperty(out, "columns", { value: 40, configurable: true, writable: true });
Object.defineProperty(out, "rows", { value: 10, configurable: true, writable: true });

const seen: unknown[] = [];
function App() {
  const writeRaw = useContext(TerminalWriteContext);
  seen.push(writeRaw);
  useEffect(() => {
    writeRaw?.("<RAW>");
  }, [writeRaw]);
  return <Text>x</Text>;
}
const tick = () => new Promise((r) => setTimeout(r, 60));
const inst = await render(<App />, {
  stdout: process.stdout,
  stderr: process.stderr,
  patchConsole: false,
  exitOnCtrlC: false,
});
await tick();
inst.rerender(<App />);
await tick();
writeSync(1, "<UNMOUNT>");
inst.unmount();
await tick();
const kind = seen[0] === null ? "null" : typeof seen[0];
writeSync(1, `<END ctx=${kind} renders=${seen.length} stable=${seen.every((w) => w === seen[0])}>`);
process.exit(0);
