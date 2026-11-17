/**
 * G2（2026-11-16）：goal 的「等待挂起」判据
 *
 * 缺陷形态（20261116 的 S-goal-wait 形态，真实轨迹人工核过）：
 * 模型挂上 `bash --wait_until_seconds` / monitor 等 CI 之后 end_turn，Goal Gate 仍然
 * 调评估器 → 评估器只能看到「目标未达成」→ 注入「请继续推进」把模型打回下一轮。
 * 模型此刻唯一能做的事只有等，于是要么重复查询状态（正是 P1 守卫要拦的那件事），
 * 要么假装又推进了一轮。等待期就这样变成空转，每次打回还额外烧一次评估调用。
 *
 * ## 判据为什么是窄口径
 *
 * 用 `isDeclaredExternalWait`（monitor / wakeup / 带 `wait_until` 的 shell），
 * 刻意**不是** `hasPromisedWait`：派生出来的子代理 / workflow / 普通后台 shell 承诺的是
 * 「**自己**结束时会回报」，那是「模型在等自己派出去的东西」，不是「目标在等外部状态」。
 * 拿宽口径判，一次无关的 `bun test &` 就能让 goal 永远不评估（同 D12 的教训，
 * 见 `task/wait-registry.ts` 的 `isDeclaredExternalWait` 注释）。
 *
 * ## 为什么还要一个连续放行上限
 *
 * 只放行不回收，会开出一条绕过评估的旁路：挂一个永远不会 fire 的等待源（或一个用户
 * 早就删掉的 monitor）+ 反复 end_turn，评估器一次都不会被调用，「连续 N 轮相同 blockerKey」
 * 的 blocked 检测也就形同失效。所以按「同一类等待源」数连续放行次数，到顶就回到评估器。
 * 换类（等待类型集合变了，如 monitor → wakeup）与等待源全部释放都会让计数从 0 起算
 * ——换一种等法是新的机会。
 *
 * 计数键为什么是**类型**而不是 id（2026-11-16 复核实证）：monitor / 唤醒的 id 由工具
 * 生成、天然唯一，模型每轮重挂一个新 monitor 就换了一组 id。用 id 当键时上限形同不存在
 * （实测连续换 10 个 id → 10 次全部放行，`waitPass` 每次都是 `count:1`），正好是本节
 * 开头要防的那条旁路。
 *
 * 本模块保持纯函数（不读 registry 单例、不写盘），四种组合可以直接单测。
 */

import type { GoalState, GoalWaitPass } from "../goal/state.ts";
import { isDeclaredExternalWait, type WaitSource } from "../task/index.ts";

/**
 * 同一组等待源连续放行 end_turn 的次数上限。
 *
 * 取 3 与 `goalConfig.blockedThreshold` 同值是有意的：两者都在回答「给模型几次机会」。
 * 刻意不做成配置项——它是防旁路的下限，不该被随手调高（D8：不加开关）。
 */
export const MAX_CONSECUTIVE_WAIT_PASSES = 3;

/** 只有待投递通知、没有登记等待源时的计数键（通知队列不为空本身也是「在等」）。 */
const PENDING_NOTIFICATION_KEY = "notification";

/** 判据需要的外部事实（由调用方现算后传入）。 */
export interface GoalWaitingFacts {
  /** 是否有模型**显式声明**的外部等待（`hasDeclaredExternalWait` 同一把尺子） */
  hasDeclaredExternalWait: boolean;
  /** 是否有待投递的后台通知（事件已经在队列里，下一轮马上就会开始） */
  hasPendingNotifications: boolean;
  /** 当前显式外部等待的 id（用于 `wait_ids` 回执与 trace，不参与计数键） */
  waitIds: string[];
  /**
   * 当前显式外部等待的**类型**集合（排序去重后）。
   *
   * 连续放行的计数键取类型而不是 id：id 由工具生成、天然唯一，模型每轮重挂一个新
   * monitor 就换了一组 id，拿 id 当键会让上限被无限绕过（实跑：换 10 个 id → 10 次
   * 全放行）。换**类型**（monitor → wakeup）才算新的一组等待。
   *
   * **必填而不是可选**：缺省会让手写 facts 的调用方静默退化成「通知占位键」，
   * 把「挂着 monitor」和「只有待投递通知」混成同一组计数，而且没有任何报错。
   */
  waitKinds: string[];
}

/** `collectGoalWaitingFacts` 的「无等待」缺省值：查询失败时用它，保持旧行为。 */
export const NO_GOAL_WAITING_FACTS: GoalWaitingFacts = {
  hasDeclaredExternalWait: false,
  hasPendingNotifications: false,
  waitIds: [],
  waitKinds: [],
};

/**
 * 从 `listWaits()` 的结果拼出判据事实。
 *
 * 单独成函数而不是在 loop.ts 里内联三行：窄口径 vs 宽口径是这个修复的核心判据，
 * 必须有一条单测能直接锁住「只挂普通后台 shell 时 hasDeclaredExternalWait 为 false」，
 * 不必为了构造一个 loop 才能验证它。
 */
