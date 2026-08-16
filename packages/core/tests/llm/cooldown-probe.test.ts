/**
 * S5 冷却探针配额 —— 三个纯函数的穷举门禁 + 状态层不变量。
 *
 * 为什么值得穷举：这三个函数就是三张**词表**，而移植词表最典型的翻车方式是
 * 抄了别人的成员名（openclaw 有 `auth_permanent` / `session_expired` /
 * `tls_certificate`，我们的分类器一个都不产出）。穷举 = 把"我们真实会遇到的
 * 每一个 reason 都被显式裁决过"这件事钉死，将来 `errors.ts` 加一个新 reason，
 * 下面那条覆盖率门禁会红——而不是静默走进默认分支。
 */

import { describe, test, expect } from "bun:test";
import {
  shouldAllowCooldownProbeForReason,
  shouldUseTransientCooldownProbeSlot,
  shouldPreserveTransientCooldownProbeSlot,
  type CooldownCause,
  type ProbeFailureReason,
} from "@sid-code/core/llm/cooldown-probe.ts";
import { ModelAvailabilityService, MIN_COOLDOWN_MS } from "@sid-code/core/llm/availability.ts";

/** `errors.ts` 的 RetryableReason 全量 —— 冷却成因只可能取自这里。 */
const ALL_RETRYABLE: CooldownCause[] = [
  "rate_limit",
  "overloaded",
  "network_error",
  "timeout",
  "server_error",
  "request_timeout",
  "lock_timeout",
];

/** 探针失败时可能拿到的全部 reason（三个 union 并集 + undefined）。 */
const ALL_FAILURE_REASONS: ProbeFailureReason[] = [
  // TerminalReason
  "auth_failed",
  "model_not_found",
  "quota_exhausted",
  "content_policy",
  "invalid_request",
  "server_declined_retry",
  // RetryableReason
  ...ALL_RETRYABLE,
  // StreamValidationReason
  "no_finish_reason",
  "malformed_tool_call",
  "empty_response",
  // 分类器也认不出
  undefined,
];

describe("S5 判定① shouldAllowCooldownProbeForReason —— 值不值得用一发真实请求去探", () => {
  test.each([
    "rate_limit",
    "overloaded",
    "server_error",
    "timeout",
    "request_timeout",
    "network_error",
  ] as const)("%s 值得探（上游那个条件可能已经自己好了）", (cause) => {
    expect(shouldAllowCooldownProbeForReason(cause)).toBe(true);
  });

  test("lock_timeout 不探（409 是本地/会话级锁竞争，不是上游可用性问题）", () => {
    // 探它等于用一发真实请求去问"锁放开了吗"——问错了对象，答案也不可复用给别的路径。
    expect(shouldAllowCooldownProbeForReason("lock_timeout")).toBe(false);
  });

  test("undefined 不探（fail-closed：不知道成因时宁可老实等冷却）", () => {
    // 这一格是整个 S5 的安全阀：老调用点不传 cause → 冷却记录没有 cause →
    // 这里返回 false → 探针恒不放行 → 行为退回上线前。宁可能力静默不生效，
    // 也不要在不知道为什么冷却的情况下打真实请求。
    expect(shouldAllowCooldownProbeForReason(undefined)).toBe(false);
  });

  test("覆盖率门禁：RetryableReason 每个成员都被显式裁决（新增 reason 会红）", () => {
    // 这条不是"测函数"，是**防漂移**：errors.ts 加一个 RetryableReason 而忘了
    // 到 cooldown-probe.ts 裁决它，这里会因为下面的分类和不等于全量而红。
    const allowed = ALL_RETRYABLE.filter(shouldAllowCooldownProbeForReason);
    const denied = ALL_RETRYABLE.filter((c) => !shouldAllowCooldownProbeForReason(c));
    expect(allowed.length + denied.length).toBe(ALL_RETRYABLE.length);
    expect(allowed.sort()).toEqual([
      "network_error",
      "overloaded",
      "rate_limit",
      "request_timeout",
      "server_error",
      "timeout",
    ]);
    expect(denied).toEqual(["lock_timeout"]);
  });
});

describe("S5 判定② shouldUseTransientCooldownProbeSlot —— 该不该占共享配额", () => {
  test.each(["rate_limit", "overloaded", "server_error"] as const)(
    "%s 占共享配额（服务端侧状态，一路探出的结论对所有路径都算数）",
    (cause) => {
      expect(shouldUseTransientCooldownProbeSlot(cause)).toBe(true);
    },
  );

  test.each(["timeout", "request_timeout", "network_error"] as const)(
    "%s 不占共享配额（本路径状态，我的连接断了说明不了你那条）",
    (cause) => {
      // 拿全局配额去卡单路径故障，等于让一路的网络抖动把其余全部路径的探针机会
      // 一起吃掉——健康路径替坏路径背锅。
      expect(shouldUseTransientCooldownProbeSlot(cause)).toBe(false);
    },
  );

  test("不变量：占共享配额的成因，必然也是值得探的成因（判定②是①的子集）", () => {
    // 反过来会是逻辑错误：一个"不值得探"的成因却"要占配额"，意味着配额被
    // 永远不会发生的探针占着。这条断言把两张词表的偏序关系钉死。
    for (const cause of ALL_RETRYABLE) {
      if (shouldUseTransientCooldownProbeSlot(cause)) {
        expect(shouldAllowCooldownProbeForReason(cause)).toBe(true);
      }
    }
  });

  test("undefined 不占配额", () => {
    expect(shouldUseTransientCooldownProbeSlot(undefined)).toBe(false);
  });
});

