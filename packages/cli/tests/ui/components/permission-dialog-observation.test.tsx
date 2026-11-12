/**
 * 权限框的按键观测（B21）：`keys` / `keysDropped` / `mounts` 必须真实反映
 * 「按键到了组件」与「被 resolvedRef 去重吞掉」这两件事。
 *
 * 为什么需要这层测试：`decision-telemetry` 的单例语义已在
 * `packages/core/tests/permission/prompt-observation.test.ts` 锁住，但那只能证明
 * 「记了能读出来」，证明不了「组件真的会去记」。这次补观测的直接动因就是排查
 * 「第二个弹窗点不动」时数据全无——如果埋点自己没接上，下次照样是黑箱。
 *
 * 变异自证：去掉 `HotkeyChoiceList` 的 `onKeyObserved?.()` → keys 归零；去掉
 * `decide` 里的 `notePromptKeyDropped()` → keysDropped 归零。两者都会让本文件变红。
 */

import { test, expect, describe } from "bun:test";
import React from "react";
import { PassThrough } from "node:stream";
import { renderSync } from "@sid-code/cli/ui/render-port/testing.ts";
import { KeypressProvider, ESC_TIMEOUT } from "@sid-code/cli/ui/contexts/KeypressContext.tsx";
import { DialogRenderer } from "@sid-code/cli/ui/components/DialogManager.tsx";
import {
  beginPromptObservation,
  consumePromptObservation,
} from "@sid-code/core/permission/decision-telemetry.ts";
import type { PermissionRequestInfo } from "@sid-code/cli/ui/App.tsx";

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
    press: async (seq: string) => {
      stdin.emit("data", seq);
      await new Promise((r) => setTimeout(r, ESC_TIMEOUT * 2));
    },
    unmount: () => instance.unmount(),
  };
}

function permReq(answers: string[]): PermissionRequestInfo {
  return {
    toolName: "bash",
    toolInput: { command: "curl a" },
    description: "curl a",
    resolve: (a) => answers.push(a),
  };
}

function renderPerm(req: PermissionRequestInfo) {
  return (
    <DialogRenderer permissionRequest={req} shellConfirmRequest={null} planApprovalRequest={null} />
  );
}

describe("权限框按键观测（B21）", () => {
  test("按键到达组件即计数；正常 resolve 时 keysDropped 为 0", async () => {
    consumePromptObservation(); // 清掉上个用例的残留
    const answers: string[] = [];
    beginPromptObservation(Date.now());
    const r = mount(renderPerm(permReq(answers)));
    await r.press("\x1b[B"); // ↓ 移到「拒绝」
    await r.press("\r"); // Enter
    expect(answers).toEqual(["no"]);

    const obs = consumePromptObservation();
    expect(obs).not.toBeNull();
    expect(obs!.keys).toBeGreaterThanOrEqual(2);
    expect(obs!.keysDropped).toBe(0);
    // 挂载发生在首帧，观测里应有 mounts（判读「弹窗真的显示了」的信号）
    expect(obs!.mounts).toBeGreaterThanOrEqual(1);
    r.unmount();
  });

  test("resolve 之后再按键被 resolvedRef 吞掉 → keysDropped 增加（#756 的精确信号）", async () => {
    consumePromptObservation();
    const answers: string[] = [];
    beginPromptObservation(Date.now());
    const r = mount(renderPerm(permReq(answers)));
    await r.press("\r");
    expect(answers).toEqual(["yes"]);
    // 第二个 Enter / a 都落在「已 resolved」的实例上——这正是旧实例复用时的表现
    await r.press("\r");
    await r.press("a");
    expect(answers).toEqual(["yes"]); // 仍然只 resolve 一次

    const obs = consumePromptObservation();
    expect(obs!.keysDropped).toBeGreaterThanOrEqual(1);
    r.unmount();
  });
});
