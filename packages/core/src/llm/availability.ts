/**
 * 模型可用性服务
 * 三态健康管理（healthy/retry_once/terminal），避免反复请求已知不可用的模型
 */

import {
  type CooldownCause,
  shouldAllowCooldownProbeForReason,
  shouldUseTransientCooldownProbeSlot,
} from "./cooldown-probe.ts";

/** 模型健康状态 */
type HealthState =
  | { status: "healthy" }
  | { status: "retry_once"; reason: string; consumed: boolean } // 本轮只允许重试一次
  | { status: "terminal"; reason: string }; // 永久不可用

/** S2：共享限流冷却记录。 */
interface RateLimitCooldown {
  /** 冷却截止时刻（`Date.now()` 轴毫秒）。 */
  until: number;
  /** 触发冷却的模型侧原因（写进日志/遥测，便于回答"谁先撞的"）。 */
  reason: string;
  /** 本模型累计被标记限流的次数（仅用于观测，不参与决策）。 */
  hits: number;
  /**
   * S5：结构化的冷却成因（驱动探针判定）。
   *
   * 与 `reason` 并存而不是替换它：`reason` 是**错误原文**（`classified.message`，
   * 进日志给人看），本字段是**闭合词表**（进判定给代码看）。压成一个字段就得靠
   * 子串匹配去判定——正是这个仓反复在修的「用粗糙代理代替真实信号」。
   * 可选：老调用点不传时探针一律不放行（fail-closed，见 tryAcquireCooldownProbe）。
   */
  cause?: CooldownCause;
  /**
   * S5：本冷却窗口的**跨路径共享**探针配额是否已被消耗。
   *
   * 为什么配额挂在**冷却记录**上而不是服务实例上：配额的生命周期必须与冷却窗口
   * 严格同生共死。挂实例上就得自己管"什么时候重置"，而那个重置时机恰好是
   * 冷却过期——于是又要写一份同样的过期逻辑，两份必然漂移。挂记录上则
   * `getCooldownRemaining` 里已有的那句 `delete` 顺带就把配额清了：
   * **一个冷却窗口一发探针**这条不变量由数据结构本身保证，不靠调用方自觉。
   *
   * 注意 `markRateLimited` 续期时**刻意不重置它**：又撞一次限流是"窗口还在"的证据，
   * 重置等于每来一次 429 就补发一张探针券，那就退回"各路各探一发"的放大形态。
   */
  probeConsumed: boolean;
}

/**
 * S5：探针申请的结果。
 *
 * `granted=false` 时调用方照旧等冷却（**行为与本特性上线前逐字节相同**）——
 * 探针是给冷却开一个出口，不是给它加一道新的拦截。
 */
export interface CooldownProbeDecision {
  /** 是否放行本路径立刻发起探针请求（跳过冷却等待）。 */
  granted: boolean;
  /**
   * 本次放行是否消耗了**共享**配额。
   *
   * `granted && !usedSharedSlot` 是合法组合：`timeout` / `network_error` 这类
   * 单路径成因各路径各自探，不占共享配额（见 `shouldUseTransientCooldownProbeSlot`）。
   * 调用方**只在本字段为 true 时**才需要在失败后考虑发还配额。
   */
  usedSharedSlot: boolean;
  /** 拒绝/放行的归因（进遥测与日志，回答"为什么这一路探了/没探"）。 */
  reason: "granted" | "granted_unshared" | "no_cooldown" | "slot_taken" | "cause_not_probeable";
}

/**
 * S2 冷却等待的硬上限（毫秒）。
 *
 * 为什么必须有上限：冷却是**别人**告诉我们的信息，而 `Retry-After` 由服务端控制。
 * 若网关回一个 `Retry-After: 3600`，无上限就会让所有并发子代理集体睡一小时——
 * 那比"各自撞一次限流"糟得多。上限取 30s：够盖住绝大多数瞬时限流窗口，
 * 又不至于让任何一路把自己的时间预算睡穿。超过上限的部分交回各自的重试退避处理。
 */
export const MAX_COOLDOWN_WAIT_MS = 30_000;

