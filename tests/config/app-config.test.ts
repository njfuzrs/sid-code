/**
 * 配置迁移 + AppConfig 单元测试
 *
 * 迁移测试聚焦字段分类（纯逻辑，无 IO）。
 * AppConfig 测试用临时 HOME 做真实读写往返，验证缓存/备份/Auth-Loss Guard。
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import {
  mkdtempSync,
  rmSync,
  writeFileSync,
  existsSync,
  readFileSync,
} from "fs";
import { join } from "path";
import { tmpdir } from "os";

import { _internal } from "../../src/config/migration.ts";

describe("配置迁移：字段分类", () => {
  const { SETTINGS_FIELDS, APP_CONFIG_FIELDS, KEY_MAP } = _internal;

  test("行为配置字段归属 Settings", () => {
    for (const f of [
      "provider",
      "model",
      "anthropicKey",
      "permissionMode",
      "mcpServers",
      "hooks",
      "env",
      "quota",
    ]) {
      expect(SETTINGS_FIELDS.has(f)).toBe(true);
    }
  });

  test("内部状态字段归属 AppConfig", () => {
    for (const f of [
      "debug",
      "debugLevel",
      "showLineNumbers",
      "checkpoint",
      "trace",
      "telemetry",
      "sessionRetention",
    ]) {
      expect(APP_CONFIG_FIELDS.has(f)).toBe(true);
    }
  });

  test("Settings 与 AppConfig 字段集合无交集", () => {
    for (const f of SETTINGS_FIELDS) {
      expect(APP_CONFIG_FIELDS.has(f)).toBe(false);
    }
  });

  test("snake_case → camelCase 映射正确", () => {
    expect(KEY_MAP["anthropic_key"]).toBe("anthropicKey");
    expect(KEY_MAP["base_url"]).toBe("baseURL");
    expect(KEY_MAP["max_tokens"]).toBe("maxTokens");
    expect(KEY_MAP["mcp_servers"]).toBe("mcpServers");
    expect(KEY_MAP["debug_level"]).toBe("debugLevel");
  });

  test("会话字段不在任何迁移集合（不迁移 CLI 参数）", () => {
    for (const f of ["sessionId", "continue", "resume", "print", "maxTurns"]) {
      expect(SETTINGS_FIELDS.has(f)).toBe(false);
      expect(APP_CONFIG_FIELDS.has(f)).toBe(false);
    }
  });
});

/**
 * AppConfig 真实读写测试。
 * 通过 SID_CONFIG_DIR 环境变量将配置目录指向临时目录，
 * 实现确定性的文件 IO 测试（不污染真实 ~/.sid-code）。
 */
describe("AppConfig 读写往返", () => {
  let tmpHome: string;
  let prevConfigDir: string | undefined;

  beforeEach(() => {
    tmpHome = mkdtempSync(join(tmpdir(), "sid-appconfig-"));
    prevConfigDir = process.env.SID_CONFIG_DIR;
    process.env.SID_CONFIG_DIR = tmpHome;
  });

  afterEach(() => {
    if (prevConfigDir === undefined) delete process.env.SID_CONFIG_DIR;
    else process.env.SID_CONFIG_DIR = prevConfigDir;
    rmSync(tmpHome, { recursive: true, force: true });
  });

  test("默认值合理", async () => {
    const { createDefaultAppConfig } = await import(
      "../../src/config/app-config.ts"
    );
    const def = createDefaultAppConfig();
    expect(def.showLineNumbers).toBe(true);
    expect(def.numStartups).toBe(0);
    expect(def.debug).toBe(false);
  });

  test("incrementStartupCount 持久化 + write-through 缓存", async () => {
    const mod = await import("../../src/config/app-config.ts");
    mod.resetAppConfigCache();
    mod.stopAppConfigWatcher();

    mod.incrementStartupCount();
    const cfg = mod.getAppConfig();
    expect(cfg.numStartups).toBe(1);
    expect(cfg.firstStartTime).toBeTruthy();

    // 落盘
    const path = join(tmpHome, "app.json");
    expect(existsSync(path)).toBe(true);
    const onDisk = JSON.parse(readFileSync(path, "utf-8"));
    expect(onDisk.numStartups).toBe(1);

    mod.incrementStartupCount();
    expect(mod.getAppConfig().numStartups).toBe(2);
    // firstStartTime 不变
    expect(mod.getAppConfig().firstStartTime).toBe(cfg.firstStartTime);

    mod.stopAppConfigWatcher();
  });

  test("项目信任状态读写", async () => {
    const mod = await import("../../src/config/app-config.ts");
    mod.resetAppConfigCache();
    mod.stopAppConfigWatcher();

    const projectPath = "/some/project";
    expect(mod.isProjectTrusted(projectPath)).toBe(false);
    mod.markTrustDialogAccepted(projectPath);
    expect(mod.isProjectTrusted(projectPath)).toBe(true);

    mod.stopAppConfigWatcher();
  });

  test("损坏的 app.json 不致崩溃，回退默认值并备份", async () => {
    const mod = await import("../../src/config/app-config.ts");
    mod.resetAppConfigCache();
    mod.stopAppConfigWatcher();

    writeFileSync(join(tmpHome, "app.json"), "{ not valid json ", "utf-8");

    const cfg = mod.getAppConfig();
    expect(cfg.numStartups).toBe(0); // 默认值
    // 备份目录应生成损坏文件副本
    const backupDir = join(tmpHome, "backups");
    expect(existsSync(backupDir)).toBe(true);

    mod.stopAppConfigWatcher();
  });
});
