/**
 * cost-recompute 单测 —— §6.2（僵尸会话补写）+ §6.4（远端对账校正）
 *
 * 覆盖：
 * - recomputeCostFromEvents：从 events.jsonl 的 AfterModelRaw 重算 cost
 * - backfillTrajCost 情形 A：traj 缺失 → 据 events 构造最小 traj
 * - backfillTrajCost 情形 B：traj cost=0 → 据 events 补写
 * - backfillTrajCost 情形 C：traj cost 偏低 → 据 events 校正
 * - 幂等：补写过的 traj 再次调用跳过
 * - 不覆盖：traj cost 合理（≥ events）时不动
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { join } from "node:path";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import {
  recomputeCostFromEvents,
  backfillTrajCost,
  readTrajCost,
} from "../../src/trace/cost-recompute.ts";

let tmpRoot: string;
let sessionDir: string;

/** 用户配置：给 deepseek-v4-pro 一个明确定价，使重算结果可预期 */
const AVAILABLE_MODELS = [
  {
    name: "deepseek-v4-pro",
    provider: "openai",
    pricing: { input: 0.435, output: 0.87, cacheRead: 0.0036, cacheWrite: 0 },
  },
  {
    // cacheWrite 非 0，用于验证 cache_creation 确实计入重算 cost
    name: "claude-test",
    provider: "anthropic",
    pricing: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
  },
];

/** 写一行 AfterModelRaw 事件 */
function afterModelRaw(index: number, model: string, input: number, output: number, cacheRead = 0, cacheCreation = 0): string {
  return JSON.stringify({
    event: "AfterModelRaw",
    session_id: "test-sess",
    timestamp: "2026-06-29T10:14:25.000Z",
    data: {
      index,
      model,
      stop_reason: "end_turn",
      usage: { input_tokens: input, output_tokens: output, cache_read: cacheRead, cache_creation: cacheCreation },
    },
  });
}

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), "cost-recompute-"));
  sessionDir = join(tmpRoot, "sessions", "20260629-101436-test");
  mkdirSync(sessionDir, { recursive: true });
});

afterEach(() => {
  try { rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* ignore */ }
});

