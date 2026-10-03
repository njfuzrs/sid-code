/**
 * T0.5 契约测试共用的假 TTY 流（B9）。
 *
 * 为什么不用 testing.ts 的 render shim：shim 的 stdout 是非 TTY，底座在非 TTY 下
 * 不挂 SIGCONT / resize、不隐藏光标、不进增量 diff —— R10 / L5 / X4 / I1c 这几条
 * 契约恰好全在 TTY 分支里。
 *
 * ⚠️ 卸载前必须先 `teardown()`：TTY 下 `unmount()` 会 `writeSync(1, …)` 直写 fd 1
 * （契约 X3），那是测试进程自己的 stdout，不是这里的 PassThrough。
 */
import { PassThrough } from "node:stream";
import type React from "react";
import { inkInstances } from "@sid-code/cli/ui/render-port/runtime.ts";
import { renderSync } from "@sid-code/cli/ui/render-port/testing.ts";

export const tick = (ms = 30) => new Promise((r) => setTimeout(r, ms));

export type FakeStdin = NodeJS.ReadStream & PassThrough & { isRaw: boolean };

export function ttyStreams(opts: { stdoutTTY?: boolean; columns?: number; rows?: number } = {}) {
  const stdout = new PassThrough() as unknown as NodeJS.WriteStream & PassThrough;
  Object.assign(stdout, {
    columns: opts.columns ?? 40,
    rows: opts.rows ?? 10,
    isTTY: opts.stdoutTTY ?? true,
  });
  let buf = "";
  stdout.on("data", (c: Buffer) => {
    buf += c.toString();
  });
  const stdin = new PassThrough() as unknown as FakeStdin;
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
  return {
    stdout,
    stdin,
    out: () => buf,
    clear: () => {
      buf = "";
    },
  };
}

type Streams = ReturnType<typeof ttyStreams>;

export function mountTTY(
  node: React.ReactNode,
  s: Streams,
  extra: { exitOnCtrlC?: boolean; onFrame?: () => void } = {},
) {
  const inst = renderSync(node, {
    stdout: s.stdout,
    stdin: s.stdin,
    patchConsole: false,
    exitOnCtrlC: extra.exitOnCtrlC ?? false,
    onFrame: extra.onFrame,
  } as Parameters<typeof renderSync>[1]);
  const ink = inkInstances.get(s.stdout) as unknown as LegacyInk;
  return {
    inst,
    ink,
    /** 关掉 TTY 标志再卸载，避免 writeSync(1) 写进测试进程的 stdout */
    teardown() {
      (s.stdout as unknown as { isTTY: boolean }).isTTY = false;
      inst.unmount();
      inkInstances.delete(s.stdout);
    },
  };
}

/**
 * 契约测试要碰的旧底座实例方法。端口目前只导出 `inkInstances`（CLI 也是这么拿实例的），
 * 这里把用到的方法列成显式类型，next 实现要提供同名能力。
 */
export interface LegacyInk {
  setAltScreenActive(active: boolean, mouseTracking?: boolean): void;
  setSelectionBgColor(color: string): void;
  forceRedraw(): void;
  copySelectionNoClear(): string;
  detachForShutdown(): void;
  selection: {
    anchor: { col: number; row: number } | null;
    focus: { col: number; row: number } | null;
  };
}

export const ENABLE_MOUSE = "\x1b[?1000h";
export const HIDE_CURSOR = "\x1b[?25l";
export const ENTER_ALT = "\x1b[?1049h";
export const ERASE_SCREEN = "\x1b[2J";
