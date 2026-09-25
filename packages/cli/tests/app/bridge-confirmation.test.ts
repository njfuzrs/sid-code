/**
 * PR-6.2：Bridge 权限代理必须走 App.requestUserConfirmation。
 *
 * 只测 PermissionProxy 会全绿，而生产确认根本不进它——requestConfirmation 零调用，
 * Bridge 不进 TUI，ask 工具落到 permissionMode === "always-allow" 的布尔。
 * 所以这组用例构造 App，经 tool-executor 用的同一个回调问一次。
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { App } from "@sid-code/cli/app.ts";
import { defaultConfig } from "@sid-code/core/config/config.ts";
import type { Config } from "@sid-code/core/config/config.ts";
import { PermissionChecker } from "@sid-code/core/permission/checker.ts";

let dir: string;
let prevConfigDir: string | undefined;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "sid-bridge-confirm-"));
  prevConfigDir = process.env.SID_CONFIG_DIR;
  process.env.SID_CONFIG_DIR = dir;
});

afterEach(() => {
  if (prevConfigDir === undefined) delete process.env.SID_CONFIG_DIR;
  else process.env.SID_CONFIG_DIR = prevConfigDir;
  rmSync(dir, { recursive: true, force: true });
});

function makeApp(mode: string, checker: PermissionChecker): App {
  const config = {
    ...defaultConfig(),
    model: "mock-model",
    provider: "mock",
    availableModels: [],
    permissionMode: mode,
  } as unknown as Config;
  return new App({
    config,
    provider: {} as never,
    mcpManager: {} as never,
    permissionChecker: checker,
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

describe("App.requestUserConfirmation · Bridge delegate", () => {
  test("已注入 delegate：被调用，返回值决定 confirmed", async () => {
    const config = { ...defaultConfig(), permissionMode: "default" } as Config;
    const checker = new PermissionChecker(config, undefined, dir);
    const seen: Array<{ toolName: string; description: string }> = [];
    checker.setBridgePermissionDelegate(async (req) => {
      seen.push({ toolName: req.toolName, description: req.description });
      return true;
    });
    const app = makeApp("default", checker);
    expect(await ask(app)).toBe(true);
    expect(seen).toEqual([{ toolName: "bash", description: "执行命令" }]);
  });

  test("delegate 返回 false → confirmed=false，不看 permissionMode", async () => {
    const config = { ...defaultConfig(), permissionMode: "always-allow" } as Config;
    const checker = new PermissionChecker(config, undefined, dir);
    checker.setBridgePermissionDelegate(async () => false);
    const app = makeApp("always-allow", checker);
    expect(await ask(app)).toBe(false);
  });

  test("无 delegate、无 TUI、default mode → 立刻 false", async () => {
    const config = { ...defaultConfig(), permissionMode: "default" } as Config;
    const checker = new PermissionChecker(config, undefined, dir);
    const app = makeApp("default", checker);
    expect(await ask(app)).toBe(false);
  });

  test("无 delegate、always-allow → 仍放行（回归）", async () => {
    const config = { ...defaultConfig(), permissionMode: "always-allow" } as Config;
    const checker = new PermissionChecker(config, undefined, dir);
    const app = makeApp("always-allow", checker);
    expect(await ask(app)).toBe(true);
  });

  test("没有 checker 时不抛，回到 permissionMode", async () => {
    const config = {
      ...defaultConfig(),
      model: "mock-model",
      provider: "mock",
      availableModels: [],
      permissionMode: "default",
    } as unknown as Config;
    const app = new App({ config, provider: {} as never, mcpManager: {} as never });
    expect(await ask(app)).toBe(false);
  });
});
