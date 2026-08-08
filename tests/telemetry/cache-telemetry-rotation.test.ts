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
  summarizeCacheBreakHistory,
  cacheBreaksPath,
  buildTelemetryEntry,
} from "../../src/telemetry/cache-telemetry.ts";
import { CacheBreakDetector, type CacheCheckParams, type CacheBreakCategory } from "../../src/api/cache-detection.ts";
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
    categories: [] as CacheBreakCategory[],
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

/**
 * 归因聚合与检测器实际产出的文案对账。
 *
 * 缺陷背景：summarizeCacheBreakHistory 的分类分支是照"模型/工具/TTL"这类归因写的，
 * 而 P2-1 新增的两条前缀 hash 归因（cache-detection.ts:264-268）没有对应分支，
 * 全部落进 unknown。清理污染数据后实测：632 条真实记录里 631 条是"服务端缓存波动"，
 * 聚合却报 unknown —— 这个命令的聚合视图等于失效，且因为假数据长期霸占读取窗口而没被发现。
 *
 * 本测试不手抄文案常量，而是让**真实检测器**产出归因再喂给聚合器，
 * 这样任一侧改文案都会被抓到（手抄两份必然漂移，见 CLAUDE.md 六点五 d 项的同类教训）。
 */
describe("归因聚合 ↔ 检测器文案对账", () => {
  function detectorParams(over: Partial<CacheCheckParams> = {}): CacheCheckParams {
    return {
      cacheReadTokens: 50000,
      systemPrompt: "you are helpful",
      toolSchemas: [{ name: "read", description: "read file" }],
      model: "test-model",
      ...over,
    };
  }

  test("前缀未变的服务端波动归入 server_fluctuation，不落 unknown", () => {
    const d = new CacheBreakDetector();
    d.checkResponse(detectorParams());
    // 只降命中、不动 prompt/tools → 前缀 hash 不变 → 检测器输出"服务端缓存波动"
    const report = d.checkResponse(detectorParams({ cacheReadTokens: 5000 }))!;
    expect(report).not.toBeNull();
    emitCacheBreakTelemetry({ ...report, ts: 1_700_000_100, model: "test-model" });

    const s = summarizeCacheBreakHistory(10);
    expect(s.byCategory.server_fluctuation).toBe(1);
    expect(s.byCategory.unknown).toBeUndefined();
  });

  test("前缀变化的本地断裂归入已有类别，同样不落 unknown", () => {
    const d = new CacheBreakDetector();
    d.checkResponse(detectorParams());
    // 改 systemPrompt → 前缀 hash 变化，检测器会给出 System prompt 归因
    const report = d.checkResponse(
      detectorParams({ cacheReadTokens: 5000, systemPrompt: "CHANGED" }),
    )!;
    emitCacheBreakTelemetry({ ...report, ts: 1_700_000_200, model: "test-model" });

    const s = summarizeCacheBreakHistory(10);
    expect(s.byCategory.unknown).toBeUndefined();
    expect(s.total).toBe(1);
  });

  test("检测器产出的每一种归因都有对应分类分支（防新增归因漏配）", () => {
    // 覆盖检测器的主要归因路径，逐条落盘后断言零 unknown
    const cases: Array<[string, Partial<CacheCheckParams>]> = [
      ["模型变化", { model: "other-model" }],
      ["System prompt", { systemPrompt: "DIFFERENT" }],
      ["工具变化", { toolSchemas: [{ name: "read" }, { name: "bash" }] }],
      ["Beta headers", { betaHeaders: ["token-efficient-tools-2025-02-19"] }],
      ["服务端波动", {}],
    ];
    let ts = 1_700_001_000;
    for (const [, over] of cases) {
      const d = new CacheBreakDetector();
      d.checkResponse(detectorParams({ betaHeaders: [] }));
      const report = d.checkResponse(detectorParams({ cacheReadTokens: 5000, betaHeaders: [], ...over }));
      if (!report) continue;
      emitCacheBreakTelemetry({ ...report, ts: ts++, model: "test-model" });
    }

    const s = summarizeCacheBreakHistory(100);
    expect(s.total).toBeGreaterThanOrEqual(cases.length);
    // 任一归因文案没有分类分支 → unknown 非空 → 本测试失败并暴露漏配
    expect(s.byCategory.unknown ?? 0).toBe(0);
  });

  test("新记录走结构化 categories，不再依赖文案匹配", () => {
    const d = new CacheBreakDetector();
    d.checkResponse(detectorParams());
    const report = d.checkResponse(detectorParams({ cacheReadTokens: 5000 }))!;
    emitCacheBreakTelemetry({ ...report, ts: 1_700_002_000, model: "test-model" });

    const s = summarizeCacheBreakHistory(10);
    expect(s.structuredCount).toBe(1);
    expect(s.legacyCount).toBe(0);
  });

  test("旧记录（无 categories）仍能按文案兜底聚合", () => {
    // 模拟 2026-08-08 之前落盘的行：只有 changes，没有 categories
    appendFileSync(
      cacheBreaksPath(),
      JSON.stringify({
        ts: 1_700_003_000,
        model: "legacy-model",
        dropTokens: 9000,
        dropPercent: 90,
        changes: ["本地前缀 hash 未变（abc），命中下降疑为服务端缓存波动"],
        previousCacheReadTokens: 10000,
        currentCacheReadTokens: 1000,
      }) + "\n",
      "utf-8",
    );

    const s = summarizeCacheBreakHistory(10);
    expect(s.legacyCount).toBe(1);
    expect(s.structuredCount).toBe(0);
    expect(s.byCategory.server_fluctuation).toBe(1);
  });
});