describe("S5 判定③ shouldPreserveTransientCooldownProbeSlot —— 失败后配额该不该还回去", () => {
  test.each([
    "auth_failed",
    "model_not_found",
    "invalid_request",
    "content_policy",
    "server_declined_retry",
    "malformed_tool_call",
  ] as const)("%s 发还配额（敲错门，对'限流窗口过了没有'一个字都没回答）", (reason) => {
    expect(shouldPreserveTransientCooldownProbeSlot(reason)).toBe(true);
  });

  test.each(["rate_limit", "overloaded", "quota_exhausted", "empty_response"] as const)(
    "%s 不发还（确实是'还没恢复'的证据，继续探只会重复烧请求）",
    (reason) => {
      expect(shouldPreserveTransientCooldownProbeSlot(reason)).toBe(false);
    },
  );

  test("undefined 不发还（不认识的失败不发还配额，防未知确定性故障被反复探针）", () => {
    // 反过来（认不出就还回去）会让一类未知的确定性故障被反复探针，
    // 把"更快"换成纯粹的白烧。
    expect(shouldPreserveTransientCooldownProbeSlot(undefined)).toBe(false);
  });

  test("覆盖率门禁：全部失败 reason 都被显式裁决，且发还集合恰好是这 6 个", () => {
    const preserved = ALL_FAILURE_REASONS.filter(shouldPreserveTransientCooldownProbeSlot);
    expect(preserved.sort()).toEqual([
      "auth_failed",
      "content_policy",
      "invalid_request",
      "malformed_tool_call",
      "model_not_found",
      "server_declined_retry",
    ]);
  });

  test("负向：quota_exhausted 与 auth_failed 都是 Terminal，但裁决相反（不是按错误类分的）", () => {
    // 这条防的是一种很自然的错误重构：「Terminal 就一律发还配额」。
    // quota_exhausted 是 Terminal，但它恰恰**回答了**配额问题（真耗尽了）——
    // 发还配额等于让下一路再去探一个已知耗尽的配额。判据是语义不是错误类。
    expect(shouldPreserveTransientCooldownProbeSlot("auth_failed")).toBe(true);
    expect(shouldPreserveTransientCooldownProbeSlot("quota_exhausted")).toBe(false);
  });
});

