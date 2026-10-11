/**
 * 迁移 v7：app.json 的 9 个行为键收回 settings.json。
 *
 * 风险不对称：把旧默认快照搬进 settings.json = 换个文件继续压着新默认（本次事故形态）；
 * 把用户显式设置当快照删掉 = 静默丢配置。两个方向都要有断言。
 *
 * 用 SID_CONFIG_DIR 隔离，不碰真实用户配置。
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { readFileSync, writeFileSync, mkdirSync, rmSync, existsSync } from "fs";
import { join } from "path";

const TEST_HOME = join("/tmp", `sid-code-v7-behavior-keys-${process.pid}`);
const SETTINGS_PATH = join(TEST_HOME, "settings.json");
const APP_PATH = join(TEST_HOME, "app.json");

const prevConfigDir = process.env.SID_CONFIG_DIR;

function writeJson(path: string, obj: unknown): void {
  mkdirSync(TEST_HOME, { recursive: true });
  writeFileSync(path, JSON.stringify(obj, null, 2));
}
const readJson = (p: string) => JSON.parse(readFileSync(p, "utf-8"));

async function runMigrate(): Promise<void> {
  const { resetSettingsCache } = await import("@sid-code/core/config/settings/index.ts");
  resetSettingsCache();
  const mod = await import("@sid-code/core/migrations/move-behavior-keys-out-of-app-json.ts");
  mod.migrate();
}

/** 2026-10-11 维护者本机 app.json 的真实内容（去掉 projects 细节） */
const REAL_WORLD_APP_JSON = {
  showLineNumbers: true,
  numStartups: 812,
  debug: true,
  debugLevel: "DEBUG",
  debugLogFile: "~/.sid-code/debug.log",
  telemetry: { enabled: true, exporters: [{ type: "jsonl" }] },
  checkpoint: {
    enabled: true,
    maxCheckpointsPerFile: 50,
    maxTotalSizeMb: 200,
    maxAgeDays: 30,
    compressThresholdKb: 1,
    largeFileThresholdLines: 1000,
    hugeFileThresholdLines: 10000,
  },
  sessionRetention: { enabled: true, maxAge: "30d", maxCount: 50, minRetention: "1d" },
  firstStartTime: "2026-06-03T00:00:00.000Z",
  lastPricingSyncVersion: "0.1.604",
  hints: { shellMode: 3 },
  projects: { "/repo": { allowedTools: [], hasTrustDialogAccepted: true } },
};

