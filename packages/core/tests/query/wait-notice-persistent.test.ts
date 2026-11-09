/**
 * D9：唤醒撤销提示必须**常驻**（persistent），带 prompt 预览，同轮多条合成一行。
 *
 * 缺陷来源：docs-research/sid-code/bugfixes/todo/20261109-等待态四PR合入后review缺陷-修复与验收方案.md
 * §3.2 D9——撤销发生后提示只走 `system:transient` 状态条，同一轮 `done` 就把它清掉，
 * 用户回神时既看不到撤销、也不知道自己在等的唤醒已经没了。这正是 #642 否决自动撤销
 * 时最担心的「轮询静默中断、用户以为还在等」。
 *
 * 本文件从真实入口进：`makeGateHarness` 跑真实 `queryLoop`（只 mock 模型层），
 * 断言撤销提示这次 yield 出来的 `kind:"system"` 事件带 `persistent === true` ——
 * 只有这个字段会让 `app.ts` 走历史区（`appendPersistentHint`）而不是瞬态状态条。
 *
 * TUI 渲染实证（截图核对历史区那一行）按方案 §L5 归 E2E-7，不在本文件重复。
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { makeGateHarness } from "./gate-harness.ts";
import {
  __resetWaitRegistryForTest,
  invalidateWakeups,
  registerWait,
  setWakeupRegistrationEnabled,
} from "@sid-code/core/task/wait-registry.ts";
import { getScheduler, resetScheduler } from "@sid-code/core/cron/scheduler.ts";

let originalConfigDir: string | undefined;
let tmpHome = "";

beforeEach(() => {
  originalConfigDir = process.env.SID_CONFIG_DIR;
  tmpHome = mkdtempSync(join(tmpdir(), "sid-wait-notice-"));
  process.env.SID_CONFIG_DIR = tmpHome;
  __resetWaitRegistryForTest();
  setWakeupRegistrationEnabled(true);
  resetScheduler();
  getScheduler({ onFire: () => {}, isLoading: () => false, sessionId: "t", workspaceDir: "/tmp" });
});

afterEach(() => {
  __resetWaitRegistryForTest();
  resetScheduler();
  if (originalConfigDir === undefined) delete process.env.SID_CONFIG_DIR;
  else process.env.SID_CONFIG_DIR = originalConfigDir;
  rmSync(tmpHome, { recursive: true, force: true });
});

/** 登记一条会话级唤醒（等价于 schedule_wakeup 成功后的登记表状态） */
function addWakeup(id: string, prompt: string): void {
  const fireAt = Date.now() + 600_000;
  registerWait({
    id,
    kind: "wakeup",
    promise: { kind: "deadline", deadlineAt: fireAt },
    description: prompt,
    registeredAt: Date.now(),
    subjects: [],
  });
}

describe("D9：唤醒撤销提示常驻", () => {
  test("撤销提示以 persistent 事件发出，文案带 prompt 预览", async () => {
    addWakeup("wk-aaaa1111", "检查 PR #662 的 CI 是否绿了，绿了就合并");
    const victims = invalidateWakeups("todo_cleared", { reasonText: "任务清单已全部完成" });
    expect(victims).toEqual(["wk-aaaa1111"]);

    const { systemEvents } = await makeGateHarness({ todos: [] }).run();

    const notice = systemEvents.find((e) => e.text.includes("已取消定时唤醒"));
    expect(notice).toBeDefined();
    // 常驻：只有 persistent 会让 app.ts 写进历史区（而不是 system:transient 状态条）
    expect(notice!.persistent).toBe(true);
    expect(notice!.text).toContain("wk-aaaa1111");
    // prompt 预览：用户要能认出撤的是哪一条等待
    expect(notice!.text).toContain("检查 PR #662 的 CI");
    expect(notice!.text).toContain("任务清单已全部完成");
  });

  test("同一轮多条撤销合成**一行**，不刷屏", async () => {
    addWakeup("wk-bbbb2222", "检查 PR #662 的 CI");
    addWakeup("wk-cccc3333", "看 run 12345678 有没有过");
    expect(invalidateWakeups("todo_cleared", { reasonText: "任务清单已全部完成" })).toHaveLength(2);

    const { systemEvents } = await makeGateHarness({ todos: [] }).run();

    const notices = systemEvents.filter((e) => e.text.includes("已取消"));
    expect(notices).toHaveLength(1);
    expect(notices[0]!.persistent).toBe(true);
    expect(notices[0]!.text).toContain("已取消 2 条定时唤醒");
    expect(notices[0]!.text).toContain("wk-bbbb2222");
    expect(notices[0]!.text).toContain("wk-cccc3333");
  });

  test("没有撤销通知时不出 persistent 事件（防「无条件提示」）", async () => {
    const { systemEvents } = await makeGateHarness({ todos: [] }).run();
    expect(systemEvents.some((e) => e.text.includes("已取消"))).toBe(false);
  });
});