export function collectGoalWaitingFacts(
  waits: readonly WaitSource[],
  pendingNotifications: boolean,
): GoalWaitingFacts {
  const declared = waits.filter(isDeclaredExternalWait);
  return {
    hasDeclaredExternalWait: declared.length > 0,
    hasPendingNotifications: pendingNotifications,
    waitIds: declared.map((w) => w.id),
    // 排序去重：同一类等待挂多个实例（两个 monitor 看同一个 PR）只算一类，
    // 枚举顺序不影响计数键。
    waitKinds: [...new Set(declared.map((w) => w.kind))].sort(),
  };
}

/** 本次 end_turn 是否该因等待而放行，以及记账要写回什么。 */
export interface WaitSuspendDecision {
  /** 是否因等待而放行（false = 交回原有的评估器路径） */
  release: boolean;
  /** 命中的等待源 id（`release=true` 时有值，进 trace 的 `wait_ids`） */
  waitIds: string[];
  /** 本次放行后该组等待源的连续放行次数（`release=true` 时有值） */
  count: number;
  /** 要写回 `goal.waitPass` 的值；`undefined` = 清零 */
  nextWaitPass?: GoalWaitPass;
  /**
   * 连续放行已到顶（C1，2026-11-17）：等待仍然活跃，但次数用尽，本次已落回评估器。
   *
   * 为什么要单独给一个字段：到顶此前与「无等待」共用 `release: false`，调用方无从区分，
   * 于是 `waiting` 事件只在放行时发射 —— 恰好是到顶这一轮没有任何 trace 可查，
   * 离线对账时看到的是「goal 在等，然后突然开始评估」，中间那一步缺失。
   */
  exhausted: boolean;
  /**
   * 本次「在等」的只是待投递通知、没有显式外部等待（C2）：trace 用
   * `wait_kind: "notification"` 区分，否则 `wait_ids` 为空的事件与字段缺失无法对账。
   */
  notificationOnly: boolean;
}

/**
 * 等待挂起判定 + 连续放行记账。
 *
 * 纯读 `goal.waitPass`，把要写回的值放在返回值里——写回由调用方做，`GoalState` 的
 * 写入点仍然集中在 goal-gate 一处。
 */
export function decideWaitSuspend(
  goal: GoalState,
  facts: GoalWaitingFacts | undefined,
): WaitSuspendDecision {
  const waitIds = facts ? [...facts.waitIds].sort() : [];
  const active = !!facts && (facts.hasDeclaredExternalWait || facts.hasPendingNotifications);
  // 「只是在等通知」：有在等的东西，但没有任何显式外部等待。与 `waitIds.length === 0`
  // 等价，但从 `facts` 直接读更贴近定义（`waitIds` 是排序后的投影）。
  // 显式写 `!!facts` 而不是复用 `active`：后者不构成类型窄化，`facts` 在这里仍是可选的。
  const notificationOnly =
    !!facts && facts.hasPendingNotifications && !facts.hasDeclaredExternalWait;
  if (!active) {
    // 等待源全部释放（或调用方没给事实）：清零，下一次挂新等待重新给满次数。
    return {
      release: false,
      waitIds: [],
      count: 0,
      nextWaitPass: undefined,
      exhausted: false,
      notificationOnly: false,
    };
  }

  // 换组即从 0 起算：key 由**排序去重后**的等待类型集合拼成，等待源的枚举顺序与
  // 实例数量都不影响判定（换实例不算新机会，换类型才算）。
  // 只有待投递通知时类型集合为空，用固定占位键（否则空串会让所有通知共享同一个键，
  // 分不清「同一批通知」还是「换了一批」——两者都该算新的一组）。
  const waitKinds = facts ? [...new Set(facts.waitKinds ?? [])].sort() : [];
  const key = waitKinds.length > 0 ? waitKinds.join("|") : PENDING_NOTIFICATION_KEY;
  const prev = goal.waitPass;
  const count = prev && prev.key === key ? prev.count : 0;

  if (count >= MAX_CONSECUTIVE_WAIT_PASSES) {
    // 到顶：不再放行，落回评估器。计数保持不动——之后每次 end_turn 都会评估，
    // 直到等待源释放（清零）或换组。这样「挂个等待就永远不评估」这条旁路不成立。
    //
    // `exhausted: true` 不是给判定用的，是给 trace 用的（C1）：这一轮既没放行、
    // 也就不会发 `waiting`，不补一条事件就只能看到「等待中」突然变成「评估中」。
    return {
      release: false,
      waitIds,
      count,
      nextWaitPass: prev,
      exhausted: true,
      notificationOnly,
    };
  }

  const nextCount = count + 1;
  return {
    release: true,
    waitIds,
    count: nextCount,
    nextWaitPass: { key, count: nextCount },
    exhausted: false,
    notificationOnly,
  };
}
