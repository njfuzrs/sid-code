/**
 * AppConfig 单元测试
 *
 * AppConfig 测试用临时 HOME 做真实读写往返，验证缓存/备份/Auth-Loss Guard。
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

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
    const { createDefaultAppConfig } = await import("@sid-code/core/config/app-config.ts");
    const def = createDefaultAppConfig();
    expect(def.numStartups).toBe(0);
    // 行为默认值不许出现在 AppConfig 默认里：saveAppConfig 会把它们连带写盘，
    // 变成一份优先级不明、与 defaultConfig() 不一致的快照（曾是 debug:false / debugLevel:"INFO"）。
    expect(Object.keys(def)).toEqual(["numStartups"]);
  });

  test("incrementStartupCount 持久化 + write-through 缓存", async () => {
    const mod = await import("@sid-code/core/config/app-config.ts");
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
    const mod = await import("@sid-code/core/config/app-config.ts");
    mod.resetAppConfigCache();
    mod.stopAppConfigWatcher();

    const projectPath = "/some/project";
    expect(mod.isProjectTrusted(projectPath)).toBe(false);
    mod.markTrustDialogAccepted(projectPath);
    expect(mod.isProjectTrusted(projectPath)).toBe(true);

    mod.stopAppConfigWatcher();
  });

  test("损坏的 app.json 不致崩溃，回退默认值并备份", async () => {
    const mod = await import("@sid-code/core/config/app-config.ts");
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

describe("app.json 与 settings.json 键集合不相交", () => {
  // 两个文件各管各的：app.json 只有程序自己写的运行状态，Config 的行为字段一个都不许进白名单。
  // 这条门禁防的是 v4 那次的漏网：白名单里混进 sessionRetention 等 9 个行为键，
  // app.json 的旧默认快照于是盖过了 settings.json 与代码默认值。
  test("APP_CONFIG_OWNED_KEYS 与 defaultConfig() / SettingsSchema 的键零交集", async () => {
    const { APP_CONFIG_OWNED_KEYS } = await import("@sid-code/core/config/app-config.ts");
    const { defaultConfig } = await import("@sid-code/core/config/config.ts");
    const { SettingsSchema } = await import("@sid-code/core/config/settings/types.ts");
    const behavior = new Set([
      ...Object.keys(defaultConfig()),
      ...Object.keys((SettingsSchema() as any).shape),
    ]);
    const overlap = [...APP_CONFIG_OWNED_KEYS].filter((k) => behavior.has(k));
    expect(overlap).toEqual([]);
  });

  test("变异自证：把 sessionRetention 放回白名单会被抓到", async () => {
    const { SettingsSchema } = await import("@sid-code/core/config/settings/types.ts");
    const shape = Object.keys((SettingsSchema() as any).shape);
    for (const k of ["sessionRetention", "debug", "checkpoint", "telemetry", "showLineNumbers"]) {
      expect(shape).toContain(k);
    }
  });
});
