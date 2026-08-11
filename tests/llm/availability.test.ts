/**
 * 模型可用性服务测试
 * Task 2：状态机转换（healthy → retry_once → terminal）、resetTurn() 行为
 */

import { describe, test, expect } from "bun:test";
import { ModelAvailabilityService } from "@sid-code/core/llm/availability.ts";

describe("ModelAvailabilityService", () => {
  // === 基本状态 ===
  test("默认状态为 healthy（可用）", () => {
    const svc = new ModelAvailabilityService();
    expect(svc.isAvailable("model-a").available).toBe(true);
  });

  // === Terminal 状态 ===
  describe("terminal 状态", () => {
    test("markTerminal 后不可用", () => {
      const svc = new ModelAvailabilityService();
      svc.markTerminal("model-a", "auth_failed");
      const check = svc.isAvailable("model-a");
      expect(check.available).toBe(false);
      expect(check.reason).toBe("auth_failed");
    });

    test("terminal 状态不可被 markHealthy 恢复", () => {
      const svc = new ModelAvailabilityService();
      svc.markTerminal("model-a", "model_not_found");
      svc.markHealthy("model-a");
      expect(svc.isAvailable("model-a").available).toBe(false);
    });

    test("terminal 状态不可被 markRetryOnce 降级覆盖", () => {
      const svc = new ModelAvailabilityService();
      svc.markTerminal("model-a", "auth_failed");
      svc.markRetryOnce("model-a", "rate_limit");
      const check = svc.isAvailable("model-a");
      expect(check.available).toBe(false);
      expect(check.reason).toBe("auth_failed"); // 仍是 terminal 原因
    });

    test("terminal 不受 resetTurn 影响", () => {
      const svc = new ModelAvailabilityService();
      svc.markTerminal("model-a", "auth_failed");
      svc.resetTurn();
      expect(svc.isAvailable("model-a").available).toBe(false);
    });
  });

  // === retry_once 状态 ===
  describe("retry_once 状态", () => {
    test("第一次检查可用（消耗机会）", () => {
      const svc = new ModelAvailabilityService();
      svc.markRetryOnce("model-a", "rate_limit");
      expect(svc.isAvailable("model-a").available).toBe(true);
    });

    test("第二次检查不可用（机会已消耗）", () => {
      const svc = new ModelAvailabilityService();
      svc.markRetryOnce("model-a", "rate_limit");
      svc.isAvailable("model-a"); // 消耗
      const check = svc.isAvailable("model-a");
      expect(check.available).toBe(false);
      expect(check.reason).toBe("rate_limit");
    });

    test("resetTurn 重置 consumed 标记", () => {
      const svc = new ModelAvailabilityService();
      svc.markRetryOnce("model-a", "overloaded");
      svc.isAvailable("model-a"); // 消耗
      expect(svc.isAvailable("model-a").available).toBe(false);

      svc.resetTurn(); // 重置
      expect(svc.isAvailable("model-a").available).toBe(true); // 又有一次机会
    });

    test("markHealthy 可恢复 retry_once 状态", () => {
      const svc = new ModelAvailabilityService();
      svc.markRetryOnce("model-a", "rate_limit");
      svc.isAvailable("model-a"); // 消耗
      svc.markHealthy("model-a");
      expect(svc.isAvailable("model-a").available).toBe(true);
    });
  });

  // === 多模型隔离 ===
  test("不同模型状态互不影响", () => {
    const svc = new ModelAvailabilityService();
    svc.markTerminal("model-a", "auth_failed");
    svc.markRetryOnce("model-b", "rate_limit");

    expect(svc.isAvailable("model-a").available).toBe(false);
    expect(svc.isAvailable("model-b").available).toBe(true); // 第一次
    expect(svc.isAvailable("model-c").available).toBe(true); // 未标记
  });

  // === selectFirstAvailable ===
  describe("selectFirstAvailable", () => {
    test("返回第一个可用模型", () => {
      const svc = new ModelAvailabilityService();
      svc.markTerminal("model-a", "auth_failed");
      const result = svc.selectFirstAvailable(["model-a", "model-b", "model-c"]);
      expect("model" in result).toBe(true);
      expect((result as any).model).toBe("model-b");
    });

    test("所有模型不可用时返回 unavailable", () => {
      const svc = new ModelAvailabilityService();
      svc.markTerminal("model-a", "auth_failed");
      svc.markTerminal("model-b", "model_not_found");
      const result = svc.selectFirstAvailable(["model-a", "model-b"]);
      expect("unavailable" in result).toBe(true);
      expect((result as any).reason).toContain("不可用");
    });

    test("空列表返回 unavailable", () => {
      const svc = new ModelAvailabilityService();
      const result = svc.selectFirstAvailable([]);
      expect("unavailable" in result).toBe(true);
    });

    test("retry_once 模型在第一次选择时可用", () => {
      const svc = new ModelAvailabilityService();
      svc.markRetryOnce("model-a", "rate_limit");
      const result = svc.selectFirstAvailable(["model-a", "model-b"]);
      expect((result as any).model).toBe("model-a");
    });
  });

  // === resetTurn 批量重置 ===
  test("resetTurn 重置所有 retry_once 模型", () => {
    const svc = new ModelAvailabilityService();
    svc.markRetryOnce("model-a", "rate_limit");
    svc.markRetryOnce("model-b", "overloaded");

    // 消耗两个模型的机会
    svc.isAvailable("model-a");
    svc.isAvailable("model-b");
    expect(svc.isAvailable("model-a").available).toBe(false);
    expect(svc.isAvailable("model-b").available).toBe(false);

    // 重置
    svc.resetTurn();
    expect(svc.isAvailable("model-a").available).toBe(true);
    expect(svc.isAvailable("model-b").available).toBe(true);
  });
});
