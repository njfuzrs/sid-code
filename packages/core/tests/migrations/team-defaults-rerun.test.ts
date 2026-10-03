/**
 * B35：团队默认补全可重跑 + 迁移失败不推进水位线
 *
 * 三条主判据（都做过变异自证，见 Agent Note）：
 * 1. 老用户水位线已到顶 + 模板新增 foo ⇒ 补 foo
 * 2. 用户删掉过的 bar 不被补回
 * 3. v1 抛错 ⇒ 水位线不越过 1，且有一条可见的启动告警
 *
 * 用 SID_CONFIG_DIR 隔离，不碰真实用户配置。
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { readFileSync, writeFileSync, mkdirSync, rmSync } from "fs";
import { join } from "path";
import teamDefaults from "../../../../scripts/team-defaults.template.json" with { type: "json" };

const TEST_HOME = join("/tmp", `sid-code-b35-${process.pid}-${Date.now()}`);
const SETTINGS_PATH = join(TEST_HOME, "settings.json");
const STATE_DIR = join(TEST_HOME, "state");
const STATE_PATH = join(STATE_DIR, "migrations.json");
const prevConfigDir = process.env.SID_CONFIG_DIR;

const readJson = (p: string) => JSON.parse(readFileSync(p, "utf-8"));
const writeJson = (p: string, v: unknown) => writeFileSync(p, JSON.stringify(v, null, 2));

beforeEach(async () => {
  process.env.SID_CONFIG_DIR = TEST_HOME;
  mkdirSync(STATE_DIR, { recursive: true });
  const { resetMigrationWarnings } = await import("@sid-code/core/migrations/warnings.ts");
  resetMigrationWarnings();
});

afterEach(() => {
  // 恢复原值而非无条件 delete（见 tests/preload-isolate-sid-home.ts）
  if (prevConfigDir === undefined) delete process.env.SID_CONFIG_DIR;
  else process.env.SID_CONFIG_DIR = prevConfigDir;
  rmSync(TEST_HOME, { recursive: true, force: true });
});

describe("backfillNewTemplateKeys（独立水位）", () => {
  test("模板新增 foo ⇒ 只补 foo；用户删掉过的 bar 不被补回", async () => {
    const { migrate, backfillNewTemplateKeys } =
      await import("@sid-code/core/migrations/backfill-team-defaults.ts");
    writeJson(SETTINGS_PATH, { model: "m" });

    // 首次升级：v1 全量补 bar，并记下键集合 {model, bar}
    migrate({ model: "x", bar: 1 });
    expect(readJson(SETTINGS_PATH).bar).toBe(1);

    // 用户删掉 bar = 表态
    writeJson(SETTINGS_PATH, { model: "m" });

    // 发新版：模板加 foo
    const added = backfillNewTemplateKeys({ model: "x", bar: 1, foo: { on: true } });
    expect(added).toEqual(["foo"]);
    const after = readJson(SETTINGS_PATH);
    expect(after.foo).toEqual({ on: true });
    expect(after.bar).toBeUndefined();
    expect(after.model).toBe("m");
    expect(readJson(STATE_PATH).teamDefaults.keys).toEqual(["model", "bar", "foo"]);
  });

  test("模板没变 ⇒ 不碰 settings.json", async () => {
    const { migrate, backfillNewTemplateKeys } =
      await import("@sid-code/core/migrations/backfill-team-defaults.ts");
    writeJson(SETTINGS_PATH, { model: "m" });
    migrate({ model: "x" });
    const before = readFileSync(SETTINGS_PATH, "utf-8");
    expect(backfillNewTemplateKeys({ model: "x" })).toEqual([]);
    expect(readFileSync(SETTINGS_PATH, "utf-8")).toBe(before);
  });

  test("模板新增的键用户已有 ⇒ 不覆盖", async () => {
    const { migrate, backfillNewTemplateKeys } =
      await import("@sid-code/core/migrations/backfill-team-defaults.ts");
    writeJson(SETTINGS_PATH, { model: "m", foo: [] });
    migrate({ model: "x" });
    expect(backfillNewTemplateKeys({ model: "x", foo: ["a"] })).toEqual([]);
    expect(readJson(SETTINGS_PATH).foo).toEqual([]);
  });

  test("无记录的老用户（B35 前已跑过 v1）⇒ 只记基线、不补任何键", async () => {
    const { backfillNewTemplateKeys } =
      await import("@sid-code/core/migrations/backfill-team-defaults.ts");
    writeJson(SETTINGS_PATH, { model: "m" });
    writeJson(STATE_PATH, { migrationVersion: 5 });

    expect(backfillNewTemplateKeys({ model: "x", bar: 1 })).toEqual([]);
    expect(readJson(SETTINGS_PATH)).toEqual({ model: "m" });
    const state = readJson(STATE_PATH);
    expect(state.migrationVersion).toBe(5); // 不动全局水位
    expect(state.teamDefaults.keys).toEqual(["model", "bar"]);

    // 基线之后再加的键能补上
    expect(backfillNewTemplateKeys({ model: "x", bar: 1, foo: 2 })).toEqual(["foo"]);
  });

  test("settings.json 损坏 ⇒ 抛错且不更新水位，修好后下次补上", async () => {
    const { migrate, backfillNewTemplateKeys } =
      await import("@sid-code/core/migrations/backfill-team-defaults.ts");
    writeJson(SETTINGS_PATH, { model: "m" });
    migrate({ model: "x" });
    const markBefore = readJson(STATE_PATH).teamDefaults;

    writeFileSync(SETTINGS_PATH, "{ broken");
    expect(() => backfillNewTemplateKeys({ model: "x", foo: 1 })).toThrow(/解析失败/);
    expect(readJson(STATE_PATH).teamDefaults).toEqual(markBefore);

    writeJson(SETTINGS_PATH, { model: "m" });
    expect(backfillNewTemplateKeys({ model: "x", foo: 1 })).toEqual(["foo"]);
  });
});

describe("runMigrations（端到端，用真实模板）", () => {
  test("老用户水位线已到顶 ⇒ 仍跑增量补全：模板相对记录新增的键被补上", async () => {
    const { runMigrations, getTotalMigrations } =
      await import("@sid-code/core/migrations/runner.ts");
    const template = teamDefaults as Record<string, unknown>;
    const allKeys = Object.keys(template);
    // 模拟「上次记录时模板还没有 search」，且用户没有 search
    const recorded = allKeys.filter((k) => k !== "search");
    const user: Record<string, unknown> = {};
    for (const k of recorded) user[k] = template[k];
    delete user.trace; // 用户删过 trace（记录里有）⇒ 不该补回
    writeJson(SETTINGS_PATH, user);
    writeJson(STATE_PATH, {
      migrationVersion: getTotalMigrations(),
      teamDefaults: { hash: "stale", keys: recorded },
    });

    runMigrations();

    const after = readJson(SETTINGS_PATH);
    expect(after.search).toEqual(template.search);
    expect(after.trace).toBeUndefined();
    expect(readJson(STATE_PATH).migrationVersion).toBe(getTotalMigrations());
  });

  test("v1 抛错 ⇒ 水位线停在 0（不越过 1），且有一条可见启动告警；修好后 v1 重跑", async () => {
    const { runMigrations, getTotalMigrations } =
      await import("@sid-code/core/migrations/runner.ts");
    const { getMigrationWarnings } = await import("@sid-code/core/migrations/warnings.ts");
    writeFileSync(SETTINGS_PATH, "{ broken");
    writeJson(STATE_PATH, { migrationVersion: 0 });

    runMigrations();

    expect(readJson(STATE_PATH).migrationVersion ?? 0).toBe(0);
    const warns = getMigrationWarnings();
    expect(warns.some((w) => w.message.includes("backfill-team-defaults (v1) 失败"))).toBe(true);

    // 修好文件 ⇒ 下次启动 v1 重跑并补全，水位推到顶
    writeJson(SETTINGS_PATH, { model: "m" });
    runMigrations();
    const after = readJson(SETTINGS_PATH);
    expect(after.subAgentModels).toBeDefined();
    expect(readJson(STATE_PATH).migrationVersion).toBe(getTotalMigrations());
  });

  test("失败告警经 loadConfig 进启动诊断（横幅 / --print 的共同数据源）", async () => {
    const { recordMigrationWarning } = await import("@sid-code/core/migrations/warnings.ts");
    recordMigrationWarning("migrations", "迁移 x (v9) 失败，测试用");
    writeJson(SETTINGS_PATH, {});
    const { loadConfig } = await import("@sid-code/core/config/config.ts");
    const config = await loadConfig({} as never);
    const warns = config._validationDiagnostics?.warnings ?? [];
    expect(warns.some((w) => w.path === "migrations" && w.message.includes("v9"))).toBe(true);
  });
});
