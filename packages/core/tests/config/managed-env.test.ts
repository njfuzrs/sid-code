/**
 * 环境变量两阶段应用单元测试
 *
 * 验证：
 * - Phase 1 仅应用可信来源全部 env + 项目级安全白名单变量
 * - Phase 2 应用合并后的全部 env
 * - 受保护变量永不被覆盖
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

import { isProtectedEnvVar } from "@sid-code/core/config/settings/managed-env.ts";
import { resetSettingsCache } from "@sid-code/core/config/settings/cache.ts";

describe("受保护环境变量", () => {
  test("代码注入向量受保护", () => {
    for (const k of [
      "PATH",
      "HOME",
      "LD_PRELOAD",
      "DYLD_INSERT_LIBRARIES",
      "NODE_OPTIONS",
      "NODE_PATH",
    ]) {
      expect(isProtectedEnvVar(k)).toBe(true);
    }
  });

  test("普通变量不受保护", () => {
    expect(isProtectedEnvVar("MY_CUSTOM_VAR")).toBe(false);
    expect(isProtectedEnvVar("EDITOR")).toBe(false);
  });
});

describe("两阶段环境变量应用", () => {
  let tmpHome: string;
  let workspace: string;
  let prevConfigDir: string | undefined;
  const touchedKeys = ["SID_TEST_SAFE", "SID_TEST_UNSAFE", "EDITOR", "LD_PRELOAD"];
  const savedEnv: Record<string, string | undefined> = {};

  beforeEach(() => {
    tmpHome = mkdtempSync(join(tmpdir(), "sid-env-home-"));
    workspace = mkdtempSync(join(tmpdir(), "sid-env-ws-"));
    prevConfigDir = process.env.SID_CONFIG_DIR;
    process.env.SID_CONFIG_DIR = tmpHome;
    for (const k of touchedKeys) {
      savedEnv[k] = process.env[k];
      delete process.env[k];
    }
    resetSettingsCache();
  });

  afterEach(() => {
    if (prevConfigDir === undefined) delete process.env.SID_CONFIG_DIR;
    else process.env.SID_CONFIG_DIR = prevConfigDir;
    for (const k of touchedKeys) {
      if (savedEnv[k] === undefined) delete process.env[k];
      else process.env[k] = savedEnv[k];
    }
    rmSync(tmpHome, { recursive: true, force: true });
    rmSync(workspace, { recursive: true, force: true });
    resetSettingsCache();
  });

  function writeUserSettings(env: Record<string, string>) {
    // SID_CONFIG_DIR 即配置根目录，settings.json 直接写在其下
    writeFileSync(join(tmpHome, "settings.json"), JSON.stringify({ env }), "utf-8");
  }

  function writeProjectSettings(env: Record<string, string>) {
    const dir = join(workspace, ".sid-code");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "settings.json"), JSON.stringify({ env }), "utf-8");
  }

  test("Phase 1：可信来源(user) env 全部应用", async () => {
    resetSettingsCache();
    writeUserSettings({ SID_TEST_UNSAFE: "from-user", EDITOR: "vim" });

    const { applySafeConfigEnvironmentVariables } =
      await import("@sid-code/core/config/settings/managed-env.ts");
    applySafeConfigEnvironmentVariables(workspace);

    // user 是可信来源 → 即使非白名单变量也应用
    expect(process.env.SID_TEST_UNSAFE).toBe("from-user");
    expect(process.env.EDITOR).toBe("vim");
  });

  test("Phase 1：项目级仅安全白名单变量应用，非白名单被拦截", async () => {
    resetSettingsCache();
    writeProjectSettings({
      EDITOR: "code", // 白名单 → 应用
      SID_TEST_UNSAFE: "evil", // 非白名单 → 拦截
    });

    const { applySafeConfigEnvironmentVariables } =
      await import("@sid-code/core/config/settings/managed-env.ts");
    applySafeConfigEnvironmentVariables(workspace);

    expect(process.env.EDITOR).toBe("code");
    expect(process.env.SID_TEST_UNSAFE).toBeUndefined();
  });

  test("Phase 2：项目级全部 env 应用", async () => {
    resetSettingsCache();
    writeProjectSettings({ SID_TEST_UNSAFE: "now-applied" });

    const { applyAllConfigEnvironmentVariables } =
      await import("@sid-code/core/config/settings/managed-env.ts");
    applyAllConfigEnvironmentVariables(workspace);

    expect(process.env.SID_TEST_UNSAFE).toBe("now-applied");
  });

  test("受保护变量永不被覆盖（即使来自可信来源）", async () => {
    resetSettingsCache();
    const before = process.env.LD_PRELOAD;
    writeUserSettings({ LD_PRELOAD: "/evil/lib.so" });

    const { applyAllConfigEnvironmentVariables } =
      await import("@sid-code/core/config/settings/managed-env.ts");
    applyAllConfigEnvironmentVariables(workspace);

    expect(process.env.LD_PRELOAD).toBe(before as any);
  });
});