/**
 * P0-3 门禁：落盘不得静默丢字段。
 *
 * 缺陷背景（2026-08-08 实测）：`emitCacheBreakTelemetry` 手写字段拷贝列表，
 * 漏了 `previousPrefixHash` / `currentPrefixHash` —— 检测器算出来了、落盘时被丢掉，
 * 676 条历史记录里带 hash 判据的是 **0 条**。于是"服务端波动占 99.5%"这个结论
 * 只能靠对中文文案做子串匹配得出，文案一改统计就断。
 *
 * 手写白名单的失败模式是**静默**：新增字段忘了拷，代码照跑、测试照绿、数据永久缺失。
 * 所以修法不是"补两个字段"，而是改成默认透传 + 显式剔除，并用本测试锁住这个不变量。
 */
describe("P0-3 落盘保真度门禁（默认透传 + 显式剔除）", () => {
  function realReport() {
    const d = new CacheBreakDetector();
    const params: CacheCheckParams = {
      cacheReadTokens: 50000,
      systemPrompt: "you are helpful",
      toolSchemas: [{ name: "read", description: "read file" }],
      model: "test-model",
      precededByRetry: true,
    };
    d.checkResponse(params);
    return d.checkResponse({ ...params, cacheReadTokens: 5000 })!;
  }

  test("record 的所有键都进落盘 entry（新增字段忘了拷 → 本测试红）", () => {
    const record = { ...realReport(), ts: 1_700_004_000, model: "test-model" };
    const entry = buildTelemetryEntry(record);

    // 不手抄期望字段列表：直接拿 record 的键集合做全覆盖断言。
    // 这样任何新增字段都被自动纳入门禁，无需记得更新测试。
    const landed = entry as unknown as Record<string, unknown>;
    const missing = Object.entries(record)
      .filter(([, v]) => v !== undefined)
      .map(([k]) => k)
      .filter((k) => !(k in landed));
    expect(missing).toEqual([]);
  });

  test("hash 判据与 categories 真的落到磁盘并能读回（端到端）", () => {
    const report = realReport();
    // 前置断言：检测器确实算出了 hash（否则下面的断言是空转）
    expect(report.previousPrefixHash).toBeTruthy();
    expect(report.categories.length).toBeGreaterThan(0);

    emitCacheBreakTelemetry({ ...report, ts: 1_700_004_100, model: "test-model" });

    const [readBack] = queryCacheBreakHistory(1);
    expect(readBack).toBeDefined();
    expect(readBack!.previousPrefixHash).toBe(report.previousPrefixHash);
    expect(readBack!.currentPrefixHash).toBe(report.currentPrefixHash);
    expect(readBack!.categories).toEqual(report.categories);
    expect(readBack!.precededByRetry).toBe(true);
  });

  test("undefined 值不落成键（门禁断言的是键不存在，而非值为 undefined）", () => {
    const record = {
      ...realReport(),
      ts: 1_700_004_200,
      model: "test-model",
      precededByRetry: undefined,
    };
    const entry = buildTelemetryEntry(record) as unknown as Record<string, unknown>;
    expect("precededByRetry" in entry).toBe(false);
  });
});
