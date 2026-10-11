/**
 * next 实现：测试专用（B9 / T3.2）。
 *
 * `render` / `lastFrame` 的语义按 legacy shim 黑盒探测得来（不读旧代码）：
 * - stdout 非 TTY、默认 80×24（可传 `{columns, rows}`），所以底座每次提交写一整帧（契约 R12），
 *   每次写入去掉 DEC 2026 包裹后记为一帧；`lastFrame()` 是最后一帧，`frames` 是全部帧；
 * - 卸载时底座补写的换行也记为一帧（`"\n"`）；空树不写、不记帧；
 * - `stdout.get()` 返回原始字节（含同步包裹与组件直写的 OSC）；`stdin.write` 写进假 stdin。
 */
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { ReactElement } from "react";
import { render as upstreamRender } from "@sid-code/tui";
import upstreamInstances from "@sid-code/tui/instances.ts";
import { enableFrameThrottleInTests } from "@sid-code/tui/frame/schedule.ts";

const BSU = "\x1b[?2026h";
const ESU = "\x1b[?2026l";

type ShimOptions = { columns?: number; rows?: number };

class ShimStdout extends EventEmitter {
  readonly frames: string[] = [];
  private raw = "";
  columns: number;
  rows: number;
  constructor(columns: number, rows: number) {
    super();
    this.columns = columns;
    this.rows = rows;
  }
  write = (data: string | Uint8Array, ...rest: unknown[]): boolean => {
    const s = typeof data === "string" ? data : Buffer.from(data).toString();
    this.raw += s;
    if (s.startsWith(BSU) && s.endsWith(ESU)) this.frames.push(s.slice(BSU.length, -ESU.length));
    const cb = rest.find((x) => typeof x === "function") as (() => void) | undefined;
    cb?.();
    return true;
  };
  get = () => this.raw;
}

export function render(tree: ReactElement, options: ShimOptions = {}) {
  const stdout = new ShimStdout(options.columns ?? 80, options.rows ?? 24);
  const stdinStream = new PassThrough() as unknown as NodeJS.ReadStream & PassThrough;
  Object.assign(stdinStream, {
    isTTY: true,
    isRaw: false,
    setRawMode(v: boolean) {
      (stdinStream as unknown as { isRaw: boolean }).isRaw = v;
      return stdinStream;
    },
    ref: () => stdinStream,
    unref: () => stdinStream,
  });
  const stderr = new ShimStdout(stdout.columns, stdout.rows);
  const inst = upstreamRender(tree, {
    stdout: stdout as unknown as NodeJS.WriteStream,
    stderr: stderr as unknown as NodeJS.WriteStream,
    stdin: stdinStream,
    debug: false,
    exitOnCtrlC: false,
    patchConsole: false,
  });
  return {
    frames: stdout.frames,
    lastFrame: () => stdout.frames.at(-1),
    rerender: inst.rerender,
    unmount: () => inst.unmount(),
    stdin: { write: (data: string) => stdinStream.write(data) },
    stdout: { get: stdout.get },
  };
}

export const renderSync = upstreamRender;

/**
 * 从实例注册表里摘掉这个 stdout 的实例。正常卸载会自己摘；`detachForShutdown` 之后
 * unmount 早退、不会摘（X4），同一个 stdout 再 render 会复用那个已卸载的实例。
 */
export function forgetRenderInstance(stdout: NodeJS.WriteStream): void {
  upstreamInstances.delete(stdout);
}

/**
 * 在测试进程里打开真实的帧调度（16ms 节流 + microtask 合并，契约 R2），返回恢复函数。
 * 测试环境默认每次提交同步出帧（契约 R13），只有专门测调度的用例才调这个。开关在 `frame/schedule.ts`。
 */
export function enableFrameThrottle(): () => void {
  return enableFrameThrottleInTests();
}