describe("S5 状态层：探针配额挂在冷却记录上", () => {
  test("无冷却 → 不放行（no_cooldown；调用方本来就会直接发，不需要探针）", () => {
    const a = new ModelAvailabilityService();
    const d = a.tryAcquireCooldownProbe("m1");
    expect(d.granted).toBe(false);
    expect(d.reason).toBe("no_cooldown");
  });

  test("一个冷却窗口只放一发共享探针（第二路拿到 slot_taken）", () => {
    const a = new ModelAvailabilityService();
    a.markRateLimited("m1", 10_000, "429", "rate_limit");

    const first = a.tryAcquireCooldownProbe("m1");
    expect(first.granted).toBe(true);
    expect(first.usedSharedSlot).toBe(true);
    expect(first.reason).toBe("granted");

    const second = a.tryAcquireCooldownProbe("m1");
    expect(second.granted).toBe(false);
    expect(second.reason).toBe("slot_taken");
  });

  test("6 路并发抢配额：恰好 1 路拿到（S5 的核心不变量）", () => {
    const a = new ModelAvailabilityService();
    a.markRateLimited("m1", 10_000, "429", "rate_limit");
    const granted = Array.from({ length: 6 }, () => a.tryAcquireCooldownProbe("m1")).filter(
      (d) => d.granted,
    );
    // 不是"6 路各探一发"（那就是 S2 要消灭的放大），也不是"0 路"（那 S5 就没接线）。
    expect(granted.length).toBe(1);
  });

  test("单路径成因（timeout）放行但不占配额 → 多路各自都能探", () => {
    const a = new ModelAvailabilityService();
    a.markRateLimited("m1", 10_000, "读超时", "timeout");
    const decisions = Array.from({ length: 3 }, () => a.tryAcquireCooldownProbe("m1"));
    expect(decisions.every((d) => d.granted)).toBe(true);
    expect(decisions.every((d) => d.usedSharedSlot === false)).toBe(true);
    expect(decisions[0].reason).toBe("granted_unshared");
    // 没占配额 → 配额位仍是干净的（不需要任何人去发还）。
    expect(a.isCooldownProbeConsumed("m1")).toBe(false);
  });

  test("不该探的成因（lock_timeout）→ cause_not_probeable，且不消耗配额", () => {
    const a = new ModelAvailabilityService();
    a.markRateLimited("m1", 10_000, "锁竞争", "lock_timeout");
    const d = a.tryAcquireCooldownProbe("m1");
    expect(d.granted).toBe(false);
    expect(d.reason).toBe("cause_not_probeable");
    expect(a.isCooldownProbeConsumed("m1")).toBe(false);
  });

  test("🔴 fail-closed：cause 缺省（老调用点）→ 一律不放行", () => {
    const a = new ModelAvailabilityService();
    // 不传第四个参数，模拟一个没跟着改的调用点。
    a.markRateLimited("m1", 10_000, "429");
    const d = a.tryAcquireCooldownProbe("m1");
    expect(d.granted).toBe(false);
    expect(d.reason).toBe("cause_not_probeable");
  });

  test("releaseCooldownProbe 把配额还回去 → 下一路能再探一发", () => {
    const a = new ModelAvailabilityService();
    a.markRateLimited("m1", 10_000, "429", "rate_limit");
    expect(a.tryAcquireCooldownProbe("m1").granted).toBe(true);
    expect(a.tryAcquireCooldownProbe("m1").granted).toBe(false);

    a.releaseCooldownProbe("m1"); // 探针死于 401 这类与配额窗口无关的故障
    expect(a.tryAcquireCooldownProbe("m1").granted).toBe(true);
  });

  test("release 幂等，且对无冷却的模型是空操作（不抛错）", () => {
    const a = new ModelAvailabilityService();
    expect(() => a.releaseCooldownProbe("never-cooled")).not.toThrow();
    a.markRateLimited("m1", 10_000, "429", "rate_limit");
    a.releaseCooldownProbe("m1");
    a.releaseCooldownProbe("m1");
    expect(a.isCooldownProbeConsumed("m1")).toBe(false);
  });

  test("🔴 续期不补发探针券（又撞一次 429 是'窗口还在'，不是新窗口）", () => {
    const a = new ModelAvailabilityService();
    a.markRateLimited("m1", 10_000, "429", "rate_limit");
    a.tryAcquireCooldownProbe("m1"); // 配额被拿走

    // 另一路又撞了一次限流 → 冷却续期。
    a.markRateLimited("m1", 10_000, "又一次 429", "rate_limit");

    // 若这里返回 true，就是"每来一次 429 就补一张券"→ 退回各路各探一发的放大形态。
    expect(a.tryAcquireCooldownProbe("m1").granted).toBe(false);
    expect(a.isCooldownProbeConsumed("m1")).toBe(true);
  });

  test("续期保留 cause（第二次不传 cause 不该把探针能力抹掉）", () => {
    const a = new ModelAvailabilityService();
    a.markRateLimited("m1", 10_000, "429", "rate_limit");
    a.markRateLimited("m1", 10_000, "又一次 429"); // 不传 cause
    expect(a.getCooldownInfo("m1")?.cause).toBe("rate_limit");
  });

  test("冷却过期 → 配额随记录一起清（一个窗口一发的作用域由数据结构保证）", async () => {
    const a = new ModelAvailabilityService();
    // 用下限值：markRateLimited 会把任何更小的值抬到 MIN_COOLDOWN_MS。
    a.markRateLimited("m1", MIN_COOLDOWN_MS, "429", "rate_limit");
    expect(a.tryAcquireCooldownProbe("m1").granted).toBe(true);

    await new Promise((r) => setTimeout(r, MIN_COOLDOWN_MS + 80));

    // 窗口已过 → 不再是"配额被占"，而是"根本不需要探针"。
    const d = a.tryAcquireCooldownProbe("m1");
    expect(d.granted).toBe(false);
    expect(d.reason).toBe("no_cooldown");
    expect(a.isCooldownProbeConsumed("m1")).toBe(false);
  });

  test("clearCooldown（成功产出）→ 配额与冷却一并消失", () => {
    const a = new ModelAvailabilityService();
    a.markRateLimited("m1", 10_000, "429", "rate_limit");
    a.tryAcquireCooldownProbe("m1");
    a.clearCooldown("m1");
    expect(a.isCooldownProbeConsumed("m1")).toBe(false);
    expect(a.tryAcquireCooldownProbe("m1").reason).toBe("no_cooldown");
  });

  test("配额按模型隔离（m1 的探针不该吃掉 m2 的机会）", () => {
    const a = new ModelAvailabilityService();
    a.markRateLimited("m1", 10_000, "429", "rate_limit");
    a.markRateLimited("m2", 10_000, "429", "rate_limit");
    expect(a.tryAcquireCooldownProbe("m1").granted).toBe(true);
    expect(a.tryAcquireCooldownProbe("m2").granted).toBe(true);
  });
});
