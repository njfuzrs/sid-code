/**
 * 命令使用频率追踪测试（Task 5）
 *
 * 注意：本测试会写 ~/.sid-code/command-usage.json。
 * 通过注入时间戳保证衰减计算确定性，并在每个用例前重置内存缓存。
 */

import { describe, test, expect, beforeEach, beforeAll, afterAll } from "bun:test";
import { existsSync, rmSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  getUsageScore,
  recordUsage,
  _resetUsageCache,
} from "../../src/command/usage-tracking.ts";

const DAY_MS = 1000 * 60 * 60 * 24;

let tmpDir: string;

beforeAll(() => {
  // 重定向使用记录文件到临时目录，避免污染真实 ~/.sid-code/
  tmpDir = mkdtempSync(join(tmpdir(), "sid-usage-"));
  process.env.SID_CODE_USAGE_FILE = join(tmpDir, "command-usage.json");
});

afterAll(() => {
  delete process.env.SID_CODE_USAGE_FILE;
  if (tmpDir && existsSync(tmpDir)) rmSync(tmpDir, { recursive: true, force: true });
});

describe("usage-tracking", () => {
  beforeEach(() => {
    _resetUsageCache();
    // 每个用例前清掉持久化文件，保证计数从 0 开始
    const file = process.env.SID_CODE_USAGE_FILE!;
    if (existsSync(file)) rmSync(file, { force: true });
    _resetUsageCache();
  });

  test("未记录的命令分数为 0", () => {
    // 用一个几乎不可能被记录的命令名
    expect(getUsageScore("__never_used_cmd_xyz__")).toBe(0);
  });

  test("记录后分数为正", () => {
    const now = 1_700_000_000_000;
    const name = "__test_cmd_record__";
    recordUsage(name, now);
    expect(getUsageScore(name, now)).toBeGreaterThan(0);
  });

  test("多次记录累加使用次数", () => {
    const now = 1_700_000_000_000;
    const name = "__test_cmd_multi__";
    _resetUsageCache();
    recordUsage(name, now);
    recordUsage(name, now);
    recordUsage(name, now);
    // 同一时刻记录 3 次，分数 ≈ 3（recency factor = 1）
    expect(getUsageScore(name, now)).toBeCloseTo(3, 1);
  });

  test("7 天半衰期：一周后分数减半", () => {
    const now = 1_700_000_000_000;
    const name = "__test_cmd_decay__";
    _resetUsageCache();
    recordUsage(name, now);
    const weekLater = now + 7 * DAY_MS;
    const score = getUsageScore(name, weekLater);
    // 1 次使用，7 天后 ≈ 0.5
    expect(score).toBeCloseTo(0.5, 1);
  });

  test("最低衰减因子 0.1：很久以前的使用仍保留 10%", () => {
    const now = 1_700_000_000_000;
    const name = "__test_cmd_floor__";
    _resetUsageCache();
    recordUsage(name, now);
    const yearLater = now + 365 * DAY_MS;
    const score = getUsageScore(name, yearLater);
    // 衰减因子被钳制到 0.1，1 次使用 → 0.1
    expect(score).toBeCloseTo(0.1, 2);
  });
});
