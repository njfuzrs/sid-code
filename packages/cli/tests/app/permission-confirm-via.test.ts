/**
 * T4：`PermissionDecision.confirm_via` —— 人工确认是本地点的还是远程点的
 *
 * 改造前 bridge 代理 / SDK 宿主 / TUI 弹窗 / headless 自动决策在轨迹里长得一模一样
 * （`source=user` + `prompted=true`），触发清单 A11/A12 的「分不出规则来自本地还是远程」
 * 就是这一类。这个字段只进本地轨迹，不扩外发遥测的 `PermissionSource` 闭集。
 *
 * 断言走真实门面 `logPermissionAllow` → `recordPermissionDecision`：
 * 只测 App 里的 setter 会全绿，而门面漏读时字段照样永远不出现。
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { App } from "@sid-code/cli/app.ts";
import { UnifiedCommandRegistry } from "@sid-code/cli/command/unified-registry.ts";
import { defaultConfig } from "@sid-code/core/config/config.ts";
import type { Config } from "@sid-code/core/config/config.ts";
import { PermissionChecker } from "@sid-code/core/permission/checker.ts";
import {
  setConfirmVia,
  setPermissionDecisionObserver,
  type PermissionDecisionEvent,
} from "@sid-code/core/permission/decision-telemetry.ts";
import { logPermissionAllow } from "@sid-code/core/analytics/events.ts";

let dir: string;
let prevConfigDir: string | undefined;
let captured: PermissionDecisionEvent[] = [];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "sid-confirm-via-"));
  prevConfigDir = process.env.SID_CONFIG_DIR;
  process.env.SID_CONFIG_DIR = dir;
  captured = [];
  setPermissionDecisionObserver((e) => captured.push(e));
  setConfirmVia(null);
});

afterEach(() => {
  setPermissionDecisionObserver(null);
  setConfirmVia(null);
  if (prevConfigDir === undefined) delete process.env.SID_CONFIG_DIR;
  else process.env.SID_CONFIG_DIR = prevConfigDir;
  rmSync(dir, { recursive: true, force: true });
});

function makeApp(mode: string, checker?: PermissionChecker): App {
  const config = {
    ...defaultConfig(),
    model: "mock-model",
    provider: "mock",
    availableModels: [],
    permissionMode: mode,
  } as unknown as Config;
  return new App({
    unifiedRegistry: new UnifiedCommandRegistry(),
    config,
    provider: {} as never,
    mcpManager: {} as never,
    ...(checker ? { permissionChecker: checker } : {}),
  });
}

function ask(app: App, toolName = "bash"): Promise<boolean> {
  const fn = (
    app as unknown as {
      requestUserConfirmation: (
        description: string,
        req?: { toolName: string; input: unknown },
        toolName?: string,
        toolInput?: unknown,
      ) => Promise<boolean>;
    }
  ).requestUserConfirmation.bind(app);
  return fn("执行命令", { toolName, input: { command: "ls" } }, toolName, { command: "ls" });
}

/** 走真实门面记一条「问过人」的 allow，并取回落到 observer 的事件 */
function recordPromptedAllow(): PermissionDecisionEvent {
  captured = [];
  logPermissionAllow("bash", { source: "user", needsPrompt: true, context: "main" });
  expect(captured).toHaveLength(1);
  return captured[0]!;
}

describe("PermissionDecision.confirm_via", () => {
  test("注入 bridge 代理 → confirm_via=bridge", async () => {
    const checker = new PermissionChecker(
      { ...defaultConfig(), permissionMode: "default" } as Config,
      undefined,
      dir,
    );
    checker.setBridgePermissionDelegate(async () => true);
    const app = makeApp("default", checker);

    expect(await ask(app)).toBe(true);
    expect(recordPromptedAllow().confirmVia).toBe("bridge");
  });

  test("走 TUI 回调 → confirm_via=tui（与桥接分开）", async () => {
    const checker = new PermissionChecker(
      { ...defaultConfig(), permissionMode: "default" } as Config,
      undefined,
      dir,
    );
    const app = makeApp("default", checker);
    app.setTUIConfirmCallback(async () => "yes");

    expect(await ask(app)).toBe(true);
    expect(recordPromptedAllow().confirmVia).toBe("tui");
  });

  test("无回调、always-allow 自动答 → confirm_via=headless", async () => {
    const checker = new PermissionChecker(
      { ...defaultConfig(), permissionMode: "always-allow" } as Config,
      undefined,
      dir,
    );
    const app = makeApp("always-allow", checker);

    expect(await ask(app)).toBe(true);
    expect(recordPromptedAllow().confirmVia).toBe("headless");
  });

  test("prompted=false（规则直接放行）不带该字段", async () => {
    // 先把通道设成一个值，验证门面是按 prompted 判的、不是读到什么就写什么
    setConfirmVia("bridge");
    captured = [];
    logPermissionAllow("read", { source: "rule", needsPrompt: false, context: "main" });
    expect(captured).toHaveLength(1);
    expect(captured[0]!.prompted).toBe(false);
    expect("confirmVia" in captured[0]!).toBe(false);
  });

  test("SDK 宿主通道 → confirm_via=sdk", async () => {
    const checker = new PermissionChecker(
      { ...defaultConfig(), permissionMode: "default" } as Config,
      undefined,
      dir,
    );
    const app = makeApp("default", checker);
    // sdkCanUseTool 平时由 runSDK 内部赋值；测试替换该字段，走的是 App 里真实的
    // requestUserConfirmation sdk 分支（不是手工调 setter）。
    (app as unknown as { sdkCanUseTool: () => Promise<string> }).sdkCanUseTool = async () =>
      "allow";

    expect(await ask(app)).toBe(true);
    expect(recordPromptedAllow().confirmVia).toBe("sdk");
  });

  test("classifier 抢赢（source≠user）不带该字段——那次并没有人真的被问", async () => {
    // needsPrompt=true 只说明「进过确认流程」；三路竞争里 classifier 抢先赢了时，
    // 弹窗并没有人作答。若门面只看 needsPrompt，就会把上一次远程批准的通道写进来。
    setConfirmVia("bridge");
    captured = [];
    logPermissionAllow("bash", { source: "classifier", needsPrompt: true, context: "main" });
    expect(captured).toHaveLength(1);
    expect(captured[0]!.prompted).toBe(true);
    expect("confirmVia" in captured[0]!).toBe(false);
  });

  test("一次确认只消费一次：连续两条 user 决策，第二条不带 confirmVia", () => {
    setConfirmVia("tui");
    captured = [];
    logPermissionAllow("bash", { source: "user", needsPrompt: true, context: "main" });
    logPermissionAllow("read", { source: "user", needsPrompt: true, context: "main" });
    expect(captured).toHaveLength(2);
    expect(captured[0]!.confirmVia).toBe("tui");
    // 第二条没有经过 requestUserConfirmation（例如并发的第二次决策），
    // 不能继承上一条的通道——否则「通道」会变成「上次是谁批的」。
    expect("confirmVia" in captured[1]!).toBe(false);
  });
});
