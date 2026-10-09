/**
 * 模型可用性服务测试
 *
 * 2026-10-08「一次判死」根治（设计 §4.3）：terminal 永久态与 retry_once 计数态合并为
 * **有时效的嫌疑态**（suspect）。以下是有意的语义变更，旧断言（terminal 不可被 markHealthy
 * 恢复、不受 resetTurn 影响、retry_once 第二次拒绝）钉的正是本设计要否决的行为：
 *   - 嫌疑带 `until`，过期自动视为健康；
 *   - 任何成功产出（markHealthy）都清嫌疑；
 *   - 主线程 / headless 不读嫌疑（I4）；
 *   - 其余调用方在嫌疑期内只放一路半开探针（保住 S1：并行子代理不一起撞坏模型）。
 */

import { describe, test, expect } from "bun:test";
import { ModelAvailabilityService } from "@sid-code/core/llm/availability.ts";

describe("ModelAvailabilityService", () => {
  test("默认状态为 healthy（可用）", () => {
    const svc = new ModelAvailabilityService();
    expect(svc.isAvailable("model-a").available).toBe(true);
    expect(svc.isSuspect("model-a")).toBe(false);
  });

  describe("suspect 嫌疑态", () => {
    test("markSuspect 后：第一路非主线程调用作为半开探针放行，其余拒绝", () => {
      const svc = new ModelAvailabilityService();
      svc.markSuspect("model-a", "fp1", "auth_suspect ×3 HTTP 401");
      const first = svc.isAvailable("model-a", "agent:builtin");
      expect(first.available).toBe(true);
      expect(first.probe).toBe(true);
      const second = svc.isAvailable("model-a", "agent:builtin");
      expect(second.available).toBe(false);
      expect(second.reason).toContain("auth_suspect ×3");
    });

    test("I4：主线程 / headless 不受嫌疑拦截（每次都放行，不消耗探针）", () => {
      const svc = new ModelAvailabilityService();
      svc.markSuspect("model-a", "fp1", "x");
      for (let i = 0; i < 3; i++) {
        expect(svc.isAvailable("model-a", "main_thread")).toEqual({ available: true });
        expect(svc.isAvailable("model-a", "headless")).toEqual({ available: true });
      }
      // 探针仍留给子代理
      expect(svc.isAvailable("model-a", "agent:builtin").probe).toBe(true);
    });

    test("顺序变体：side-call 先读 availability 不会消费主线程的放行", () => {
      const svc = new ModelAvailabilityService();
      svc.markSuspect("model-a", "fp1", "x");
      svc.isAvailable("model-a", "memory_recall"); // 探针
      svc.isAvailable("model-a", "memory_recall"); // 被拒
      expect(svc.isAvailable("model-a", "main_thread").available).toBe(true);
    });

    test("嫌疑过期自动视为健康（不再是进程内永久态）", () => {
      const svc = new ModelAvailabilityService();
      svc.markSuspect("model-a", "fp1", "x", 0);
      expect(svc.isSuspect("model-a")).toBe(false);
      expect(svc.isAvailable("model-a", "agent:builtin")).toEqual({ available: true });
    });

    test("markHealthy（成功产出）无条件清除嫌疑", () => {
      const svc = new ModelAvailabilityService();
      svc.markSuspect("model-a", "fp1", "x");
      svc.markHealthy("model-a");
      expect(svc.isSuspect("model-a")).toBe(false);
      expect(svc.isAvailable("model-a", "agent:builtin")).toEqual({ available: true });
    });

    test("续标（探针失败）刷新证据但不发还探针：串行子代理不能一个接一个去撞", () => {
      const svc = new ModelAvailabilityService();
      svc.markSuspect("model-a", "fp1", "first");
      svc.isAvailable("model-a", "agent:builtin"); // 探针被占
      svc.markSuspect("model-a", "fp2", "second"); // 探针失败后续标
      expect(svc.getSuspectInfo("model-a")?.evidence).toBe("second");
      expect(svc.isAvailable("model-a", "agent:builtin").available).toBe(false);
    });

    test("嫌疑过期后重新标记：给一张新探针", () => {
      const svc = new ModelAvailabilityService();
      svc.markSuspect("model-a", "fp1", "first", 0);
      svc.markSuspect("model-a", "fp2", "second");
      expect(svc.isAvailable("model-a", "agent:builtin").probe).toBe(true);
    });
  });

  test("不同模型状态互不影响", () => {
    const svc = new ModelAvailabilityService();
    svc.markSuspect("model-a", "fp", "x");
    svc.isAvailable("model-a", "agent:builtin"); // 探针
    expect(svc.isAvailable("model-a", "agent:builtin").available).toBe(false);
    expect(svc.isAvailable("model-b", "agent:builtin").available).toBe(true);
  });

  describe("selectFirstAvailable", () => {
    test("跳过嫌疑期且探针已被占用的模型", () => {
      const svc = new ModelAvailabilityService();
      svc.markSuspect("model-a", "fp", "x");
      svc.isAvailable("model-a", "agent:builtin"); // 探针
      const result = svc.selectFirstAvailable(["model-a", "model-b"], "agent:builtin");
      expect((result as { model: string }).model).toBe("model-b");
    });

    test("所有模型不可用时返回 unavailable", () => {
      const svc = new ModelAvailabilityService();
      for (const m of ["model-a", "model-b"]) {
        svc.markSuspect(m, "fp", "x");
        svc.isAvailable(m, "agent:builtin");
      }
      const result = svc.selectFirstAvailable(["model-a", "model-b"], "agent:builtin");
      expect("unavailable" in result).toBe(true);
      expect((result as { reason: string }).reason).toContain("不可用");
    });

    test("空列表返回 unavailable", () => {
      const svc = new ModelAvailabilityService();
      expect("unavailable" in svc.selectFirstAvailable([])).toBe(true);
    });
  });
});
