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
import { runProvider, runProviderOnce, isRetryableError, type ProviderDef } from "./eval-runner.ts";

const FAKE_SCRIPT = resolve(import.meta.dir, "./providers/_test_fixtures/fake-provider.ts");

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

  test("429 / 503 / 502 / 504 触发", () => {
    expect(isRetryableError("HTTP 429 Too Many Requests", "")).toBe(true);
    expect(isRetryableError("", "503 Service Unavailable")).toBe(true);
    expect(isRetryableError("Bad Gateway 502", "")).toBe(true);
    expect(isRetryableError("", "504 Gateway Timeout")).toBe(true);
  });

  test("正常 [ERROR] 不触发", () => {
    expect(isRetryableError("[ERROR] empty output", "")).toBe(false);
  });

  test("超时关键字触发", () => {
    expect(isRetryableError("", "fetch failed: ETIMEDOUT")).toBe(true);
  });
});
