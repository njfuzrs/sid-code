/**
 * `buildUsageLedgerEntry`（账本行构造）单测。
 *
 * 背景：这段逻辑原先长在 `packages/cli/src/app.ts` 的 App 私有方法里（D1 下沉到 core），
 * 只能靠起整个 CLI 才测得到。它产出的是长期回溯用的账本行，口径错了不会报错、
 * 只会给出错误结论，所以必须有回归保护。
 *
 * 隔离：构造过程会经 `getIdentity()` 落盘 deviceId，故把 SID_CONFIG_DIR 重定向到
 * 临时目录（并在 afterEach 恢复原值，不无条件 delete——同批测试跑在同一进程里，
 * 直接删会抹掉 preload 兜底）。
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionState } from "@sid-code/core/session/state.ts";
import { buildUsageLedgerEntry } from "@sid-code/core/telemetry/usage-ledger-entry.ts";
import { recordSideCall, resetSessionSideStats } from "@sid-code/core/trace/side-call-sink.ts";
import type { Usage } from "@sid-code/core/llm/types.ts";

let tmpDir: string;
const savedCfgDir = process.env.SID_CONFIG_DIR;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "sid-ledger-entry-"));
  process.env.SID_CONFIG_DIR = tmpDir;
  // 影子调用统计是模块级单例：先归零，确保「本会话有没有影子调用」由用例自己决定，
  // 不受同批其它测试文件的记录影响。
  resetSessionSideStats();
});

afterEach(() => {
  if (savedCfgDir === undefined) delete process.env.SID_CONFIG_DIR;
  else process.env.SID_CONFIG_DIR = savedCfgDir;
  // 同样归零后交还给后续文件，避免把本文件的影子调用记录算进它们
  resetSessionSideStats();
  try {
    rmSync(tmpDir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

/** 记一次成功的用量（OpenAI 口径：inputTokens 含命中） */
function record(ss: SessionState, model: string, usage: Usage, provider = "openai"): void {
  ss.updateUsage(model, usage, 10, provider);
}

describe("buildUsageLedgerEntry", () => {
  test("空会话（无 API 调用）→ null", () => {
    const ss = new SessionState("empty-session");
    expect(buildUsageLedgerEntry({ sessionState: ss })).toBeNull();
  });

  test("记录一次用量后：sessionId / model / promptTotal / costUSD / ts 正确", () => {
    const ss = new SessionState("s1");
    record(ss, "deepseek-v4-pro", { inputTokens: 1000, outputTokens: 100 });
    const entry = buildUsageLedgerEntry({
      sessionState: ss,
      // 注入固定时间，避免断言随挂钟漂移
      now: () => 1_700_000_000_000,
    });
    expect(entry).not.toBeNull();
    expect(entry!.sessionId).toBe("s1");
    expect(entry!.model).toBe("deepseek-v4-pro");
    // promptTotal = 未命中 1000 + 命中 0 + 写入 0
    expect(entry!.promptTotal).toBe(1000);
    expect(entry!.output).toBe(100);
    // 成本口径 = SessionState 的有效总成本（总数 + 影子调用），且真实计费 > 0
    expect(entry!.costUSD).toBe(ss.getEffectiveTotalCostUSD());
    expect(entry!.costUSD).toBeGreaterThan(0);
    expect(entry!.ts).toBe(1_700_000_000);
  });

  test("多模型会话：model / provider 取请求数最多的那个", () => {
    const ss = new SessionState("s2");
    record(ss, "model-a", { inputTokens: 100, outputTokens: 10 });
    record(ss, "model-a", { inputTokens: 100, outputTokens: 10 });
    // 两个模型的 provider 刻意不同，用来证明 provider 取自「主导模型」而非任意值
    record(ss, "model-b", { inputTokens: 500, outputTokens: 50 }, "anthropic");
    const entry = buildUsageLedgerEntry({ sessionState: ss });
    expect(entry!.model).toBe("model-a"); // requests: a=2 > b=1
    expect(entry!.provider).toBe("openai");
    // token 仍是全会话汇总（含次主导模型）
    expect(entry!.promptTotal).toBe(700);
  });

  test("无影子调用：不落 sideInputTokens 键（缺失 ≠ 0）", () => {
    const ss = new SessionState("s3");
    record(ss, "deepseek-v4-pro", { inputTokens: 1000, outputTokens: 100 });
    const entry = buildUsageLedgerEntry({ sessionState: ss })!;
    // 落 0 与「旧数据没有这个字段」在读侧无法区分，所以必须是键不存在
    expect("sideInputTokens" in entry).toBe(false);
    expect("sideOutputTokens" in entry).toBe(false);
    expect("sideCostUSD" in entry).toBe(false);
  });

  test("有影子调用：落三个 side 字段，与 getSessionSideStats 同口径", () => {
    const ss = new SessionState("s4");
    record(ss, "deepseek-v4-pro", { inputTokens: 1000, outputTokens: 100 });
    recordSideCall({
      label: "title",
      model: "deepseek-v4-pro",
      inputTokens: 123,
      outputTokens: 45,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      durationMs: 5,
      costUSD: 0.0001,
    });
    const entry = buildUsageLedgerEntry({ sessionState: ss })!;
    expect(entry.sideInputTokens).toBe(123);
    expect(entry.sideOutputTokens).toBe(45);
    expect(entry.sideCostUSD).toBe(0.0001);
  });

  test("appVersion 恒存在（无条件写，缺失只发生在存量行上）", () => {
    const ss = new SessionState("s5");
    record(ss, "deepseek-v4-pro", { inputTokens: 1000, outputTokens: 100 });
    const entry = buildUsageLedgerEntry({ sessionState: ss })!;
    expect(typeof entry.appVersion).toBe("string");
    expect(entry.appVersion!.length).toBeGreaterThan(0);
  });
});
