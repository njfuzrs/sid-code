/**
 * 删除已废弃的窗口学习文件（迁移 v8）测试
 *
 * 风险不对称：漏删只是留一个孤儿文件（下次启动还会重跑，因为水位线只在成功时推进），
 * 错删会把用户自己的数据静默抹掉。所以反向用例（保留）比正向用例多。
 *
 * 用 SID_CONFIG_DIR 隔离，不碰真实用户配置。
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const TEST_HOME = join("/tmp", `sid-code-rm-learned-ceiling-test-${process.pid}`);
const FILE_PATH = join(TEST_HOME, "learned-input-ceiling.json");

const prevConfigDir = process.env.SID_CONFIG_DIR;

/** S6 真实写出的形态（本机 2026-11-09 那份，一字不差） */
const REAL_S6 = {
  schema_version: 1,
  entries: {
    "origin-deepseek-v4-1-flash@https://uniapi.ruijie.com.cn/v1": {
      overflows: 2,
      maxAdmitted: 664057,
      firstOverflowAt: 1793848610893,
      ceiling: 664057,
      learnedAt: 1794158271911,
    },
  },
};

function writeFile(obj: unknown): void {
  mkdirSync(TEST_HOME, { recursive: true });
  writeFileSync(FILE_PATH, typeof obj === "string" ? obj : JSON.stringify(obj, null, 2));
}

function readRaw(): string {
  return readFileSync(FILE_PATH, "utf-8");
}

async function runMigrate(): Promise<void> {
  const mod = await import("@sid-code/core/migrations/remove-learned-input-ceiling.ts");
  mod.migrate();
}

describe("迁移 v8：删除已废弃的窗口学习文件", () => {
  beforeEach(() => {
    process.env.SID_CONFIG_DIR = TEST_HOME;
    mkdirSync(TEST_HOME, { recursive: true });
  });

  afterEach(() => {
    // 存/恢复原值：无条件 delete 会把 preload 的兜底一起抹掉（见 CONTRIBUTING「测试约定」）
    if (prevConfigDir === undefined) delete process.env.SID_CONFIG_DIR;
    else process.env.SID_CONFIG_DIR = prevConfigDir;
    rmSync(TEST_HOME, { recursive: true, force: true });
  });

  test("S6 真实产物 → 删除", async () => {
    writeFile(REAL_S6);
    await runMigrate();
    expect(existsSync(FILE_PATH)).toBe(false);
  });

  test("多条 entries 且都合法 → 删除", async () => {
    writeFile({
      schema_version: 1,
      entries: {
        "model-a@https://gw-a/v1": { overflows: 2, maxAdmitted: 664057, ceiling: 664057 },
        "model-b@https://gw-b/v1": { overflows: 3, maxAdmitted: 300000, ceiling: 300000 },
      },
    });
    await runMigrate();
    expect(existsSync(FILE_PATH)).toBe(false);
  });

  test("文件不存在 → 不抛，无副作用", async () => {
    expect(existsSync(FILE_PATH)).toBe(false);
    await expect(runMigrate()).resolves.toBeUndefined();
    expect(existsSync(FILE_PATH)).toBe(false);
  });

  test("幂等：连续两次执行不抛", async () => {
    writeFile(REAL_S6);
    await runMigrate();
    await expect(runMigrate()).resolves.toBeUndefined();
    expect(existsSync(FILE_PATH)).toBe(false);
  });

  // ── 反向用例：任一条件不符就保留 ──

  test("缺少 schema_version → 保留", async () => {
    writeFile({ entries: REAL_S6.entries });
    const before = readRaw();
    await runMigrate();
    expect(existsSync(FILE_PATH)).toBe(true);
    expect(readRaw()).toBe(before);
  });

  test("schema_version 是别的版本 → 保留（不认识的格式不动）", async () => {
    writeFile({ schema_version: 2, entries: REAL_S6.entries });
    await runMigrate();
    expect(existsSync(FILE_PATH)).toBe(true);
  });

  test("entries 为空对象 → 保留（S6 的写入路径不会产出空对象）", async () => {
    writeFile({ schema_version: 1, entries: {} });
    await runMigrate();
    expect(existsSync(FILE_PATH)).toBe(true);
  });

  test("某条 entry 缺 ceiling → 整体保留（宁可漏删不可错删）", async () => {
    writeFile({
      schema_version: 1,
      entries: {
        "ok@https://gw/v1": { overflows: 2, maxAdmitted: 664057, ceiling: 664057 },
        "bad@https://gw/v1": { overflows: 2, maxAdmitted: 664057 },
      },
    });
    await runMigrate();
    expect(existsSync(FILE_PATH)).toBe(true);
  });

  test("entry 的值是字符串而不是数字 → 保留", async () => {
    writeFile({
      schema_version: 1,
      entries: { "x@https://gw/v1": { overflows: 2, maxAdmitted: "664057", ceiling: 664057 } },
    });
    await runMigrate();
    expect(existsSync(FILE_PATH)).toBe(true);
  });

  test("entries 是数组而不是对象 → 保留", async () => {
    writeFile({ schema_version: 1, entries: [Object.values(REAL_S6.entries)[0]] });
    await runMigrate();
    expect(existsSync(FILE_PATH)).toBe(true);
  });

  test("JSON 损坏 → 保留原文件且不抛", async () => {
    writeFile("{ this is not json");
    await expect(runMigrate()).resolves.toBeUndefined();
    expect(existsSync(FILE_PATH)).toBe(true);
    expect(readRaw()).toBe("{ this is not json");
  });

  test("顶层是数组 → 保留", async () => {
    writeFile([REAL_S6]);
    await runMigrate();
    expect(existsSync(FILE_PATH)).toBe(true);
  });
});

describe("isLegacyLearnedCeiling 判据（纯函数分支）", () => {
  test("真实 S6 形态为真", async () => {
    const { isLegacyLearnedCeiling } =
      await import("@sid-code/core/migrations/remove-learned-input-ceiling.ts");
    expect(isLegacyLearnedCeiling(REAL_S6)).toBe(true);
  });

  test("null / 字符串 / 数字 / 布尔 均为假", async () => {
    const { isLegacyLearnedCeiling } =
      await import("@sid-code/core/migrations/remove-learned-input-ceiling.ts");
    for (const v of [null, undefined, "x", 1, true]) {
      expect(isLegacyLearnedCeiling(v)).toBe(false);
    }
  });

  test("NaN / Infinity 不算数字", async () => {
    const { isLegacyLearnedCeiling } =
      await import("@sid-code/core/migrations/remove-learned-input-ceiling.ts");
    expect(
      isLegacyLearnedCeiling({
        schema_version: 1,
        entries: { a: { overflows: 1, maxAdmitted: 1, ceiling: Number.NaN } },
      }),
    ).toBe(false);
    expect(
      isLegacyLearnedCeiling({
        schema_version: 1,
        entries: { a: { overflows: 1, maxAdmitted: 1, ceiling: Number.POSITIVE_INFINITY } },
      }),
    ).toBe(false);
  });
});
