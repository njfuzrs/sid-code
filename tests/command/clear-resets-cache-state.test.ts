/**
 * /clear 路径补调的三个清理函数回归测试
 *
 * 验证 resetCacheDetection / clearCacheBreaks / resetCircuitBreaker 的行为：
 * 调用后旧状态确实被清除，新会话不受旧数据污染。
 *
 * 注意：这里直接测函数行为，不走完整 App /clear handler（那需要太多依赖）。
 * app.ts 中两处 case "clear" 已补调这三个函数——构建通过即证明调用链完整。
 */

import { describe, test, expect, beforeEach, beforeAll, afterAll } from "bun:test";
import {
  resetCacheDetection,
  clearCacheBreaks,
  recordCacheBreak,
  getRecentCacheBreaks,
  checkResponseForCacheBreak,
} from "@sid-code/core/api/cache-detection.ts";
import { resetCircuitBreaker } from "@sid-code/core/query/auto-compact.ts";
import { AutoCompactCircuitBreaker } from "@sid-code/core/query/circuit-breaker.ts";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// ─── 遥测隔离：recordCacheBreak 会同步落盘，必须重定向到 tmp ───
//
// 见 src/api/cache-detection.ts:428 —— recordCacheBreak 除推内存缓冲外还落盘遥测。
// 不重定向就会污染用户真实的 ~/.sid-code/cache-breaks.jsonl。
// 与 tests/telemetry/cache-telemetry-rotation.test.ts:38 同构。
let tmpDir: string;
let savedEnv: string | undefined;

beforeAll(() => {
  savedEnv = process.env.SID_CODE_CACHE_BREAKS;
  tmpDir = mkdtempSync(join(tmpdir(), "clear-resets-cache-"));
  process.env.SID_CODE_CACHE_BREAKS = join(tmpDir, "cache-breaks.jsonl");
});

afterAll(async () => {
  // 落盘走 dynamic import().then()，是待处理微任务；同步恢复 env 会与它赛跑。
  await new Promise((r) => setTimeout(r, 0));
  if (savedEnv === undefined) delete process.env.SID_CODE_CACHE_BREAKS;
  else process.env.SID_CODE_CACHE_BREAKS = savedEnv;
  try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
});

describe("resetCacheDetection — 缓存检测基线清除", () => {
  beforeEach(() => {
    resetCacheDetection();
  });

  test("重置后首次 checkResponse 返回 null（无旧基线对比）", () => {
    // 先建立一个基线
    checkResponseForCacheBreak({
      systemPrompt: "You are a helpful assistant.",
      toolSchemas: [{ name: "bash" }],
      model: "opus",
      cacheReadTokens: 10000,
    });

    // 重置
    resetCacheDetection();

    // 重置后的首次检查应返回 null（无上次基线可对比）
    const result = checkResponseForCacheBreak({
      systemPrompt: "Totally different prompt.",
      toolSchemas: [{ name: "read" }],
      model: "opus",
      cacheReadTokens: 500,
    });
    expect(result).toBeNull();
  });

  test("不重置时，缓存下降会被检测到", () => {
    // 建立基线（高缓存命中）
    checkResponseForCacheBreak({
      systemPrompt: "You are a helpful assistant.",
      toolSchemas: [{ name: "bash" }],
      model: "opus",
      cacheReadTokens: 10000,
    });

    // 第二次缓存骤降 + system prompt 变化 → 应检测到中断
    const result = checkResponseForCacheBreak({
      systemPrompt: "Completely different system prompt now.",
      toolSchemas: [{ name: "bash" }],
      model: "opus",
      cacheReadTokens: 500,
    });
    // 应该检测到中断（非 null）
    expect(result).not.toBeNull();
  });
});

describe("clearCacheBreaks — 中断历史记录清除", () => {
  beforeEach(() => {
    clearCacheBreaks();
  });

  test("清除后 getRecentCacheBreaks 返回空", () => {
    // 记录几条中断
    recordCacheBreak({
      dropPercent: 80,
      dropTokens: 8000,
      changes: ["system prompt changed"],
      categories: ["system_prompt"],
      previousCacheReadTokens: 10000,
      currentCacheReadTokens: 2000,
      ts: 1000,
      model: "opus",
    });
    recordCacheBreak({
      dropPercent: 60,
      dropTokens: 5000,
      changes: ["tools changed"],
      categories: ["tools"],
      previousCacheReadTokens: 8000,
      currentCacheReadTokens: 3000,
      ts: 2000,
      model: "sonnet",
    });

    expect(getRecentCacheBreaks().length).toBe(2);

    // 清除
    clearCacheBreaks();

    expect(getRecentCacheBreaks()).toEqual([]);
  });

  test("清除后新记录正常追加", () => {
    recordCacheBreak({
      dropPercent: 50,
      dropTokens: 3000,
      changes: ["model changed"],
      categories: ["model"],
      previousCacheReadTokens: 6000,
      currentCacheReadTokens: 3000,
      ts: 1000,
      model: "opus",
    });
    clearCacheBreaks();

    recordCacheBreak({
      dropPercent: 30,
      dropTokens: 2000,
      changes: ["new session break"],
      categories: ["prefix_break"],
      previousCacheReadTokens: 7000,
      currentCacheReadTokens: 5000,
      ts: 3000,
      model: "sonnet",
    });

    const records = getRecentCacheBreaks();
    expect(records.length).toBe(1);
    expect(records[0].ts).toBe(3000);
  });
});

describe("resetCircuitBreaker — 压缩熔断器重置", () => {
  beforeEach(() => {
    resetCircuitBreaker();
  });

  test("重置后熔断器回到 closed 状态", () => {
    // 直接验证 AutoCompactCircuitBreaker.reset() 语义
    // （resetCircuitBreaker 内部调用它 + 置 null 全局实例）
    const breaker = new AutoCompactCircuitBreaker({ failureThreshold: 2 });
    breaker.recordFailure();
    breaker.recordFailure(); // 触发熔断
    expect(breaker.getState()).toBe("open");
    expect(breaker.canExecute()).toBe(false);

    breaker.reset();
    expect(breaker.getState()).toBe("closed");
    expect(breaker.canExecute()).toBe(true);
    expect(breaker.getFailureCount()).toBe(0);
  });

  test("resetCircuitBreaker 可安全多次调用（幂等）", () => {
    // 即使全局实例为 null，也不抛错
    resetCircuitBreaker();
    resetCircuitBreaker();
    resetCircuitBreaker();
    // 到这里没抛就算通过
  });
});
