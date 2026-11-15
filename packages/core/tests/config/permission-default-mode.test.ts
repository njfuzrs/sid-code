/**
 * PR-2：起始权限模式的来源与归一（M2 / M17 / M3 / M18 / M15）。
 *
 * 缺陷原文见 docs-research 仓
 * `sid-code/bugfixes/todo/20261112-权限模式对齐claude-code-缺陷修复与验收方案.md`。
 *
 * 全部用真实 `loadConfig({})`（不 mock 读取链），因为这一组缺陷的共同形态正是
 * 「字段读到了、但被某一层静默丢弃」——mock 掉读取链就把要验的那一段换掉了。
 * `SID_CONFIG_DIR` 与 cwd 都指向 tmpdir，且每个用例前 `resetSettingsCache()`：
 * settings 来源有进程内 L2 缓存，不清会让第二个用例读到第一个用例的文件。
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { execFileSync } from "child_process";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

import type { Config } from "@sid-code/core/config/config.ts";
import { loadConfig } from "@sid-code/core/config/config.ts";
import { getSidHome } from "@sid-code/core/config/paths.ts";
import { resetSettingsCache } from "@sid-code/core/config/settings/cache.ts";
import { applyLoadedPolicy, sanitizeRemotePolicy } from "@sid-code/core/config/policy.ts";
import {
  __resetModePolicy,
  downgradeBypassIfDisabledByPolicy,
  isBypassDisabledByPolicy,
  isModeDisabledByPolicy,
} from "@sid-code/core/permission/mode-policy.ts";

let tmpHome: string;
let ws: string;
let prevConfigDir: string | undefined;
let prevCwd: string;

beforeEach(() => {
  tmpHome = mkdtempSync(join(tmpdir(), "sid-mode-home-"));
  ws = mkdtempSync(join(tmpdir(), "sid-mode-ws-"));
  mkdirSync(join(ws, ".sid-code"), { recursive: true });
  prevConfigDir = process.env.SID_CONFIG_DIR;
  prevCwd = process.cwd();
  process.env.SID_CONFIG_DIR = tmpHome;
  process.chdir(ws);
  resetSettingsCache();
  __resetModePolicy();
});

afterEach(() => {
  process.chdir(prevCwd);
  resetSettingsCache();
  __resetModePolicy();
  // 存/恢复原值，不要无条件 delete：bun test 同批文件跑在同一进程，
  // 直接删会把 bunfig preload 的兜底一起抹掉（CONTRIBUTING「测试约定」第 1 条）。
  if (prevConfigDir === undefined) delete process.env.SID_CONFIG_DIR;
  else process.env.SID_CONFIG_DIR = prevConfigDir;
  rmSync(tmpHome, { recursive: true, force: true });
  rmSync(ws, { recursive: true, force: true });
});

function writeUser(settings: unknown): void {
  writeFileSync(join(getSidHome(), "settings.json"), JSON.stringify(settings));
}
function writeLocal(settings: unknown): void {
  writeFileSync(join(ws, ".sid-code", "settings.local.json"), JSON.stringify(settings));
}
function writeProject(settings: unknown): void {
  writeFileSync(join(ws, ".sid-code", "settings.json"), JSON.stringify(settings));
}
/** 把 local settings 提交进 git，模拟「被 git 追踪」（来源可信度降到项目级）。 */
function trackLocalSettings(): void {
  execFileSync("git", ["init", "-q"], { cwd: ws });
  execFileSync("git", ["add", "-f", ".sid-code/settings.local.json"], { cwd: ws });
}

function warningsOf(config: Config): string[] {
  return (config._validationDiagnostics?.warnings ?? []).map((w) => w.message);
}
function errorsOf(config: Config): string[] {
  return (config._validationDiagnostics?.errors ?? []).map((e) => e.message);
}
function diagnosticsOf(config: Config): string {
  return [...warningsOf(config), ...errorsOf(config)].join("\n");
}

/** 跑一次真实 loadConfig 并返回 permissionMode。 */
async function loadMode(cliArgs: Partial<Config> = {}): Promise<string> {
  const config = await loadConfig(cliArgs);
  return config.permissionMode;
}

