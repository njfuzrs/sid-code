/**
 * S6：从 prompt-too-long 学习「已放行输入上限」。
 * 落盘重定向到 tmpdir（SID_CONFIG_DIR 存/恢复原值，见 CONTRIBUTING 测试约定）。
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  recordContextOverflow,
  lookupAdmittedCeiling,
  LEARNED_CEILING_TTL_MS,
} from "@sid-code/core/llm/learned-window.ts";
import { TokenEstimator } from "@sid-code/core/llm/token-estimator.ts";
import { Manager as ContextManager } from "@sid-code/core/context/manager.ts";
import { learnAdmittedCeilingOnOverflow } from "@sid-code/core/query/loop.ts";

const MODEL = "origin-test-model-s6";
const URL_A = "https://gw-a.example.com/v1";
const URL_B = "https://gw-b.example.com/v1";

let dir: string;
let prevDir: string | undefined;
beforeEach(() => {
  prevDir = process.env.SID_CONFIG_DIR;
  dir = mkdtempSync(join(tmpdir(), "sid-s6-"));
  process.env.SID_CONFIG_DIR = dir;
});
afterEach(() => {
  if (prevDir === undefined) delete process.env.SID_CONFIG_DIR;
  else process.env.SID_CONFIG_DIR = prevDir;
  rmSync(dir, { recursive: true, force: true });
});

describe("recordContextOverflow", () => {
  it("一次溢出不写入；第二次写入两次中较大的已放行值", () => {
    expect(
      recordContextOverflow({ model: MODEL, baseURL: URL_A, admittedTokens: 647_160 }).status,
    ).toBe("pending");
    expect(lookupAdmittedCeiling(MODEL, URL_A)).toBeUndefined();
    const r = recordContextOverflow({ model: MODEL, baseURL: URL_A, admittedTokens: 663_013 });
    expect(r).toEqual({ status: "learned", ceiling: 663_013, overflows: 2 });
    expect(lookupAdmittedCeiling(MODEL, URL_A)).toBe(663_013);
  });

  it("admitted=0（压缩后已清零）跳过，不计入次数", () => {
    expect(recordContextOverflow({ model: MODEL, baseURL: URL_A, admittedTokens: 0 }).status).toBe(
      "skipped",
    );
    expect(
      recordContextOverflow({ model: MODEL, baseURL: URL_A, admittedTokens: 600_000 }).status,
    ).toBe("pending");
  });

  it("不同 base_url 互不串值（同模型名不同路由）", () => {
    recordContextOverflow({ model: MODEL, baseURL: URL_A, admittedTokens: 600_000 });
    recordContextOverflow({ model: MODEL, baseURL: URL_A, admittedTokens: 600_000 });
    expect(lookupAdmittedCeiling(MODEL, URL_A)).toBe(600_000);
    expect(lookupAdmittedCeiling(MODEL, URL_B)).toBeUndefined();
    // 剥掉 origin- 前缀的同底层模型也不串
    expect(lookupAdmittedCeiling("test-model-s6", URL_A)).toBeUndefined();
  });

  it("TTL 过期后失效", () => {
    const t0 = 1_000_000;
    recordContextOverflow({ model: MODEL, baseURL: URL_A, admittedTokens: 600_000, now: t0 });
    recordContextOverflow({ model: MODEL, baseURL: URL_A, admittedTokens: 600_000, now: t0 + 1 });
    expect(lookupAdmittedCeiling(MODEL, URL_A, t0 + 2)).toBe(600_000);
    expect(lookupAdmittedCeiling(MODEL, URL_A, t0 + 2 + LEARNED_CEILING_TTL_MS)).toBeUndefined();
  });
});

describe("resolveContextLimit 接入", () => {
  it("学到后取 min 并标 learned；用户显式 contextWindow 不受影响", () => {
    const est = new TokenEstimator();
    const models = [{ name: MODEL, baseURL: URL_A }];
    const before = est.resolveContextLimit(MODEL, models).value;
    recordContextOverflow({ model: MODEL, baseURL: URL_A, admittedTokens: 300_000 });
    recordContextOverflow({ model: MODEL, baseURL: URL_A, admittedTokens: 300_000 });
    expect(before).toBeGreaterThan(300_000);
    expect(est.resolveContextLimit(MODEL, models)).toEqual({ value: 300_000, source: "learned" });
    // 顶层 baseURL 兜底
    expect(est.resolveContextLimit(MODEL, undefined, URL_A).value).toBe(300_000);
    // 用户配置最高优先
    const user = [{ name: MODEL, baseURL: URL_A, contextWindow: 900_000 }];
    expect(est.resolveContextLimit(MODEL, user)).toEqual({ value: 900_000, source: "user" });
  });
});

describe("learnAdmittedCeilingOnOverflow（loop 接线）", () => {
  const config = { model: MODEL, baseURL: URL_A, availableModels: [] as any[] };

  it("第二次溢出后 ctxMgr.maxTokens 当场变小（本会话即时生效）", () => {
    const ctx = new ContextManager({ maxTokens: 1_000_000 });
    ctx.recordActualTokens(662_114);
    learnAdmittedCeilingOnOverflow(ctx, config);
    expect(ctx.getMaxTokens()).toBe(1_000_000);
    ctx.recordActualTokens(663_013);
    learnAdmittedCeilingOnOverflow(ctx, config);
    expect(ctx.getMaxTokens()).toBe(663_013);
  });

  it("用户显式 contextWindow 时不学", () => {
    const ctx = new ContextManager({ maxTokens: 1_000_000 });
    const cfg = { ...config, availableModels: [{ name: MODEL, contextWindow: 1_000_000 }] };
    ctx.recordActualTokens(600_000);
    learnAdmittedCeilingOnOverflow(ctx, cfg);
    learnAdmittedCeilingOnOverflow(ctx, cfg);
    expect(ctx.getMaxTokens()).toBe(1_000_000);
    expect(lookupAdmittedCeiling(MODEL, URL_A)).toBeUndefined();
  });
});