/**
 * S2 冷却的**下限**（毫秒）。
 *
 * 为什么需要下限（由门槛断言逼出来的真问题）：冷却时长取自调用方的退避估计
 * （`delayMs`），而退避在某些配置下会非常小。实测一个 1ms 的冷却等于**没有冷却**——
 * 写进去的瞬间就过期，别的并发路径根本读不到，S2 静默退化成 CC 语义。
 *
 * 500ms 的依据：它要大于"另一路从写入到读取之间的调度间隔"，冷却才算是一个能被
 * 观察到的信号；又足够小，不给正常路径添可感知的延迟。
 *
 * 注意这个下限只影响"冷却存在多久"，不影响任何一路**实际等多久**——后者仍由
 * 各自的退避与错峰决定。
 */
export const MIN_COOLDOWN_MS = 500;

export class ModelAvailabilityService {
  private states = new Map<string, HealthState>();
  /** S2：模型 → 共享限流冷却。与 `states` 分开存，因为语义正交：
   *  `states` 答"这模型还能不能用"，本表答"现在该不该缓一缓再发"。 */
  private cooldowns = new Map<string, RateLimitCooldown>();

  /** 标记模型为永久不可用（认证失败、模型不存在） */
  markTerminal(model: string, reason: string): void {
    this.states.set(model, { status: "terminal", reason });
  }

  /** 标记模型为"本轮重试一次"（限流、过载） */
  markRetryOnce(model: string, reason: string): void {
    const current = this.states.get(model);
    // terminal 状态不会被降级覆盖
    if (current?.status === "terminal") return;
    this.states.set(model, { status: "retry_once", reason, consumed: false });
  }

  /**
   * 标记模型恢复健康。
   *
   * @param force 是否强制清除 terminal 态（默认 false）。
   *   - false（默认）：保持旧语义，terminal 不可被自动流程恢复（避免一次瞬时成功就抹掉
   *     "模型不存在/认证失败"这类硬故障判定）。
   *   - true：强制清除，用于「用户显式切入该模型」「降级流确实产出内容」等携带明确正向信号的
   *     场景。H2 死锁根治：terminal 是进程内永久态，而 terminal 模型开头 isAvailable 就被拦、
   *     永远走不到主路径的 markHealthy 清除点 → 结构性死锁；用户 /model 切回被拉黑的模型也用不了。
   *     给用户主动选择 / 成功产出一次干净机会，清除 terminal。
   */
  markHealthy(model: string, force = false): void {
    const current = this.states.get(model);
    // terminal 状态默认不可恢复；仅在 force（用户显式切入 / 成功产出）时强制清除。
    if (current?.status === "terminal" && !force) return;
    this.states.delete(model);
  }

  /** 查询模型是否处于 terminal（永久不可用）态。供切模型选项置灰/标注用（H2）。 */
  isTerminal(model: string): boolean {
    return this.states.get(model)?.status === "terminal";
  }

  /** 检查模型是否可用（消耗 retry_once 的一次机会） */
  isAvailable(model: string): { available: boolean; reason?: string } {
    const state = this.states.get(model);
    if (!state || state.status === "healthy") {
      return { available: true };
    }
    if (state.status === "terminal") {
      return { available: false, reason: state.reason };
    }
    // retry_once：第一次允许，第二次拒绝
    if (!state.consumed) {
      state.consumed = true;
      return { available: true };
    }
    return { available: false, reason: state.reason };
  }

  // ═══════════════════════════════════════════════════════════════════
  // S2：跨调用方共享的限流冷却信号（明确超越 claude-code）
  // ═══════════════════════════════════════════════════════════════════
  //
  // ── 我们在解决 CC 承认但没解决的问题 ──
  //
  // CC 的重试是**逐调用独立**的：N 个并发 agent 撞同一个限流，就各自独立退避、
  // 各自重试。它自己的注释承认这点（"each retry is 3-10x gateway amplification"），
  // 但跨 agent 零协调——因为它没有一个天然的共享位置。
  //
  // 我们有：`ModelAvailabilityService` 本来就是**刻意跨路径共享**的那一个对象
  // （`resilient-stream.ts` 注释写明"共享该共享的，隔离该隔离的"，availability
  // 正是那个"该共享的"）。所以这不是新盖一层基础设施，是给既有共享层加一个字段。
  //
  // ── 机制 ──
  //
  // 一路撞 429 → `markRateLimited(model, retryAfterMs)` 写下冷却截止时刻；
  // 其余并发路径**发请求前**读 `getCooldownRemaining(model)`，有剩余就先等这段。
  // 效果：从"6 路并发各自撞一次限流、各自退避"变成"1 路撞、其余延迟起跑"。
  //
  // ── 代价（诚实记账，对应北极星的内部张力）──
  //
  // 这是**用延迟换限流级联下的成功率**：没有限流时零影响（冷却表空），
  // 有限流时其余路径会多等最多 30s。代价记在"更快"上，收益在"更省"
  // （少发注定被拒的请求）与"更稳"。判据是我们**测得出来**（见 S2 门槛对比实验）。