describe("迁移 v7：app.json 行为键收回 settings.json", () => {
  beforeEach(() => {
    process.env.SID_CONFIG_DIR = TEST_HOME;
    mkdirSync(TEST_HOME, { recursive: true });
  });

  afterEach(() => {
    if (prevConfigDir === undefined) delete process.env.SID_CONFIG_DIR;
    else process.env.SID_CONFIG_DIR = prevConfigDir;
    rmSync(TEST_HOME, { recursive: true, force: true });
  });

  test("真实形态：旧默认快照全部只删不搬，用户显式的 telemetry 搬过去，运行状态原样保留", async () => {
    writeJson(SETTINGS_PATH, { model: "m", openaiKey: "${OPENAI_API_KEY}" });
    writeJson(APP_PATH, REAL_WORLD_APP_JSON);

    await runMigrate();

    const app = readJson(APP_PATH);
    expect(Object.keys(app).sort()).toEqual(
      ["firstStartTime", "hints", "lastPricingSyncVersion", "numStartups", "projects"].sort(),
    );
    expect(app.numStartups).toBe(812);
    expect(app.projects["/repo"].hasTrustDialogAccepted).toBe(true);

    const settings = readJson(SETTINGS_PATH);
    // 事故本体：30d / maxCount 50 是 53047e30 之前的代码默认，不许搬进 settings 继续压新默认。
    expect(settings.sessionRetention).toBeUndefined();
    expect(settings.checkpoint).toBeUndefined();
    expect(settings.debugLogFile).toBeUndefined();
    expect(settings.showLineNumbers).toBeUndefined();
    // 当前默认就是 debug:true / DEBUG —— 快照，不搬。
    expect(settings.debug).toBeUndefined();
    expect(settings.debugLevel).toBeUndefined();
    // telemetry 当前默认是关闭，这里 enabled:true 是用户显式打开过的，必须保留。
    expect(settings.telemetry).toEqual({ enabled: true, exporters: [{ type: "jsonl" }] });
    // 不经 Zod round-trip：占位符原样存活。
    expect(settings.openaiKey).toBe("${OPENAI_API_KEY}");
  });

  test("老默认 debug:false / INFO 只删不搬（否则会把用户锁死在旧默认上）", async () => {
    writeJson(APP_PATH, { numStartups: 1, debug: false, debugLevel: "INFO" });
    await runMigrate();
    expect(existsSync(SETTINGS_PATH)).toBe(false);
    expect(readJson(APP_PATH)).toEqual({ numStartups: 1 });
  });

  test("用户改过的值（与任何一版默认都不同）搬进 settings.json", async () => {
    writeJson(APP_PATH, {
      numStartups: 1,
      sessionRetention: { maxAge: "90d" },
      checkpoint: { enabled: false },
      theme: "dark",
    });
    await runMigrate();
    const settings = readJson(SETTINGS_PATH);
    expect(settings.sessionRetention).toEqual({ maxAge: "90d" });
    expect(settings.checkpoint).toEqual({ enabled: false });
    expect(settings.theme).toBe("dark");
    expect(readJson(APP_PATH)).toEqual({ numStartups: 1 });
  });

  test("两边都有时保留 settings.json 的值，只从 app.json 删", async () => {
    writeJson(SETTINGS_PATH, { sessionRetention: { maxAge: "730d" } });
    writeJson(APP_PATH, { numStartups: 1, sessionRetention: { maxAge: "7d" } });
    await runMigrate();
    expect(readJson(SETTINGS_PATH).sessionRetention).toEqual({ maxAge: "730d" });
    expect(readJson(APP_PATH).sessionRetention).toBeUndefined();
  });

  test("快照判定与对象键顺序无关", async () => {
    writeJson(APP_PATH, {
      numStartups: 1,
      sessionRetention: { minRetention: "1d", maxCount: 50, maxAge: "30d", enabled: true },
    });
    await runMigrate();
    expect(existsSync(SETTINGS_PATH)).toBe(false);
  });

  test("变异自证：快照多改一个字段就不算快照（部分匹配说明有人改过）", async () => {
    writeJson(APP_PATH, {
      numStartups: 1,
      sessionRetention: { enabled: true, maxAge: "30d", maxCount: 100, minRetention: "1d" },
    });
    await runMigrate();
    expect(readJson(SETTINGS_PATH).sessionRetention.maxCount).toBe(100);
  });

  test("幂等：再跑一次不改任何文件", async () => {
    writeJson(APP_PATH, REAL_WORLD_APP_JSON);
    await runMigrate();
    const s1 = readFileSync(SETTINGS_PATH, "utf-8");
    const a1 = readFileSync(APP_PATH, "utf-8");
    await runMigrate();
    expect(readFileSync(SETTINGS_PATH, "utf-8")).toBe(s1);
    expect(readFileSync(APP_PATH, "utf-8")).toBe(a1);
  });

  test("settings.json 损坏时抛错且不动 app.json（绝不覆盖坏文件、绝不丢设置）", async () => {
    mkdirSync(TEST_HOME, { recursive: true });
    writeFileSync(SETTINGS_PATH, "{ broken");
    writeJson(APP_PATH, { numStartups: 1, theme: "dark" });
    const before = readFileSync(APP_PATH, "utf-8");
    let threw = false;
    try {
      await runMigrate();
    } catch {
      threw = true;
    }
    expect(threw).toBe(true);
    expect(readFileSync(APP_PATH, "utf-8")).toBe(before);
    expect(readFileSync(SETTINGS_PATH, "utf-8")).toBe("{ broken");
  });

  test("v4 不越权处理这 9 个键（否则旧快照会被 v4 当成用户设置搬走）", async () => {
    writeJson(APP_PATH, REAL_WORLD_APP_JSON);
    const v4 = await import("@sid-code/core/migrations/move-stray-app-config-keys.ts");
    v4.migrate();
    expect(existsSync(SETTINGS_PATH)).toBe(false);
    expect(readJson(APP_PATH).sessionRetention).toBeDefined();
  });
});
