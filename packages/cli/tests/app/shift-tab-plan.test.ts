/**
 * M6：Shift+Tab 能进/出 plan（对齐 claude-code）。
 *
 * ## 这条测试守的是什么
 *
 * `permission/mode.ts` 的纯函数只能证明「键盘循环的落点含 plan」，证明不了
 * **落到 plan 之后状态机真的进了规划态**。后者才是这次改动的风险点：
 * 只改 `config.permissionMode` 会造出一个「假 plan 态」——权限层是只读的，
 * 但模型收不到 plan 约束、没有计划文件、`exit_plan_mode` 走错分支。
 *
 * 所以这里的断言停在 `PlanModeManager` 的真实状态上（`isPlanning()` / `getPrePlanMode()`），
 * 而不是「config.permissionMode 变成了 plan」——后者在 bug 版本里同样成立。
 *
 * 覆盖四条：
 * 1. default 按一次 → acceptEdits（键盘循环本身）；
 * 2. 再按 → plan，且 `isPlanning() === true`、`getPrePlanMode() === "acceptEdits"`、
 *    `getEntrySource() === "keyboard"`（证明走的是状态机、记了可恢复的原模式）；
 * 3. planning 态按 → 放弃规划，落在循环里 plan 的下一档（auto），`isActive() === false`；
 * 4. awaiting_approval 态按 → 不响应（审批框才是决策现场，改模式等于偷走审批）。
 *
 * 落盘目标经 `SID_CONFIG_DIR` 重定向到 tmpdir：`planManager.enter()` 会
 * `reservePlanFile()` 往 plans 目录写占位文件，不隔离就会污染真实 `~/.sid-code/`。
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { App } from "@sid-code/cli/app.ts";
import { UnifiedCommandRegistry } from "@sid-code/cli/command/unified-registry.ts";
import { defaultConfig } from "@sid-code/core/config/config.ts";
import type { Config } from "@sid-code/core/config/config.ts";
import { PlanModeManager } from "@sid-code/core/plan/state.ts";
import { setModePolicy } from "@sid-code/core/permission/mode-policy.ts";

let dir: string;
const saved = { config: process.env.SID_CONFIG_DIR };

beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), "sid-shift-tab-")));
  process.env.SID_CONFIG_DIR = join(dir, "cfg");
  // 同批多文件共享进程：别的测试可能设过企业策略，显式清回「什么都不禁」。
  setModePolicy([], "allow");
});

afterEach(() => {
  if (saved.config === undefined) delete process.env.SID_CONFIG_DIR;
  else process.env.SID_CONFIG_DIR = saved.config;
  setModePolicy([], "allow");
  rmSync(dir, { recursive: true, force: true });
});

function makeApp(mode = "default") {
  const config = {
    ...defaultConfig(),
    model: "mock-model",
    provider: "mock",
    availableModels: [],
    permissionMode: mode,
  } as unknown as Config;
  const planManager = new PlanModeManager();
  const app = new App({
    unifiedRegistry: new UnifiedCommandRegistry(),
    config,
    provider: {} as never,
    mcpManager: {} as never,
    planManager,
  });
  return { app, config, planManager };
}

/** 被测方法是 private：这里要验的正是它的内部行为，绕不过去 */
type AppInternals = {
  cyclePermissionMode: () => Promise<void>;
  buildPlanModeReminderIfActive: () => Promise<string | null>;
};

async function pressShiftTab(app: App): Promise<void> {
  await (app as unknown as AppInternals).cyclePermissionMode();
}

describe("Shift+Tab 进出 plan（M6）", () => {
  test("default 按一次 → acceptEdits", async () => {
    const { app, config } = makeApp("default");
    await pressShiftTab(app);
    expect(config.permissionMode).toBe("acceptEdits");
  });

  test("acceptEdits 再按 → plan，状态机真的进了规划态", async () => {
    const { app, config, planManager } = makeApp("default");
    await pressShiftTab(app); // → acceptEdits
    await pressShiftTab(app); // → plan

    expect(config.permissionMode).toBe("plan");
    // 这三条是「没有假 plan 态」的判据：缺任何一条都说明只改了字符串
    expect(planManager.isPlanning()).toBe(true);
    expect(planManager.getPrePlanMode()).toBe("acceptEdits");
    expect(planManager.getEntrySource()).toBe("keyboard");
    // 键盘进入后要能写出计划文件（reservePlanFile 在 enter 里完成）
    expect(planManager.getPlanFilePath()).toBeTruthy();
  });

  test("键盘进入 plan 后，plan reminder 会注入（模型侧感知）", async () => {
    const { app } = makeApp("default");
    await pressShiftTab(app); // → acceptEdits
    await pressShiftTab(app); // → plan
    const reminder = await (app as unknown as AppInternals).buildPlanModeReminderIfActive();
    expect(reminder).toBeTruthy();
  });

  test("planning 态按 → 放弃规划并落到 auto", async () => {
    const { app, config, planManager } = makeApp("default");
    await pressShiftTab(app); // → acceptEdits
    await pressShiftTab(app); // → plan
    await pressShiftTab(app); // → 放弃规划，落到 plan 的下一档

    expect(planManager.isActive()).toBe(false);
    // bypass 不可用（未开 --dangerously-skip-permissions）时 plan → auto
    expect(config.permissionMode).toBe("auto");
  });

  test("awaiting_approval 态按 → 模式不变、申请仍在等审批", async () => {
    const { app, config, planManager } = makeApp("default");
    await pressShiftTab(app); // → acceptEdits
    await pressShiftTab(app); // → plan
    planManager.submitForApproval();
    expect(planManager.isAwaitingApproval()).toBe(true);

    await pressShiftTab(app);

    expect(config.permissionMode).toBe("plan");
    expect(planManager.isAwaitingApproval()).toBe(true);
  });
});