  /**
   * S2：标记模型正在被限流，写下共享冷却截止时刻。
   *
   * @param model 被限流的模型
   * @param retryAfterMs 服务端建议的等待时长（`Retry-After` / `rate-limit-reset` 解析结果）。
   *   缺省时用一个保守的短冷却（2s）——**宁可短也不要没有**：我们不知道窗口多长，
   *   但"别在同一毫秒再打一发"这件事本身就有价值。
   * @param reason 归因文本，进日志与遥测。
   */
  markRateLimited(
    model: string,
    retryAfterMs?: number,
    reason = "rate_limit",
    cause?: CooldownCause,
  ): void {
    // 双向钳制：下限保证冷却是个**能被别人读到**的信号（1ms 冷却等于没有冷却，
    // 见 MIN_COOLDOWN_MS 注释）；上限防止服务端一个超长 Retry-After 让全部并发
    // 路径集体长睡。
    const wait = Math.min(Math.max(retryAfterMs ?? 2_000, MIN_COOLDOWN_MS), MAX_COOLDOWN_WAIT_MS);
    const until = Date.now() + wait;
    const prev = this.cooldowns.get(model);
    // 取**更晚**的截止时刻：多路先后撞限流时，冷却应该只延长不缩短——
    // 否则后撞的那一路（可能拿到更短的 Retry-After）会把前面更长的冷却抹掉。
    this.cooldowns.set(model, {
      until: prev && prev.until > until ? prev.until : until,
      reason,
      hits: (prev?.hits ?? 0) + 1,
      cause: cause ?? prev?.cause,
      // S5：续期**不**补发探针券。又撞一次 429 是"窗口还在"的证据，不是新窗口；
      // 每次 429 都重置配额 = 每路各探一发，退回 S2 要消灭的放大形态。
      probeConsumed: prev?.probeConsumed ?? false,
    });
  }

  // ═══════════════════════════════════════════════════════════════════
  // S5：冷却探针配额（移植自 openclaw failover-policy 的三个判定）
  // ═══════════════════════════════════════════════════════════════════
  //
  // 补的洞：S2 的冷却只有两条出口——自然到期，或该模型**成功产出一次**
  // （clearCooldown）。而全部路径都在守冷却时没人去发那一发，第二条出口结构性
  // 走不到。于是一个偏保守的 Retry-After 会被完整睡满，S2 从"更省"变成纯"更慢"。
  //
  // 探针放一路先走、其余照旧等：成功则 clearCooldown 一次解放所有路径；
  // 失败只烧掉一发请求。判定逻辑全在 cooldown-probe.ts（纯函数，可穷举单测），
  // 这里只持配额状态。

