/**
 * cache-breaks.jsonl 轮转与尾部读取测试
 *
 * 背景：原实现只有 appendFileSync 没有任何轮转（文件头注释却承诺「体积可控」），
 * 实测本机长到 8.5MB / 51615 行且无收敛——缓存中断是核心度量对象，正常使用中持续高频增长。
 * 读侧 queryCacheBreakHistory 为拿 100 条 readFileSync 了整个 8.5MB（RSS 涨 33MB）。
 *
 * 测试经 SID_CODE_CACHE_BREAKS 重定向到 tmp，不触碰真实 ~/.sid-code。
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import {
  emitCacheBreakTelemetry,
  queryCacheBreakHistory,
  cacheBreaksPath,
} from "../../src/telemetry/cache-telemetry.ts";
import { mkdtempSync, rmSync, writeFileSync, existsSync, statSync, appendFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

let dir: string;
let logPath: string;
const savedEnv = process.env.SID_CODE_CACHE_BREAKS;

function makeRecord(i: number) {
  return {
    // ts 为 Unix epoch 秒（见 src/api/cache-detection.ts:413）
    ts: 1_700_000_000 + i,
    model: "test-model",
    dropTokens: i,
    dropPercent: 50,
    changes: [`change-${i}`],
    previousCacheReadTokens: 100,
    currentCacheReadTokens: 0,
  };
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "cache-breaks-rot-"));
  logPath = join(dir, "cache-breaks.jsonl");
  process.env.SID_CODE_CACHE_BREAKS = logPath;
});

afterEach(() => {
  if (savedEnv === undefined) delete process.env.SID_CODE_CACHE_BREAKS;
  else process.env.SID_CODE_CACHE_BREAKS = savedEnv;
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
});

describe("cache-breaks.jsonl 轮转", () => {
  test("测试重定向生效，不写真实 HOME", () => {
    expect(cacheBreaksPath()).toBe(logPath);
    expect(cacheBreaksPath().startsWith(dir)).toBe(true);
  });

  test("超过 10MB 上限时轮转为 .1", () => {
    // 预置一个刚超 10MB 的文件
    const filler = JSON.stringify(makeRecord(0)) + "\n";
    writeFileSync(logPath, filler.repeat(Math.ceil((10 * 1024 * 1024) / filler.length) + 10));
    expect(statSync(logPath).size).toBeGreaterThan(10 * 1024 * 1024);

    emitCacheBreakTelemetry(makeRecord(1));

    // 轮转 = renameSync 当前文件 → .1，此后当前文件不存在，
    // 由下一次 appendFileSync 自然重建（与 permission/audit.ts:61 行为一致）
    expect(existsSync(`${logPath}.1`)).toBe(true);
    expect(existsSync(logPath)).toBe(false);

    // 下一条写入重建当前文件，且从空开始
    emitCacheBreakTelemetry(makeRecord(2));
    expect(statSync(logPath).size).toBeLessThan(1024);
  });

  test("只保留 1 份历史，磁盘占用封顶（第二次轮转覆盖旧 .1）", () => {
    const filler = JSON.stringify(makeRecord(0)) + "\n";
    const oversized = filler.repeat(Math.ceil((10 * 1024 * 1024) / filler.length) + 10);

    // 第一轮：用可识别的标记内容，便于断言它确实被后一轮覆盖掉
    writeFileSync(logPath, oversized.replace(filler, JSON.stringify(makeRecord(1001)) + "\n"));
    emitCacheBreakTelemetry(makeRecord(1));
    expect(readFileSync(`${logPath}.1`, "utf-8")).toContain('"dropTokens":1001');

    // 第二轮：换一个标记再撑爆并轮转
    writeFileSync(logPath, oversized.replace(filler, JSON.stringify(makeRecord(2002)) + "\n"));
    emitCacheBreakTelemetry(makeRecord(2));

    expect(existsSync(`${logPath}.1`)).toBe(true);
    expect(existsSync(`${logPath}.2`)).toBe(false); // 不累积第二份历史
    // 旧 .1 已被新的覆盖：只应看到第二轮标记
    const backup = readFileSync(`${logPath}.1`, "utf-8");
    expect(backup).toContain('"dropTokens":2002');
    expect(backup).not.toContain('"dropTokens":1001');
  });

  test("未超上限时不轮转", () => {
    for (let i = 0; i < 5; i++) emitCacheBreakTelemetry(makeRecord(i));
    expect(existsSync(`${logPath}.1`)).toBe(false);
    expect(queryCacheBreakHistory(100)).toHaveLength(5);
  });
});

describe("cache-breaks 尾部读取", () => {
  test("正常读取最近 N 条且顺序保持（旧 → 新）", () => {
    for (let i = 0; i < 50; i++) emitCacheBreakTelemetry(makeRecord(i));

    const recent = queryCacheBreakHistory(10);
    expect(recent).toHaveLength(10);
    expect(recent[0]!.dropTokens).toBe(40);
    expect(recent[9]!.dropTokens).toBe(49);
  });

  test("刚轮转后仍能读到历史（回补 .1，轮转引入的新失败模式）", () => {
    // 先写满一批真实条目，再触发轮转
    for (let i = 0; i < 30; i++) emitCacheBreakTelemetry(makeRecord(i));
    const filler = JSON.stringify(makeRecord(0)) + "\n";
    appendFileSync(logPath, filler.repeat(Math.ceil((10 * 1024 * 1024) / filler.length) + 10));

    emitCacheBreakTelemetry(makeRecord(999)); // 触发轮转
    expect(existsSync(`${logPath}.1`)).toBe(true);

    // 若不回补 .1，此处会几近为空 —— /cache --history 就"失忆"了
    const recent = queryCacheBreakHistory(100);
    expect(recent.length).toBeGreaterThan(1);
  });

  test("超大文件不再全量读入（尾部窗口与总大小解耦）", () => {
    // 造一个 12MB 文件但只要 5 条：预置时绕过 emit，避免触发轮转
    const filler = JSON.stringify(makeRecord(0)) + "\n";
    writeFileSync(logPath, filler.repeat(Math.ceil((12 * 1024 * 1024) / filler.length)));
    for (let i = 1; i <= 5; i++) appendFileSync(logPath, JSON.stringify(makeRecord(i)) + "\n");

    const before = process.memoryUsage().rss;
    const recent = queryCacheBreakHistory(5);
    const grewMB = (process.memoryUsage().rss - before) / 1024 / 1024;

    expect(recent).toHaveLength(5);
    expect(recent[4]!.dropTokens).toBe(5);
    // 全量读 12MB 会让 RSS 涨数十 MB；尾部窗口仅 1MB
    expect(grewMB).toBeLessThan(12);
  });

  test("损坏行跳过，不抛错", () => {
    emitCacheBreakTelemetry(makeRecord(1));
    appendFileSync(logPath, "{ 这不是合法 JSON\n");
    emitCacheBreakTelemetry(makeRecord(2));

    const recent = queryCacheBreakHistory(100);
    expect(recent).toHaveLength(2);
  });

  test("文件不存在返回空数组", () => {
    process.env.SID_CODE_CACHE_BREAKS = join(dir, "nonexistent.jsonl");
    expect(queryCacheBreakHistory(10)).toEqual([]);
  });
});