describe("recomputeCostFromEvents", () => {
  test("从 AfterModelRaw 重算非零 cost 与 token 汇总", () => {
    const events = [
      afterModelRaw(1, "deepseek-v4-pro", 27424, 74),
      afterModelRaw(2, "deepseek-v4-pro", 27909, 68),
    ].join("\n");
    writeFileSync(join(sessionDir, "events.jsonl"), events + "\n");

    const r = recomputeCostFromEvents(sessionDir, AVAILABLE_MODELS);
    expect(r).not.toBeNull();
    expect(r!.apiCalls).toBe(2);
    expect(r!.totalCostUSD).toBeGreaterThan(0);
    // 末次 input（stock）
    expect(r!.lastInputTokens).toBe(27909);
    // 累计 input（flow）= 27424 + 27909
    expect(r!.cumulativeInputTokens).toBe(27424 + 27909);
    expect(r!.totalOutputTokens).toBe(74 + 68);
    expect(r!.model).toBe("deepseek-v4-pro");
    expect(r!.source).toBe("events-recompute");
  });

  test("events.jsonl 不存在返回 null", () => {
    expect(recomputeCostFromEvents(sessionDir, AVAILABLE_MODELS)).toBeNull();
  });

  test("无 AfterModelRaw 事件返回 null", () => {
    writeFileSync(
      join(sessionDir, "events.jsonl"),
      JSON.stringify({ event: "SessionStart", session_id: "x", timestamp: "t" }) + "\n",
    );
    expect(recomputeCostFromEvents(sessionDir, AVAILABLE_MODELS)).toBeNull();
  });

  test("损坏行被跳过，不影响其余重算", () => {
    const events = [
      afterModelRaw(1, "deepseek-v4-pro", 100, 10),
      "{ 这是损坏的 JSON",
      afterModelRaw(2, "deepseek-v4-pro", 200, 20),
    ].join("\n");
    writeFileSync(join(sessionDir, "events.jsonl"), events + "\n");
    const r = recomputeCostFromEvents(sessionDir, AVAILABLE_MODELS);
    expect(r!.apiCalls).toBe(2);
  });

  test("cache_creation 计入重算与汇总（2026-07 补落）", () => {
    // 同一 input/output，一条带 cache_creation 一条不带，验证前者 cost 更高
    writeFileSync(
      join(sessionDir, "events.jsonl"),
      afterModelRaw(1, "claude-test", 1000, 100, /*cacheRead*/ 0, /*cacheCreation*/ 50000) + "\n",
    );
    const withCreate = recomputeCostFromEvents(sessionDir, AVAILABLE_MODELS)!;
    expect(withCreate.totalCacheCreationTokens).toBe(50000);
    expect(withCreate.calls[0]!.cacheCreationTokens).toBe(50000);

    // 对照组：无 cache_creation
    writeFileSync(
      join(sessionDir, "events.jsonl"),
      afterModelRaw(1, "claude-test", 1000, 100, 0, 0) + "\n",
    );
    const without = recomputeCostFromEvents(sessionDir, AVAILABLE_MODELS)!;
    expect(without.totalCacheCreationTokens).toBe(0);
    // cache_creation 计入定价（cacheWrite=3.75），故带写入的 cost 明显更高
    expect(withCreate.totalCostUSD).toBeGreaterThan(without.totalCostUSD);
  });

  test("向后兼容：补落前的历史会话无 cache_creation 字段 → 取 0，不报错", () => {
    // 手写一条不含 cache_creation 键的 AfterModelRaw（模拟旧格式）
    const legacy = JSON.stringify({
      event: "AfterModelRaw",
      session_id: "test-sess",
      timestamp: "2026-06-01T00:00:00.000Z",
      data: {
        index: 1,
        model: "deepseek-v4-pro",
        stop_reason: "end_turn",
        usage: { input_tokens: 500, output_tokens: 50, cache_read: 200 },
      },
    });
    writeFileSync(join(sessionDir, "events.jsonl"), legacy + "\n");
    const r = recomputeCostFromEvents(sessionDir, AVAILABLE_MODELS)!;
    expect(r.apiCalls).toBe(1);
    expect(r.totalCacheReadTokens).toBe(200);
    expect(r.totalCacheCreationTokens).toBe(0);
    expect(r.totalCostUSD).toBeGreaterThan(0);
  });
});

describe("backfillTrajCost 情形 A：traj 缺失", () => {
  test("僵尸会话无 traj → 据 events 构造最小 traj", () => {
    writeFileSync(
      join(sessionDir, "events.jsonl"),
      afterModelRaw(1, "deepseek-v4-pro", 27424, 74) + "\n",
    );
    expect(existsSync(join(sessionDir, "session.traj"))).toBe(false);

    const result = backfillTrajCost(sessionDir, AVAILABLE_MODELS);
    expect(result.backfilled).toBe(true);
    expect(existsSync(join(sessionDir, "session.traj"))).toBe(true);

    const traj = JSON.parse(readFileSync(join(sessionDir, "session.traj"), "utf-8"));
    expect(traj.metadata.total_cost_usd).toBeGreaterThan(0);
    expect(traj.metadata.cost_recomputed_from_events).toBe(true);
    expect(traj.metadata.exit_status).toBe("interrupted");
    // §6.3 字段也应在最小 traj 中
    expect(traj.metadata.total_cumulative_prompt_tokens).toBe(27424);
  });
});

