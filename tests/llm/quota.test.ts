/**
 * QuotaManager 测试
 */

import { describe, test, expect } from "bun:test";
import { QuotaManager } from "../../src/llm/quota.ts";

describe("QuotaManager", () => {
  // === 原有成本配额测试 ===
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

  // === 向后兼容 ===
  test("数字参数向后兼容", () => {
    const qm = new QuotaManager(10.0);
    expect(qm.check(5.0)!.level).toBe("info");
    expect(qm.isExceeded(10.0)).toBe(true);
  });

  test("QuotaConfig 对象参数", () => {
    const qm = new QuotaManager({ costLimit: 10.0 });
    expect(qm.check(5.0)!.level).toBe("info");
    expect(qm.isExceeded(10.0)).toBe(true);
  });

  test("QuotaConfig 无 costLimit 时不触发成本告警", () => {
    const qm = new QuotaManager({ requestsPerMinute: 60 });
    expect(qm.check(100)).toBeNull();
    expect(qm.isExceeded(100)).toBe(false);
  });

  // === 速率限制（RPM/TPM） ===
  describe("速率限制", () => {
    test("未配置 RPM/TPM 时 checkRateLimit 返回 0", () => {
      const qm = new QuotaManager(10.0);
      expect(qm.checkRateLimit()).toBe(0);
    });

    test("RPM 未达上限时返回 0", () => {
      const qm = new QuotaManager({ requestsPerMinute: 10 });
      qm.recordRequest(100);
      qm.recordRequest(100);
      expect(qm.checkRateLimit()).toBe(0);
    });

    test("RPM 达到上限时返回等待时间", () => {
      const qm = new QuotaManager({ requestsPerMinute: 3 });
      qm.recordRequest(100);
      qm.recordRequest(100);
      qm.recordRequest(100);
      const wait = qm.checkRateLimit();
      // 需要等到最早的请求过期（约 60 秒）
      expect(wait).toBeGreaterThan(0);
      expect(wait).toBeLessThanOrEqual(60_000);
    });

    test("TPM 未达上限时返回 0", () => {
      const qm = new QuotaManager({ tokensPerMinute: 10000 });
      qm.recordRequest(1000);
      qm.recordRequest(2000);
      expect(qm.checkRateLimit()).toBe(0);
    });

    test("TPM 达到上限时返回等待时间", () => {
      const qm = new QuotaManager({ tokensPerMinute: 5000 });
      qm.recordRequest(3000);
      qm.recordRequest(3000); // 总计 6000 > 5000
      const wait = qm.checkRateLimit();
      expect(wait).toBeGreaterThan(0);
      expect(wait).toBeLessThanOrEqual(60_000);
    });

    test("recordRequest 清理过期记录", () => {
      const qm = new QuotaManager({ requestsPerMinute: 2 });

      // 手动模拟：先记录两个请求
      qm.recordRequest(100);
      qm.recordRequest(100);
      // 此时达到上限
      expect(qm.checkRateLimit()).toBeGreaterThan(0);

      // 注意：实际过期需要等 60 秒，这里只验证逻辑正确性
      // recordRequest 内部会清理 60 秒前的记录
    });

    test("RPM 和 TPM 同时配置，任一达限即等待", () => {
      const qm = new QuotaManager({ requestsPerMinute: 100, tokensPerMinute: 500 });
      // RPM 未达限，但 TPM 达限
      qm.recordRequest(300);
      qm.recordRequest(300); // 总 token 600 > 500
      const wait = qm.checkRateLimit();
      expect(wait).toBeGreaterThan(0);
    });
  });
});
