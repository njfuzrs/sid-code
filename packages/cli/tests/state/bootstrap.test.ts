import { describe, test, expect } from "bun:test";
import {
  getSessionId,
  setSessionId,
  getCwd,
  setCwd,
  getTotalCostUSD,
  getTotalAPIDuration,
  getTotalToolDuration,
  addToCost,
  addToAPIDuration,
  addToToolDuration,
  resetTurnMetrics,
  getTurnMetrics,
  getMainLoopModelOverride,
  setMainLoopModelOverride,
  isInteractive,
  setIsInteractive,
  logError,
  getErrorLog,
} from "@sid-code/cli/state/bootstrap.ts";

describe("BootstrapState", () => {
  test("sessionId getter/setter", () => {
    const original = getSessionId();
    setSessionId("test-123");
    expect(getSessionId()).toBe("test-123");
    setSessionId(original);
  });

  test("cwd getter/setter", () => {
    const original = getCwd();
    setCwd("/tmp/test");
    expect(getCwd()).toBe("/tmp/test");
    setCwd(original);
  });

  test("addToToolDuration 累加器", () => {
    const before = getTotalToolDuration();
    addToToolDuration(100);
    addToToolDuration(200);
    expect(getTotalToolDuration()).toBe(before + 300);
  });

  test("addToAPIDuration 累加器", () => {
    const before = getTotalAPIDuration();
    addToAPIDuration(500);
    expect(getTotalAPIDuration()).toBe(before + 500);
  });

  test("addToCost 累加器", () => {
    const before = getTotalCostUSD();
    addToCost("test-model", 0.01, {
      inputTokens: 100,
      outputTokens: 50,
      cacheReadInputTokens: 0,
      cacheCreationInputTokens: 0,
      requests: 1,
      costUSD: 0.01,
    });
    expect(getTotalCostUSD()).toBeCloseTo(before + 0.01);
  });

  test("resetTurnMetrics 重置每轮指标", () => {
    addToToolDuration(100);
    addToAPIDuration(200);
    resetTurnMetrics();
    const metrics = getTurnMetrics();
    expect(metrics.toolDurationMs).toBe(0);
    expect(metrics.toolCount).toBe(0);
    expect(metrics.apiDurationMs).toBe(0);
    expect(metrics.apiCount).toBe(0);
  });

  test("mainLoopModelOverride getter/setter", () => {
    setMainLoopModelOverride("claude-sonnet-4");
    expect(getMainLoopModelOverride()).toBe("claude-sonnet-4");
    setMainLoopModelOverride(null);
    expect(getMainLoopModelOverride()).toBeNull();
  });

  test("isInteractive getter/setter", () => {
    expect(isInteractive()).toBe(true);
    setIsInteractive(false);
    expect(isInteractive()).toBe(false);
    setIsInteractive(true);
  });

  test("errorLog 记录和上限", () => {
    const beforeLen = getErrorLog().length;
    logError("test error", "stack trace");
    const log = getErrorLog();
    expect(log.length).toBe(beforeLen + 1);
    expect(log[log.length - 1].message).toBe("test error");
    expect(log[log.length - 1].stack).toBe("stack trace");
  });
});