  /**
   * S5：申请本冷却窗口的探针资格。**有副作用**（消耗共享配额），故名 `try*`。
   *
   * 三层判定，任一不过就照旧等冷却：
   * ① 无冷却 → 无需探针（`no_cooldown`，调用方本来就会直接发）；
   * ② 成因不值得探 → 拒（`cause_not_probeable`）；
   * ③ 共享配额已被别人拿走 → 拒（`slot_taken`）。
   *
   * **fail-closed 的两处，都是刻意的**：
   * - `cause` 缺省（老调用点没传）→ 判定 ① 收到 `undefined` 返回 false → 不放行。
   *   宁可退回"老实等冷却"（= 上线前行为），也不要在不知道成因时打真实请求。
   * - 判定 ② 返回 false（单路径成因）→ 放行但**不**占共享配额，
   *   于是各路径各自探。这不是漏洞：那类成因本就不构成跨路径放大。
   */
  tryAcquireCooldownProbe(model: string): CooldownProbeDecision {
    const cd = this.cooldowns.get(model);
    // 用 getCooldownRemaining 而非直接读 until：它顺带清理过期记录，
    // 避免这里自己再写一份过期判断（两份必然漂移）。
    if (!cd || this.getCooldownRemaining(model) <= 0) {
      return { granted: false, usedSharedSlot: false, reason: "no_cooldown" };
    }
    if (!shouldAllowCooldownProbeForReason(cd.cause)) {
      return { granted: false, usedSharedSlot: false, reason: "cause_not_probeable" };
    }
    if (!shouldUseTransientCooldownProbeSlot(cd.cause)) {
      // 单路径成因（timeout / network_error）：放行且不占共享配额。
      return { granted: true, usedSharedSlot: false, reason: "granted_unshared" };
    }
    if (cd.probeConsumed) {
      return { granted: false, usedSharedSlot: false, reason: "slot_taken" };
    }
    cd.probeConsumed = true;
    return { granted: true, usedSharedSlot: true, reason: "granted" };
  }

  /**
   * S5：把探针配额还回去（探针死于**与配额窗口无关**的故障时调用）。
   *
   * 判据在 `shouldPreserveTransientCooldownProbeSlot`：401 / 模型不存在这类"敲错门"
   * 对"限流窗口过了没有"一个字都没回答，让它吃掉窗口里唯一的探针机会，
   * 等于一次无关故障把 S2 的出口锁死一整个窗口。
   *
   * 幂等且对已过期冷却无副作用（记录已被清理时是空操作）——探针失败路径可能
   * 与冷却自然到期竞争，这里不该因此抛错。
   */
  releaseCooldownProbe(model: string): void {
    const cd = this.cooldowns.get(model);
    if (!cd) return;
    cd.probeConsumed = false;
  }

  /** S5：读探针配额是否已被消耗（测试与遥测归因用；无冷却记录返回 false）。 */
  isCooldownProbeConsumed(model: string): boolean {
    return this.cooldowns.get(model)?.probeConsumed ?? false;
  }

  /**
   * S2：查询模型还需冷却多久（毫秒）。0 表示无需等待。
   *
   * 顺带清理已过期的记录：冷却是短时信号，过期即无意义，留着只会让这张表随
   * 长会话单调增长（模型数量有限，但没必要留垃圾）。
   */
  getCooldownRemaining(model: string): number {
    const cd = this.cooldowns.get(model);
    if (!cd) return 0;
    const remaining = cd.until - Date.now();
    if (remaining <= 0) {
      this.cooldowns.delete(model);
      return 0;
    }
    return remaining;
  }

  /** S2：读冷却归因（供日志/遥测说明"为什么在等"）。无冷却返回 undefined。 */
  getCooldownInfo(
    model: string,
  ): { remainingMs: number; reason: string; hits: number; cause?: CooldownCause } | undefined {
    const cd = this.cooldowns.get(model);
    if (!cd) return undefined;
    const remainingMs = cd.until - Date.now();
    if (remainingMs <= 0) return undefined;
    return { remainingMs, reason: cd.reason, hits: cd.hits, cause: cd.cause };
  }

  /** S2：清除某模型的冷却（该模型成功产出内容时调用——限流窗口已过的最强信号）。 */
  clearCooldown(model: string): void {
    this.cooldowns.delete(model);
  }

  /** 新一轮对话开始时重置 retry_once 的 consumed 标记 */
  resetTurn(): void {
    for (const state of this.states.values()) {
      if (state.status === "retry_once") {
        state.consumed = false;
      }
    }
  }

  /** 从候选模型列表中选择第一个可用的 */
  selectFirstAvailable(
    models: string[],
  ): { model: string } | { unavailable: true; reason: string } {
    for (const model of models) {
      const check = this.isAvailable(model);
      if (check.available) return { model };
    }
    return { unavailable: true, reason: "所有候选模型均不可用" };
  }
}