describe("M2：用户级 permissions.defaultMode 终于被读取", () => {
  test("用例 1：用户级 defaultMode=acceptEdits → acceptEdits，无诊断", async () => {
    writeUser({ permissions: { defaultMode: "acceptEdits" } });
    const config = await loadConfig({});
    expect(config.permissionMode).toBe("acceptEdits");
    expect(warningsOf(config)).toEqual([]);
    expect(errorsOf(config)).toEqual([]);
  });

  test("用例 2：同文件 permissionMode=plan 与 defaultMode=acceptEdits → 后者优先 + warning", async () => {
    writeUser({ permissionMode: "plan", permissions: { defaultMode: "acceptEdits" } });
    const config = await loadConfig({});
    expect(config.permissionMode).toBe("acceptEdits");
    expect(diagnosticsOf(config)).toContain("permissionMode 已被忽略");
  });

  test("用例 3：用户级 defaultMode=bypassPermissions → always-allow + info 说明语义差异", async () => {
    writeUser({ permissions: { defaultMode: "bypassPermissions" } });
    const config = await loadConfig({});
    expect(config.permissionMode).toBe("always-allow");
    const text = diagnosticsOf(config);
    expect(text).toContain("always-allow");
    expect(text).toContain("--dangerously-skip-permissions");
  });

  test("用例 4：用户级 permissionMode=acceptedits（拼错）→ default，且不是 error", async () => {
    writeUser({ permissionMode: "acceptedits" });
    const config = await loadConfig({});
    expect(config.permissionMode).toBe("default");
    expect(diagnosticsOf(config)).toContain("已按");
    expect(errorsOf(config)).toEqual([]);
  });
});

describe("M17：项目级受限档位 / 未追踪 local 模式", () => {
  test("用例 5：项目级 defaultMode=plan → plan（只会更受限，允许）", async () => {
    writeProject({ permissions: { defaultMode: "plan" } });
    const config = await loadConfig({});
    expect(config.permissionMode).toBe("plan");
    expect(warningsOf(config)).toEqual([]);
  });

  test("用例 6：项目级 defaultMode=acceptEdits → default + warning 不生效", async () => {
    writeProject({ permissions: { defaultMode: "acceptEdits" } });
    const config = await loadConfig({});
    expect(config.permissionMode).toBe("default");
    const text = diagnosticsOf(config);
    expect(text).toContain("不生效");
    expect(text).toContain("只能由用户级设置或命令行指定");
  });

  test("用例 7：项目级 defaultMode=dangerously-skip-permissions → default + warning", async () => {
    writeProject({ permissions: { defaultMode: "dangerously-skip-permissions" } });
    const config = await loadConfig({});
    expect(config.permissionMode).toBe("default");
    expect(diagnosticsOf(config)).toContain("不生效");
  });

  test("用例 8：项目级 defaultMode=auto → default + warning", async () => {
    writeProject({ permissions: { defaultMode: "auto" } });
    const config = await loadConfig({});
    expect(config.permissionMode).toBe("default");
    expect(diagnosticsOf(config)).toContain("不生效");
  });

  test("用例 9：项目级 defaultMode=bypassPermissions（别名）→ 归一后仍被白名单拒绝", async () => {
    writeProject({ permissions: { defaultMode: "bypassPermissions" } });
    const config = await loadConfig({});
    expect(config.permissionMode).toBe("default");
    expect(diagnosticsOf(config)).toContain("不生效");
  });

  test("用例 10：未追踪 local defaultMode=always-allow → always-allow", async () => {
    writeLocal({ permissions: { defaultMode: "always-allow" } });
    const config = await loadConfig({});
    expect(config.permissionMode).toBe("always-allow");
    expect(warningsOf(config)).toEqual([]);
  });

  test("用例 11：未追踪 local defaultMode=dangerously-skip-permissions → default + warning", async () => {
    writeLocal({ permissions: { defaultMode: "dangerously-skip-permissions" } });
    const config = await loadConfig({});
    expect(config.permissionMode).toBe("default");
    expect(diagnosticsOf(config)).toContain("不生效");
  });

  test("用例 12：被 git 追踪的 local defaultMode=acceptEdits → default + warning", async () => {
    writeLocal({ permissions: { defaultMode: "acceptEdits" } });
    trackLocalSettings();
    const config = await loadConfig({});
    expect(config.permissionMode).toBe("default");
    expect(diagnosticsOf(config)).toContain("不生效");
  });
});

