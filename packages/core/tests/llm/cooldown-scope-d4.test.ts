/**
 * D4 回归门禁 —— 限流冷却必须按**账户**共享，而不是按模型名各自为战。
 *
 * 修复前：`ModelAvailabilityService` 的冷却表 key 是裸模型名。同一个端点 + 同一份
 * 凭据下，模型 A 撞了 429 写下的冷却，模型 B 读不到，于是 B 立刻再撞一次——
 * 配额是账户级资源，按模型记等于把一次服务端表态浪费掉。
 *
 * 反向边界同样要守住：拿不到可靠 scope（provider 未实现 `quotaScope()`）时必须
 * **回落**模型维度，不能把两个账户的限流窗口混成一个，也不能干脆不写冷却。
 *
 * fix_type: regression_guard
 */

import { describe, test, expect } from "bun:test";
import { ModelAvailabilityService } from "@sid-code/core/llm/availability.ts";
import type { CooldownCause } from "@sid-code/core/llm/cooldown-probe.ts";
import type { QuotaScope } from "@sid-code/core/llm/quota-scope.ts";

const RATE_LIMIT: CooldownCause = "rate_limit";

function makeScope(endpoint = "https://gw.example.com/v1", credential = "fp-1"): QuotaScope {
  return { endpoint, credential };
}

describe("D4：冷却按账户 scope 共享", () => {
  test("同一 scope 下：模型 A 撞的 429，模型 B 能读到", () => {
    const a = new ModelAvailabilityService();
    const scope = makeScope();
    a.markRateLimited("model-a", 10_000, "429", RATE_LIMIT, scope);
    expect(a.getCooldownRemaining("model-b", scope)).toBeGreaterThan(0);
    expect(a.getCooldownInfo("model-b", scope)?.reason).toBe("429");
  });

  test("不同 scope 之间不共享（不同账户不该互相拖累）", () => {
    const a = new ModelAvailabilityService();
    a.markRateLimited(
      "model-a",
      10_000,
      "429",
      RATE_LIMIT,
      makeScope("https://gw.example.com/v1", "fp-1"),
    );
    expect(a.getCooldownRemaining("model-b", makeScope("https://gw.example.com/v1", "fp-2"))).toBe(
      0,
    );
    expect(
      a.getCooldownRemaining("model-b", makeScope("https://other.example.com/v1", "fp-1")),
    ).toBe(0);
  });

  test("scope 缺失时回落裸模型名：A 不影响 B", () => {
    const a = new ModelAvailabilityService();
    a.markRateLimited("model-a", 10_000, "429", RATE_LIMIT);
    expect(a.getCooldownRemaining("model-a")).toBeGreaterThan(0);
    expect(a.getCooldownRemaining("model-b")).toBe(0);
  });

  test("`scope:` 与 `model:` 两种 key 形态永不撞车", () => {
    const a = new ModelAvailabilityService();
    const scope = makeScope();
    a.markRateLimited("model-a", 10_000, "429", RATE_LIMIT, scope);
    // 同一个模型名，带 scope 与不带 scope 是两条独立记录
    expect(a.getCooldownRemaining("model-a", scope)).toBeGreaterThan(0);
    expect(a.getCooldownRemaining("model-a")).toBe(0);
  });

  test("成功产出清除冷却时，同账户所有模型一起解除", () => {
    const a = new ModelAvailabilityService();
    const scope = makeScope();
    a.markRateLimited("model-a", 10_000, "429", RATE_LIMIT, scope);
    a.clearCooldown("model-b", scope);
    expect(a.getCooldownRemaining("model-a", scope)).toBe(0);
  });

  test("探针配额按账户共享：A 拿走之后 B 只能等", () => {
    const a = new ModelAvailabilityService();
    const scope = makeScope();
    a.markRateLimited("model-a", 10_000, "429", RATE_LIMIT, scope);
    const first = a.tryAcquireCooldownProbe("model-a", scope);
    const second = a.tryAcquireCooldownProbe("model-b", scope);
    expect(first.granted).toBe(true);
    expect(second.granted).toBe(false);
  });

  test("探针释放也按账户生效：A 归还后 B 可以拿", () => {
    const a = new ModelAvailabilityService();
    const scope = makeScope();
    a.markRateLimited("model-a", 10_000, "429", RATE_LIMIT, scope);
    expect(a.tryAcquireCooldownProbe("model-a", scope).granted).toBe(true);
    a.releaseCooldownProbe("model-a", scope);
    expect(a.tryAcquireCooldownProbe("model-b", scope).granted).toBe(true);
  });
});