describe("backfillTrajCost 情形 B：traj cost=0", () => {
  test("历史会话 cost=0 → 据 events 补写非零", () => {
    writeFileSync(
      join(sessionDir, "events.jsonl"),
      afterModelRaw(1, "deepseek-v4-pro", 27424, 74) + "\n",
    );
    // 写一个 cost=0 的 traj（模拟修复前历史会话）
    writeFileSync(
      join(sessionDir, "session.traj"),
      JSON.stringify({
        trajectory: [],
        history: [],
        info: { model_stats: { total_cost_usd: 0 } },
        metadata: { session_id: "x", model: "deepseek-v4-pro", total_cost_usd: 0 },
      }),
    );

    expect(readTrajCost(sessionDir)).toBe(0);
    const result = backfillTrajCost(sessionDir, AVAILABLE_MODELS);
    expect(result.backfilled).toBe(true);
    expect(readTrajCost(sessionDir)!).toBeGreaterThan(0);

    const traj = JSON.parse(readFileSync(join(sessionDir, "session.traj"), "utf-8"));
    expect(traj.metadata.cost_recomputed_from_events).toBe(true);
    // info.model_stats 也同步更新
    expect(traj.info.model_stats.total_cost_usd).toBeGreaterThan(0);
  });
});

describe("backfillTrajCost 情形 C：traj cost 偏低", () => {
  test("traj cost 明显低于 events 重算 → 校正为 events 值", () => {
    writeFileSync(
      join(sessionDir, "events.jsonl"),
      [afterModelRaw(1, "deepseek-v4-pro", 27424, 74), afterModelRaw(2, "deepseek-v4-pro", 27909, 68)].join("\n") + "\n",
    );
    const recomputed = recomputeCostFromEvents(sessionDir, AVAILABLE_MODELS)!;
    // traj 只记了一半（少采）
    const halfCost = recomputed.totalCostUSD / 2;
    writeFileSync(
      join(sessionDir, "session.traj"),
      JSON.stringify({
        info: { model_stats: { total_cost_usd: halfCost } },
        metadata: { session_id: "x", model: "deepseek-v4-pro", total_cost_usd: halfCost },
      }),
    );

    const result = backfillTrajCost(sessionDir, AVAILABLE_MODELS);
    expect(result.backfilled).toBe(true);
    expect(readTrajCost(sessionDir)!).toBeCloseTo(recomputed.totalCostUSD, 6);
  });
});

describe("backfillTrajCost 幂等与不覆盖", () => {
  test("补写过的 traj 再次调用跳过（幂等）", () => {
    writeFileSync(
      join(sessionDir, "events.jsonl"),
      afterModelRaw(1, "deepseek-v4-pro", 27424, 74) + "\n",
    );
    writeFileSync(
      join(sessionDir, "session.traj"),
      JSON.stringify({ metadata: { session_id: "x", model: "deepseek-v4-pro", total_cost_usd: 0 } }),
    );
    const first = backfillTrajCost(sessionDir, AVAILABLE_MODELS);
    expect(first.backfilled).toBe(true);

    const second = backfillTrajCost(sessionDir, AVAILABLE_MODELS);
    expect(second.backfilled).toBe(false);
    expect(second.reason).toContain("幂等");
  });

  test("traj cost 合理（≥ events 重算）时不覆盖", () => {
    writeFileSync(
      join(sessionDir, "events.jsonl"),
      afterModelRaw(1, "deepseek-v4-pro", 100, 10) + "\n",
    );
    const recomputed = recomputeCostFromEvents(sessionDir, AVAILABLE_MODELS)!;
    // traj cost 比 events 更高（含 cache_creation，更权威）
    const higherCost = recomputed.totalCostUSD * 2;
    writeFileSync(
      join(sessionDir, "session.traj"),
      JSON.stringify({ metadata: { session_id: "x", model: "deepseek-v4-pro", total_cost_usd: higherCost } }),
    );

    const result = backfillTrajCost(sessionDir, AVAILABLE_MODELS);
    expect(result.backfilled).toBe(false);
    expect(readTrajCost(sessionDir)!).toBeCloseTo(higherCost, 6);
  });
});