describe("优先级（高 → 低）", () => {
  test("用例 13：用户级 acceptEdits + 项目级 plan → plan（项目级更高）", async () => {
    writeUser({ permissions: { defaultMode: "acceptEdits" } });
    writeProject({ permissions: { defaultMode: "plan" } });
    expect(await loadMode()).toBe("plan");
  });

  test("用例 14：用户级 acceptEdits + CLI --permission-mode default → default（CLI 最高）", async () => {
    writeUser({ permissions: { defaultMode: "acceptEdits" } });
    const cli = { permissionMode: "default" } as Partial<Config>;
    expect(await loadMode(cli)).toBe("default");
  });
});

describe("M3/M18：CLI 与 settings 共用同一份归一", () => {
  test("CLI --permission-mode bypassPermissions → always-allow", async () => {
    const cli = { permissionMode: "bypassPermissions" } as Partial<Config>;
    expect(await loadMode(cli)).toBe("always-allow");
  });

  test("CLI --permission-mode acceptedits（拼错）→ default 且不报 error", async () => {
    const cli = { permissionMode: "acceptedits" } as Partial<Config>;
    const config = await loadConfig(cli);
    expect(config.permissionMode).toBe("default");
    expect(errorsOf(config)).toEqual([]);
  });

  test("manual 别名保持静默归一（不新增启动噪音）", async () => {
    writeUser({ permissionMode: "manual" });
    const config = await loadConfig({});
    expect(config.permissionMode).toBe("default");
    expect(diagnosticsOf(config)).not.toContain("manual");
  });
});

describe("M15：企业策略字段的两个位置", () => {
  test("P1：permissions.disableBypassPermissionsMode=disable → 禁用 bypass", () => {
    applyLoadedPolicy({
      source: "managed_file",
      permissions: { disableBypassPermissionsMode: "disable" },
    });
    expect(isBypassDisabledByPolicy()).toBe(true);
  });

  test("P2：顶层 disableBypassPermissionsMode=disable（旧写法，向后兼容）", () => {
    applyLoadedPolicy({ source: "managed_file", disableBypassPermissionsMode: "disable" });
    expect(isBypassDisabledByPolicy()).toBe(true);
  });

  test("P3：顶层 allow + permissions 下 disable → 取严，禁用", () => {
    applyLoadedPolicy({
      source: "managed_file",
      disableBypassPermissionsMode: "allow",
      permissions: { disableBypassPermissionsMode: "disable" },
    });
    expect(isBypassDisabledByPolicy()).toBe(true);
  });

  test("P4：permissions.disableAutoMode=disable → auto 被禁用", () => {
    applyLoadedPolicy({
      source: "managed_file",
      permissions: { disableAutoMode: "disable" },
    });
    expect(isModeDisabledByPolicy("auto")).toBe(true);
  });

  test("P5：远程策略的 permissions.disableAutoMode 不被 sanitize 丢掉", () => {
    const remote = sanitizeRemotePolicy({
      source: "remote",
      permissions: { disableAutoMode: "disable" },
    });
    expect(remote).not.toBeNull();
    applyLoadedPolicy(remote);
    expect(isModeDisabledByPolicy("auto")).toBe(true);
  });

  test("P6：策略禁 bypass + 用户级 defaultMode=bypassPermissions → 启动后降级为 default", async () => {
    writeUser({ permissions: { defaultMode: "bypassPermissions" } });
    applyLoadedPolicy({
      source: "managed_file",
      permissions: { disableBypassPermissionsMode: "disable" },
    });
    const config = await loadConfig({});
    // 归一先到 always-allow（M3），再由策略降级到 default（cli.ts 启动路径同一函数）。
    expect(config.permissionMode).toBe("always-allow");
    downgradeBypassIfDisabledByPolicy(config);
    expect(config.permissionMode).toBe("default");
  });

  test("disableBypassPermissionsMode=allow 不会误禁", () => {
    applyLoadedPolicy({
      source: "managed_file",
      permissions: { disableBypassPermissionsMode: "allow" },
    });
    expect(isBypassDisabledByPolicy()).toBe(false);
  });
});
