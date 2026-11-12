/**
 * 连续两个同类确认请求：第二个弹窗必须能响应按键。
 *
 * 回归背景（2026-11-11 PTY 实测）：模型一次发两个并行 bash，两次都要确认。第一个答完后
 * app.ts 置 null、interactionQueue 立刻写入第二个请求，两次 update 合并进同一帧，
 * React 复用了同一个 PermissionDialog 实例——组件内去重用的 `resolvedRef` 还是 true，
 * 第二个弹窗的 Enter / y/n/a / Esc 全被静默吞掉，弹窗关不掉。
 * 用户感知为「acceptEdits 下弹窗按键无反应」：auto 模式下分类器放行了这两条命令，
 * 根本不会出现第二个弹窗；acceptEdits 对非 fs 的 bash 照常弹窗，于是撞上。
 *
 * 这里用 rerender 直接换 request（等价于合并后的那一帧），断言两个请求都能被 resolve。
 * harness 同 command-confirm-dialog-keys.test.tsx。
 */

import { test, expect, describe } from "bun:test";
import React from "react";
import { PassThrough } from "node:stream";
import { renderSync } from "@sid-code/cli/ui/render-port/testing.ts";
import { KeypressProvider, ESC_TIMEOUT } from "@sid-code/cli/ui/contexts/KeypressContext.tsx";
import { DialogRenderer } from "@sid-code/cli/ui/components/DialogManager.tsx";
import type { PermissionRequestInfo, ShellConfirmRequestInfo } from "@sid-code/cli/ui/App.tsx";

function mount(node: React.ReactElement) {
  const stdout = new PassThrough() as unknown as NodeJS.WriteStream & {
    columns: number;
    rows: number;
  };
  stdout.columns = 100;
  stdout.rows = 30;
  (stdout as unknown as { isTTY: boolean }).isTTY = false;
  stdout.on("data", () => {});
  const stdin = new PassThrough() as unknown as NodeJS.ReadStream;
  const stdinAny = stdin as unknown as Record<string, unknown>;
  stdinAny.isTTY = true;
  stdinAny.setRawMode = () => stdin;
  stdinAny.setEncoding = () => stdin;
  stdinAny.ref = () => stdin;
  stdinAny.unref = () => stdin;
  const wrap = (n: React.ReactElement) => <KeypressProvider>{n}</KeypressProvider>;
  const instance = renderSync(wrap(node), {
    stdout,
    stdin,
    patchConsole: false,
    exitOnCtrlC: false,
  });
  return {
    rerender: async (n: React.ReactElement) => {
      instance.rerender(wrap(n));
      await new Promise((r) => setTimeout(r, ESC_TIMEOUT * 2));
    },
    press: async (seq: string) => {
      stdin.emit("data", seq);
      await new Promise((r) => setTimeout(r, ESC_TIMEOUT * 2));
    },
    unmount: () => instance.unmount(),
  };
}

function permReq(command: string, answers: string[]): PermissionRequestInfo {
  return {
    toolName: "bash",
    toolInput: { command },
    description: command,
    resolve: (a) => answers.push(`${command}:${a}`),
  };
}

function renderPerm(req: PermissionRequestInfo) {
  return (
    <DialogRenderer permissionRequest={req} shellConfirmRequest={null} planApprovalRequest={null} />
  );
}

describe("连续同类确认请求", () => {
  for (const [name, seq, expected] of [
    ["Enter", "\r", "yes"],
    ["y", "y", "yes"],
    ["n", "n", "no"],
    ["Esc", "\x1b", "no"],
  ] as const) {
    test(`权限框：第二个请求按 ${name} 仍能 resolve`, async () => {
      const answers: string[] = [];
      const first = permReq("curl a", answers);
      const r = mount(renderPerm(first));
      await r.press("\r");
      expect(answers).toEqual(["curl a:yes"]);

      // 合并后的那一帧：同一位置直接换成下一个请求（中间的 null 被合并掉）
      await r.rerender(renderPerm(permReq("curl b", answers)));
      await r.press(seq);
      expect(answers).toEqual(["curl a:yes", `curl b:${expected}`]);
      r.unmount();
    });
  }

  test("权限框：第二个请求的光标回到初始位置，不沿用上一个", async () => {
    const answers: string[] = [];
    const r = mount(renderPerm(permReq("curl a", answers)));
    // 第一个请求把光标移到「拒绝」再确认
    await r.press("\x1b[B");
    await r.press("\r");
    expect(answers).toEqual(["curl a:no"]);
    await r.rerender(renderPerm(permReq("curl b", answers)));
    await r.press("\r");
    expect(answers).toEqual(["curl a:no", "curl b:yes"]);
    r.unmount();
  });

  test("Shell 确认框：第二个请求按 Enter 仍能 resolve", async () => {
    const answers: string[] = [];
    const shellReq = (cmd: string): ShellConfirmRequestInfo =>
      ({
        commands: [cmd],
        resolve: (ok: boolean) => answers.push(`${cmd}:${ok}`),
      }) as unknown as ShellConfirmRequestInfo;
    const renderShell = (req: ShellConfirmRequestInfo) => (
      <DialogRenderer
        permissionRequest={null}
        shellConfirmRequest={req}
        planApprovalRequest={null}
      />
    );
    const r = mount(renderShell(shellReq("echo a")));
    await r.press("\r");
    await r.rerender(renderShell(shellReq("echo b")));
    await r.press("\r");
    expect(answers).toEqual(["echo a:true", "echo b:true"]);
    r.unmount();
  });
});
