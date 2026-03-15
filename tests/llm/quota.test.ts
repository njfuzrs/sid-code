/**
 * QuotaManager 测试
 */

import { describe, test, expect } from "bun:test";
import { QuotaManager } from "../../src/llm/quota.ts";

describe("QuotaManager", () => {
  test("低于 50% 不触发告警", () => {
    const qm = new QuotaManager(10.0);
    expect(qm.check(4.0)).toBeNull();
  });

  test("50% 触发 info 告警", () => {
    const qm = new QuotaManager(10.0);
    const result = qm.check(5.0);
    expect(result).not.toBeNull();
    expect(result!.level).toBe("info");
    expect(result!.message).toContain("50%");
  });

  test("80% 触发 warning 告警", () => {
    const qm = new QuotaManager(10.0);
    const result = qm.check(8.0);
    expect(result).not.toBeNull();
    expect(result!.level).toBe("warning");
  });

  test("95% 触发 critical 告警", () => {
    const qm = new QuotaManager(10.0);
    const result = qm.check(9.5);
    expect(result).not.toBeNull();
    expect(result!.level).toBe("critical");
  });

  test("100% 触发 exceeded 告警", () => {
    const qm = new QuotaManager(10.0);
    const result = qm.check(10.0);
    expect(result).not.toBeNull();
    expect(result!.level).toBe("exceeded");
    expect(result!.message).toContain("自动停止");
  });

  test("超过 100% 也触发 exceeded", () => {
    const qm = new QuotaManager(5.0);
    const result = qm.check(6.0);
    expect(result).not.toBeNull();
    expect(result!.level).toBe("exceeded");
  });

  test("同级别不重复告警", () => {
    const qm = new QuotaManager(10.0);
    // 第一次 50% → info
    const r1 = qm.check(5.0);
    expect(r1).not.toBeNull();
    expect(r1!.level).toBe("info");

    // 第二次 55% → 仍是 info 级别，不重复
    const r2 = qm.check(5.5);
    expect(r2).toBeNull();
  });

  test("级别升级时触发新告警", () => {
    const qm = new QuotaManager(10.0);
    // 50% → info
    const r1 = qm.check(5.0);
    expect(r1!.level).toBe("info");

    // 80% → warning（升级）
    const r2 = qm.check(8.0);
    expect(r2).not.toBeNull();
    expect(r2!.level).toBe("warning");

    // 95% → critical（升级）
    const r3 = qm.check(9.5);
    expect(r3).not.toBeNull();
    expect(r3!.level).toBe("critical");
  });

  test("isExceeded 正确判断", () => {
    const qm = new QuotaManager(5.0);
    expect(qm.isExceeded(4.99)).toBe(false);
    expect(qm.isExceeded(5.0)).toBe(true);
    expect(qm.isExceeded(6.0)).toBe(true);
  });

  test("costLimit 为 0 时不触发", () => {
    const qm = new QuotaManager(0);
    expect(qm.check(100)).toBeNull();
    expect(qm.isExceeded(100)).toBe(false);
  });

  test("告警消息包含金额信息", () => {
    const qm = new QuotaManager(10.0);
    const result = qm.check(8.5);
    expect(result!.message).toContain("$8.5");
    expect(result!.message).toContain("$10.00");
  });
});