/**
 * 情形 A'：traj 存在但已损坏（2026-08-07 事故）。
 *
 * 落盘脱敏的信用卡号规则把 `"total_cost_usd": 0.4428123456780257` 的 16 位尾数
 * 当成卡号，改写成 `0.4428********0257` —— `*` 是真实字节，整份 session.traj
 * 不可 JSON.parse。此前 backfillTrajCost 在这里直接放弃（"解析 traj 失败"），
 * 于是损坏永久化；而 events.jsonl 是 append 语义并未受损，cost 本可重算。
 */
describe("backfillTrajCost 情形 A'：traj 损坏 → 据 events 重建", () => {
  /** 写一份被脱敏 bug 破坏的 traj（真实损坏形态） */
  function writeCorruptTraj(): string {
    const p = join(sessionDir, "session.traj");
    writeFileSync(
      p,
      '{\n  "metadata": {\n    "session_id": "x",\n' +
        '    "total_cost_usd": 0.4428********0257\n  }\n}',
    );
    return p;
  }

  beforeEach(() => {
    writeFileSync(
      join(sessionDir, "events.jsonl"),
      [
        afterModelRaw(1, "deepseek-v4-pro", 27424, 74),
        afterModelRaw(2, "deepseek-v4-pro", 27909, 68),
      ].join("\n") + "\n",
    );
  });

  test("损坏的 traj 被重建为可解析，且 cost 非零", () => {
    const p = writeCorruptTraj();
    expect(() => JSON.parse(readFileSync(p, "utf-8"))).toThrow();

    const result = backfillTrajCost(sessionDir, AVAILABLE_MODELS);
    expect(result.backfilled).toBe(true);
    expect(result.reason).toContain("损坏");

    // 重建后必须可解析
    const obj = JSON.parse(readFileSync(p, "utf-8"));
    expect(obj.metadata.total_cost_usd).toBeGreaterThan(0);
    expect(obj.metadata.cost_recomputed_from_events).toBe(true);
    // 产物里不能再有星号
    expect(readFileSync(p, "utf-8")).not.toContain("*");
  });

  test("原损坏文件被备份为 .corrupt（不静默丢用户数据）", () => {
    writeCorruptTraj();
    backfillTrajCost(sessionDir, AVAILABLE_MODELS);

    const backup = join(sessionDir, "session.traj.corrupt");
    expect(existsSync(backup)).toBe(true);
    // 备份保留原始损坏内容，供人工抢救
    expect(readFileSync(backup, "utf-8")).toContain("*");
  });

  test("幂等：重建后再跑不重复处理，且不覆盖已有备份", () => {
    writeCorruptTraj();
    backfillTrajCost(sessionDir, AVAILABLE_MODELS);
    const backup = join(sessionDir, "session.traj.corrupt");
    const firstBackup = readFileSync(backup, "utf-8");
    const firstTraj = readFileSync(join(sessionDir, "session.traj"), "utf-8");

    const second = backfillTrajCost(sessionDir, AVAILABLE_MODELS);
    expect(second.backfilled).toBe(false);
    expect(second.reason).toContain("幂等");
    // 备份与重建产物都不被二次改写
    expect(readFileSync(backup, "utf-8")).toBe(firstBackup);
    expect(readFileSync(join(sessionDir, "session.traj"), "utf-8")).toBe(firstTraj);
  });

  test("损坏且 events 也无可重算数据 → 不动文件（不制造更差的状态）", () => {
    writeFileSync(join(sessionDir, "events.jsonl"), "");
    const p = writeCorruptTraj();
    const before = readFileSync(p, "utf-8");

    const result = backfillTrajCost(sessionDir, AVAILABLE_MODELS);
    expect(result.backfilled).toBe(false);
    // 原文件保持原样，不留半成品
    expect(readFileSync(p, "utf-8")).toBe(before);
    expect(existsSync(join(sessionDir, "session.traj.corrupt"))).toBe(false);
  });
});
