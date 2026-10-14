/**
 * 回归：settings.json 的 analytics.privacy_level 必须在 loadConfig 返回时就生效。
 *
 * 启动路径上最早的出网点（app.ts 构造期的外部模型目录同步）只问 privacy-level.ts，
 * 早于 initTraceCollector / initTelemetrySystem。此前隐私级别只在那两个 init 里注入，
 * v0.1.609 发布产物实测：settings 写 essential-traffic 时更新检查被拦、目录同步照样出网；
 * 换成环境变量则两者都被拦。
 */

import { describe, test, expect, afterEach, afterAll } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadConfig } from "@sid-code/core/config/config.ts";
import { resetSettingsCache } from "@sid-code/core/config/settings/index.ts";
import {
  getPrivacyLevel,
  setConfiguredPrivacyLevel,
  shouldLoadRemoteConfig,
} from "@sid-code/core/analytics/privacy-level.ts";

/** 在隔离的 SID_CONFIG_DIR 下用给定 settings.json 跑一次 loadConfig */
async function loadWith(settings: Record<string, unknown>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "sid-privacy-inject-"));
  const saved = process.env.SID_CONFIG_DIR;
  try {
    writeFileSync(join(dir, "settings.json"), JSON.stringify(settings));
    process.env.SID_CONFIG_DIR = dir;
    resetSettingsCache();
    await loadConfig({ provider: "ollama", model: "llama3" });
  } finally {
    if (saved === undefined) delete process.env.SID_CONFIG_DIR;
    else process.env.SID_CONFIG_DIR = saved;
    resetSettingsCache();
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("loadConfig 提前注入隐私级别", () => {
  const savedNonEssential = process.env.SID_CODE_DISABLE_NONESSENTIAL_TRAFFIC;
  const savedTelemetry = process.env.SID_CODE_DISABLE_TELEMETRY;
  delete process.env.SID_CODE_DISABLE_NONESSENTIAL_TRAFFIC;
  delete process.env.SID_CODE_DISABLE_TELEMETRY;

  afterEach(() => {
    setConfiguredPrivacyLevel(null);
  });

  test("settings 写 essential-traffic，loadConfig 返回后远程拉取即被拒", async () => {
    setConfiguredPrivacyLevel(null);
    expect(shouldLoadRemoteConfig()).toBe(true);

    await loadWith({ analytics: { privacy_level: "essential-traffic" } });

    expect(getPrivacyLevel()).toBe("essential-traffic");
    expect(shouldLoadRemoteConfig()).toBe(false);
  });

  test("camelCase 写法同样生效", async () => {
    await loadWith({ analytics: { privacyLevel: "no-telemetry" } });
    expect(getPrivacyLevel()).toBe("no-telemetry");
  });

  test("没配隐私级别时不改动已有状态", async () => {
    setConfiguredPrivacyLevel(null);
    await loadWith({});
    expect(getPrivacyLevel()).toBe("default");
  });

  // 恢复进程级环境变量，避免影响同进程其它测试文件
  afterAll(() => {
    if (savedNonEssential !== undefined)
      process.env.SID_CODE_DISABLE_NONESSENTIAL_TRAFFIC = savedNonEssential;
    if (savedTelemetry !== undefined) process.env.SID_CODE_DISABLE_TELEMETRY = savedTelemetry;
  });
});
