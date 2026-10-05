/**
 * SessionEnd 防重入（2026-10-06）
 *
 * 缺陷现场（会话 20261005-234012-b45f9ea6）：关终端 → SIGHUP 派发 SessionEnd(abort)，22ms 后
 * 卸载 TUI 写死终端 → EIO → uncaughtException → emergencySessionEnd 再派发 SessionEnd(error)，
 * 后者把 exit_status 从 abort 覆盖成 error。会话终态应以首次为准。
 *
 * fix_type: case_design
 */

import { describe, test, expect } from "bun:test";
import { HookSystem } from "@sid-code/core/hook/system.ts";
import { HookEventName } from "@sid-code/core/hook/types.ts";

function capture(hs: HookSystem): string[] {
  const reasons: string[] = [];
  hs.registerHook(
    {
      type: "runtime",
      name: "capture-session-end",
      action: async (input: any) => {
        reasons.push(input.reason);
      },
    } as any,
    HookEventName.SessionEnd,
    { source: "runtime" } as any,
  );
  return reasons;
}

describe("SessionEnd 只派发一次", () => {
  test("同一会话重复派发 → 只有首次生效（abort 不被 error 覆盖）", async () => {
    const hs = new HookSystem();
    hs.setSessionId("s1");
    const reasons = capture(hs);
    await hs.fireSessionEndEvent("abort");
    await hs.fireSessionEndEvent("error");
    expect(reasons).toEqual(["abort"]);
  });

  test("换新会话（/clear）后新会话仍能正常收尾", async () => {
    const hs = new HookSystem();
    hs.setSessionId("s1");
    const reasons = capture(hs);
    await hs.fireSessionEndEvent("exit");
    hs.setSessionId("s2");
    await hs.fireSessionEndEvent("exit");
    expect(reasons).toEqual(["exit", "exit"]);
  });
});
