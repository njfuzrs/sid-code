/**
 * 迁移框架失败姿态门禁测试（建议2）
 *
 * 背景：runner.ts 文件头设计原则第 3 条写「失败不阻塞——迁移失败记录警告，
 * 不阻止启动」。但 P1-4 发现 setStoredMigrationVersion 的 mkdirSync/writeFileSync
 * 是裸调用，不在 try 内——写盘失败会逃逸到 cli.ts 最外层 catch → process.exit(1)，
 * 整个启动崩溃。设计原则没兑现。
 *
 * 本测试注入 fs 失败（指向只读目录），断言 runMigrations 不抛、不 exit。
 * 覆盖 setStoredMigrationVersion 内部自兜（P1-4 修复后的 try/catch）。
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, rmSync, chmodSync, writeFileSync, readFileSync } from "fs";
import { join } from "path";

const TEST_HOME = join("/tmp", `sid-code-migration-fs-fail-${process.pid}-${Date.now()}`);
const STATE_DIR = join(TEST_HOME, "state");
const SETTINGS_PATH = join(TEST_HOME, "settings.json");
const MIGRATION_STATE_PATH = join(STATE_DIR, "migrations.json");
/** 进程原有的 SID_CONFIG_DIR（可能是 preload 设的隔离兜底），afterEach 要还回去 */
const prevConfigDir = process.env.SID_CONFIG_DIR;

describe("runMigrations 失败不阻塞（建议2 门禁）", () => {
  beforeEach(() => {
    process.env.SID_CONFIG_DIR = TEST_HOME;
    mkdirSync(TEST_HOME, { recursive: true });
    mkdirSync(STATE_DIR, { recursive: true });
    // 写最小 settings.json 让迁移 v1 (backfill-team-defaults) 能跑
    writeFileSync(SETTINGS_PATH, JSON.stringify({ model: "test" }, null, 2));
    // 写版本号=0 的 migration state，让 runMigrations 觉得需要执行迁移
    writeFileSync(MIGRATION_STATE_PATH, JSON.stringify({ migrationVersion: 0 }, null, 2));
  });

  afterEach(() => {
    // 只读目录先恢复权限再删
    try { chmodSync(STATE_DIR, 0o755); } catch { /* ignore */ }
    try { chmodSync(TEST_HOME, 0o755); } catch { /* ignore */ }
    try { rmSync(TEST_HOME, { recursive: true, force: true }); } catch { /* ignore */ }
    // 恢复原值而非无条件 delete（见 tests/preload-isolate-sid-home.ts）：
    // 同进程后续测试文件会依赖 preload 设的隔离兜底，删了就写进真实 HOME。
    if (prevConfigDir === undefined) delete process.env.SID_CONFIG_DIR;
    else process.env.SID_CONFIG_DIR = prevConfigDir;
  });

  test("state 目录只读时 runMigrations 不抛、不 exit(1)", async () => {
    // 把 state 目录改为只读（0o500 = r-x，不可写）
    // migrate() 写的是 SETTINGS_PATH（在 TEST_HOME 下，不在 STATE_DIR），
    // 但 setStoredMigrationVersion 写的是 STATE_DIR/migrations.json → 会失败
    chmodSync(STATE_DIR, 0o500);

    // 动态 import 确保拿到改后的代码
    const { runMigrations } = await import("../../src/migrations/runner.ts");

    // runMigrations 应内部自兜（setStoredMigrationVersion 包了 try/catch），
    // 不抛异常、不 exit(1)
    expect(() => runMigrations()).not.toThrow();
  });

  test("正常路径迁移后版本号正确写入", async () => {
    // 对照组：不注入 fs 失败，验证迁移正常完成
    const { runMigrations, getTotalMigrations } = await import("../../src/migrations/runner.ts");
    runMigrations();

    // 版本号应已更新为 CURRENT_VERSION。
    // 从 getTotalMigrations() 取而非硬编码字面量：这个断言的意图是「水位线推到了最新」，
    // 不是「恰好有 N 个迁移」。写死数字的话，每加一个迁移这个无关的测试就会红一次
    // （实测加 v3 时就红了），而红的原因与它要守的性质毫无关系。
    const state = JSON.parse(readFileSync(MIGRATION_STATE_PATH, "utf-8"));
    expect(state.migrationVersion).toBe(getTotalMigrations());
  });
});
