/**
 * FIX-3 / D4：`<waiting-capability>` 走真实入口的企业策略门禁。
 *
 * 生产链路：`app.ts` 用 `toolRegistry.enabled()` 当 `buildSystemPrompt` 的 tools，
 * `settings.monitor.enabled=false` 时 `MonitorTool.isEnabled()` 为 false，monitor 不进
 * enabled()，引导段随之消失——否则提示词会把模型指向一个调不到的工具。
 * 这里用真实 `MonitorTool` + 真实 `Registry` + 真实 settings 文件，不手搓 tools 数组。
 *
 * 落盘隔离：只读 settings，但按 CONTRIBUTING 仍把 `SID_CONFIG_DIR` 指向 tmpdir（存/恢复原值）。
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { MonitorTool } from "../../src/tool/monitor.ts";
import { Registry } from "../../src/tool/registry.ts";
import { buildSystemPrompt, clearPromptCache } from "../../src/config/system-prompt.ts";
import { resetSettingsCache } from "../../src/config/settings/cache.ts";
import { managedSettingsSystemDir } from "../../src/config/paths.ts";

// 系统级 managed-settings.json 会盖掉 SID_CONFIG_DIR 下那份；存在时跳过而不是假绿
const systemPolicyExists = existsSync(join(managedSettingsSystemDir(), "managed-settings.json"));

let originalConfigDir: string | undefined;
let tmpHome = "";

function promptFromRegistry(): string {
  const registry = new Registry();
  registry.register(new MonitorTool());
  clearPromptCache();
  return buildSystemPrompt({ tools: registry.enabled() as never });
}

describe.skipIf(systemPolicyExists)("<waiting-capability> 跟随 settings.monitor.enabled", () => {
  beforeEach(() => {
    originalConfigDir = process.env.SID_CONFIG_DIR;
    tmpHome = mkdtempSync(join(tmpdir(), "sid-waiting-cap-"));
    process.env.SID_CONFIG_DIR = tmpHome;
    resetSettingsCache();
  });

  afterEach(() => {
    if (originalConfigDir === undefined) delete process.env.SID_CONFIG_DIR;
    else process.env.SID_CONFIG_DIR = originalConfigDir;
    resetSettingsCache();
    rmSync(tmpHome, { recursive: true, force: true });
  });

  test("缺省（未关闭）：真实 MonitorTool 注册后段落出现，且带激活说明（它是延迟工具）", () => {
    const prompt = promptFromRegistry();
    expect(prompt).toContain("<waiting-capability>");
    expect(prompt).toContain("select:monitor");
  });

  test("企业策略关闭 monitor：段落不出现", () => {
    writeFileSync(
      join(tmpHome, "managed-settings.json"),
      JSON.stringify({ monitor: { enabled: false } }),
    );
    resetSettingsCache();
    expect(promptFromRegistry()).not.toContain("<waiting-capability>");
  });

  test("用户级关闭同样生效（任一来源 false 即关）", () => {
    writeFileSync(join(tmpHome, "settings.json"), JSON.stringify({ monitor: { enabled: false } }));
    resetSettingsCache();
    expect(promptFromRegistry()).not.toContain("<waiting-capability>");
  });
});
