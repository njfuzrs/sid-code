/**
 * eval-runner e2e 测试：覆盖 runProvider / runProviderOnce 的 spawn 路径。
 *
 * 用 fake-provider.ts 做被 spawn 的子进程，避免真的调 LLM。
 * 重点验证：
 *   - 成功路径正确解析 JSON
 *   - retryable 错误触发重试（但用极短超时避免测试拖太久）
 *   - 不可重试错误一次直接返回
 *   - parse_error 视为 error 返回
 *   - 外层 timeout 兜底（fake-provider hang 模式）
 *   - retry succeed_after：N 次失败后第 N+1 次成功
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { join, resolve } from "node:path";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import {
  runProvider,
  runProviderOnce,
  isRetryableError,
  aggregateSamples,
  type ProviderDef,
} from "./runner.ts";
import type { DimScore } from "./judge.ts";

const FAKE_SCRIPT = resolve(import.meta.dir, "../providers/_test_fixtures/fake-provider.ts");

function buildFakeProvider(opts: Partial<ProviderDef> = {}): ProviderDef {
  return {
    name: "fake",
    script: FAKE_SCRIPT,
    timeoutMs: 5_000,
    maxTurns: 5,
    ...opts,
  };
}

let stateDir = "";
beforeEach(() => {
  stateDir = mkdtempSync(join(tmpdir(), "eval-runner-test-"));
});
afterEach(() => {
  if (stateDir && existsSync(stateDir)) {
    rmSync(stateDir, { recursive: true, force: true });
  }
});

describe("runProviderOnce - 单次执行", () => {
  test("success 模式正常返回", async () => {
    process.env.FAKE_MODE = "success";
    const r = await runProviderOnce(buildFakeProvider(), "test prompt", "case_fake");
    expect(r.error).toBeFalsy();
    expect(r.output).toContain("fake answer");
    expect(r.meta.tools_used).toEqual(["read"]);
  });

  test("retryable_error 模式返回 error=true + ECONNRESET 在 stderrTail", async () => {
    process.env.FAKE_MODE = "retryable_error";
    const r = await runProviderOnce(buildFakeProvider(), "test", "case_fake");
    expect(r.error).toBe(true);
    expect(r.output).toContain("[ERROR]");
    expect(r.stderrTail).toContain("ECONNRESET");
  });

  test("parse_error 模式（非 JSON 输出）→ error + parse_error 状态", async () => {
    process.env.FAKE_MODE = "parse_error";
    const r = await runProviderOnce(buildFakeProvider(), "test", "case_fake");
    expect(r.error).toBe(true);
    expect(r.meta.exit_status).toBe("parse_error");
  });

  // 注：hang/外层 timeout 测试需要 30s buffer，会让单测拖太久。
  // 这条路径靠真实跑评测时观察 stderr 的 "[eval-runner] OUTER TIMEOUT" 验证，
  // 单测用 STDOUT_MAX 那条 case 间接覆盖（overflow 也会强杀子进程）。
});

describe("runProvider - retry 状态机", () => {
  test("成功一次直接返回（不重试）", async () => {
    process.env.FAKE_MODE = "success";
    const r = await runProvider(buildFakeProvider(), "test", "case_fake", 2);
    expect(r.error).toBeFalsy();
    expect(r.output).toContain("fake answer");
  });

  test("不可重试错误不触发重试", async () => {
    process.env.FAKE_MODE = "non_retryable";
    const start = Date.now();
    const r = await runProvider(buildFakeProvider(), "test", "case_fake", 2);
    const elapsed = Date.now() - start;
    expect(r.error).toBe(true);
    // 没重试 → 总耗时应小于一次单跑 + buffer（不会触发 2s/8s 退避）
    expect(elapsed).toBeLessThan(2_000);
  });

  test("retryable 错误用尽 maxRetries 后返回 error", async () => {
    process.env.FAKE_MODE = "retryable_error";
    delete process.env.FAKE_STATE_FILE;
    const start = Date.now();
    const r = await runProvider(buildFakeProvider(), "test", "case_fake", 2);
    const elapsed = Date.now() - start;
    expect(r.error).toBe(true);
    expect(r.output).toContain("[ERROR]");
    // 应当经过 2 次退避：2s + 8s = 10s，加 3 次跑 → 至少 10s
    expect(elapsed).toBeGreaterThan(9_000);
  }, 30_000);

  test("succeed_after=1: 第 1 次失败，第 2 次成功", async () => {
    process.env.FAKE_MODE = "succeed_after=1";
    process.env.FAKE_STATE_FILE = join(stateDir, "state.txt");
    const start = Date.now();
    const r = await runProvider(buildFakeProvider(), "test", "case_fake", 2);
    const elapsed = Date.now() - start;
    expect(r.error).toBeFalsy();
    expect(r.output).toContain("fake answer");
    // 1 次退避 = 2s + 2 次 spawn
    expect(elapsed).toBeGreaterThan(1_900);
    expect(elapsed).toBeLessThan(8_000);
  }, 15_000);

  test("succeed_after=2: 用尽 maxRetries=1，应当不能成功", async () => {
    process.env.FAKE_MODE = "succeed_after=2";
    process.env.FAKE_STATE_FILE = join(stateDir, "state.txt");
    const r = await runProvider(buildFakeProvider(), "test", "case_fake", 1);
    // maxRetries=1 总共跑 2 次，前 2 次都失败 → 最终返回 error
    expect(r.error).toBe(true);
  }, 15_000);
});

describe("isRetryableError - 真实匹配", () => {
  test("ECONNRESET 在 stderr 触发", () => {
    expect(isRetryableError("", "ECONNRESET socket")).toBe(true);
  });

  test("429 / 503 / 502 / 504 在 stderr 触发", () => {
    expect(isRetryableError("", "HTTP 429 Too Many Requests")).toBe(true);
    expect(isRetryableError("", "503 Service Unavailable")).toBe(true);
    expect(isRetryableError("", "Bad Gateway 502")).toBe(true);
    expect(isRetryableError("", "504 Gateway Timeout")).toBe(true);
  });

  test("429 / 503 / 502 / 504 在 output [ERROR] 块开头触发", () => {
    expect(isRetryableError("[ERROR] HTTP 429 Too Many Requests", "")).toBe(true);
    expect(isRetryableError("[ERROR] 503 Service Unavailable from upstream", "")).toBe(true);
    expect(isRetryableError("[TIMEOUT] Gateway Timeout 504", "")).toBe(true);
  });

  test("regression 审查 #9：agent 长输出里出现 429/502 关键字不应触发重试", () => {
    // 旧实现扫整个 stdout → 任何讨论 HTTP 状态码的回答都会被误判为可重试错误，
    // 触发无声 retry，最后一次 attempt 的结果覆盖前一次（污染数据）。
    // 新实现：只看 stderr 和 output 的 [ERROR]/[TIMEOUT] 前缀块。
    const agentAnswer =
      "HTTP 502 是 Bad Gateway 错误，常见于 nginx 反向代理。如果遇到 429 Too Many Requests，应该退避重试。";
    expect(isRetryableError(agentAnswer, "")).toBe(false);
  });

  test("正常 [ERROR] 不触发", () => {
    expect(isRetryableError("[ERROR] empty output", "")).toBe(false);
  });

  test("超时关键字触发", () => {
    expect(isRetryableError("", "fetch failed: ETIMEDOUT")).toBe(true);
  });
});

describe("aggregateSamples - 多次采样每维度中位数", () => {
  function dim(score: number | null, reason = ""): DimScore {
    return { pass: score !== null && score >= 0.6, score, reason };
  }

  test("samples=1 直接返回唯一一份 dims", () => {
    const single = { anchor_hit: dim(1.0), rubric_score: dim(0.85) };
    const r = aggregateSamples([single]);
    expect(r).toBe(single);
  });

  test("samples=0 返回空对象（兜底，不应被调用）", () => {
    expect(aggregateSamples([])).toEqual({});
  });

  test("3 次采样：每维度独立取中位数（rubric 跳变不污染 anchor）", () => {
    const samples = [
      { anchor_hit: dim(1.0), rubric_score: dim(0) }, // rubric 异常 0
      { anchor_hit: dim(1.0), rubric_score: dim(1.0) },
      { anchor_hit: dim(1.0), rubric_score: dim(0.95) },
    ];
    const r = aggregateSamples(samples);
    // anchor 三次都是 1.0 → 中位数 1.0
    expect(r.anchor_hit.score).toBe(1.0);
    // rubric [0, 0.95, 1.0] → 中位数 0.95（不受 0 跳变拉低）
    expect(r.rubric_score.score).toBe(0.95);
    expect(r.rubric_score.reason).toContain("median 3 samples");
  });

  test("4 次采样取下中位数（不平均、保留档位制语义）", () => {
    const samples = [
      { rubric_score: dim(0) },
      { rubric_score: dim(0.85) },
      { rubric_score: dim(0.95) },
      { rubric_score: dim(1.0) },
    ];
    const r = aggregateSamples(samples);
    // 升序 [0, 0.85, 0.95, 1.0]，n=4，下中位数 idx=floor(3/2)=1 → 0.85
    expect(r.rubric_score.score).toBe(0.85);
  });

  test("多数样本 null → 该维度判 null（不能用少数样本伪装）", () => {
    const samples = [
      { rubric_score: dim(null, "judge 不可用") },
      { rubric_score: dim(null, "judge 不可用") },
      { rubric_score: dim(0.85) },
    ];
    const r = aggregateSamples(samples);
    // 3 个样本中 2 个 null（≥ ceil(3/2)=2）→ 该维度判 null
    expect(r.rubric_score.score).toBeNull();
    expect(r.rubric_score.reason).toContain("多数样本无可评数据");
  });

  test("少数 null + 多数有值 → 用有效样本的中位数", () => {
    const samples = [
      { rubric_score: dim(null, "judge 失败") },
      { rubric_score: dim(0.85) },
      { rubric_score: dim(0.95) },
    ];
    const r = aggregateSamples(samples);
    // 2 个有效（≥ ceil(3/2)=2 是边界 "至少一半"），有效集 [0.85, 0.95] 下中位数 = 0.85
    expect(r.rubric_score.score).toBe(0.85);
  });

  test("regression: rubric 0↔1 跳变，中位数稳到中间档", () => {
    // 真实 case_028 历史方差：rubric [1, 1, 1, 1, 0, 1, 1, 0.95]
    const samples = [
      { rubric_score: dim(1.0) },
      { rubric_score: dim(1.0) },
      { rubric_score: dim(1.0) },
      { rubric_score: dim(1.0) },
      { rubric_score: dim(0) },
      { rubric_score: dim(1.0) },
      { rubric_score: dim(1.0) },
      { rubric_score: dim(0.95) },
    ];
    const r = aggregateSamples(samples);
    // 排序 [0, 0.95, 1, 1, 1, 1, 1, 1]，n=8，下中位数 idx=3 → 1.0
    expect(r.rubric_score.score).toBe(1.0);
  });

  test("不同样本含的维度不同：取并集，单次缺失不影响中位数", () => {
    const samples: Array<Record<string, DimScore>> = [
      { anchor_hit: dim(1.0), rubric_score: dim(0.85) },
      { anchor_hit: dim(0.5) }, // 这次 rubric 缺失（极端边界）
      { anchor_hit: dim(1.0), rubric_score: dim(0.95) },
    ];
    const r = aggregateSamples(samples);
    expect(r.anchor_hit.score).toBe(1.0); // [0.5, 1, 1] → 1
    // rubric 只有 2 次有数据，但都不是 null，2 ≥ ceil(2/2)=1 → 中位数 [0.85, 0.95] 下中位 0.85
    expect(r.rubric_score.score).toBe(0.85);
  });
});
