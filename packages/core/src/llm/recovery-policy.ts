/**
 * 恢复决策：分类只调预算，不判生死（2026-10-08「一次判死」根治，设计 §4.2）。
 *
 * **纯函数**：不读写 availability、不睡眠、不发请求。所有状态（历史、预算、冷却）由调用方
 * 作为入参传入，动作由调用方（`fallback.ts` 流式 catch 里的动作分派；状态写入只在放弃出口 `recordGiveUp`）唯一执行。
 * `tests/llm/recovery-single-exit.test.ts` 静态钉住「本文件零状态写入」。
 *
 * ── 判死的条件变了 ──
 *
 * 旧：认出某种文案 / 状态码 → 单次观测即判死（401/403/400/404 无条件 Terminal，
 *     认不出 → 零重试）。分类器必然漏认，漏认一次就是整轮判死。
 * 新：同一指纹在**有间隔的多次尝试**里一直复现 → 放弃本次调用（不跨轮拉黑）。
 *     分类器的准确度只影响「多花几秒还是少花几秒」，不再影响任务能不能活。
 *
 * ── I1：除闭集外，没有错误能在单次观测后结束本次调用 ──
 *
 * `I1_EXCEPTIONS` 是唯一能在 `attempts=1` 结束的闭集（用户中断在漏斗入口直接抛，不经过这里）。
 * 新增条目必须同步改 `recovery-invariants.test.ts`。
 */

import { isPromptTooLong } from "../api/errors.ts";
import type { ErrorFamily, FamilyVerdict, NormalizedLLMError } from "./error-normalize.ts";
import { classifyFamily } from "./error-normalize.ts";

/** 放弃原因闭集（进 `RecoveryGiveUp` 遥测；digest 的 one_shot_kill_count 据此排除 I1-例外） */
export type GiveUpReason =
  | "budget"
  | "same_fingerprint"
  | "per_call_cap"
  | "deadline"
  | "server_declined"
  | "background_529"
  | "local_fault"
  | "user_abort";

/**
 * I1-例外闭集：只有这些可以在 `attempts=1` 时结束本次调用。
 * `context_overflow` 不是放弃，是转交（handoff）给 loop 的 reactive compact。
 */
export const I1_EXCEPTIONS: ReadonlySet<GiveUpReason | "context_overflow"> = new Set([
  "user_abort",
  "context_overflow",
  "server_declined",
  "background_529",
  "deadline",
]);

export interface AttemptRecord {
  family: ErrorFamily;
  reason: FamilyVerdict["reason"];
  recognized: boolean;
  fingerprint: string;
  status?: number;
}

export interface AttemptHistory {
  /** 本次调用内**之前**失败的尝试（不含当前这次），按时间顺序 */
  attempts: readonly AttemptRecord[];
  /** 本次调用内已执行的重试次数（`maxRetriesPerCall` 的分子） */
  totalRetries: number;
  /** 连续 529 次数（不含当前这次） */
  consecutive529: number;
  /** 本次调用是否已试过非流式降级 */
  degradeTried: boolean;
  /** 本次调用开始的时刻（`RecoveryGiveUp.spanMs`） */
  startedAt: number;
}

export interface CallBudget {
  /** 调用方显式给的重试上界（`perCall.maxRetries`，缺省 STREAM_RETRY.maxRetries） */
  callerMaxRetries: number;
  /** 单次调用累计重试硬上界 */
  maxRetriesPerCall: number;
  /** 无人值守模式：只解除 transient 的预算上限 */
  persistent: boolean;
  /** 本次调用遇 529 是否仍重试（后台查询为 false，`shouldRetry529`） */
  retry529: boolean;
  /** 距 `deadlineAt` 的剩余毫秒；无截止时刻为 undefined */
  deadlineRemainingMs?: number;
  /** 退避基数。为 0 时各族的「最小间隔」下限一并归零（测试注入零退避用） */
  backoffBaseMs: number;
  /** 指数退避（含 Retry-After 优先）。由调用方注入，保持本函数纯 */
  backoff: (retryIndex: number, verdict: FamilyVerdict, err: NormalizedLLMError) => number;
  /** 共享限流冷却剩余（已错峰）。退避向它对齐取 max，不相加 */
  sharedCooldownMs?: number;
  /** `tryRecoverMaxTokens` 的结果：命中时带新 maxTokens 在漏斗内重试 */
  maxTokensRecovery?: number;
}

export interface GiveUpEvidence {
  reason: GiveUpReason;
  family: ErrorFamily;
  /** 本次调用的总尝试次数（含当前这次） */
  attempts: number;
  statuses: (number | null)[];
  fingerprints: string[];
  spanMs: number;
  /** 当前错误是否只是「认不出」（未识别子集） */
  recognized: boolean;
  /** reason=deadline 专用：本该睡的退避与剩余预算（S3 `retry_budget_exhausted` 遥测） */
  wantedDelayMs?: number;
  remainingMs?: number;
}

export type RecoveryAction =
  | {
      kind: "retry";
      delayMs: number;
      /** 未对齐共享冷却前的原始退避（S2 遥测用） */
      baseDelayMs: number;
      refreshAuth?: boolean;
      maxTokensOverride?: number;
      reopenReason: string;
      verdict: FamilyVerdict;
      /** persistent 模式下预算已耗尽、进入长等待（`persistent_retry_wait` 遥测） */
      persistentWait?: boolean;
    }
  | { kind: "degrade_non_streaming"; verdict: FamilyVerdict }
  | { kind: "handoff"; to: "context_overflow" }
  | { kind: "give_up"; evidence: GiveUpEvidence; verdict: FamilyVerdict };

/** S3：一次重试要「有意义」所需的最小剩余时间（与 fallback.ts 同值同义） */
export const MIN_USEFUL_ATTEMPT_MS = 5_000;
/** 连续 529 达到此值即放弃本模型转 fallback（原 MAX_529_CONSECUTIVE，行为不变） */
export const MAX_529_CONSECUTIVE = 3;
/** persistent 模式预算耗尽后的长等待 */
export const PERSISTENT_MAX_DELAY_MS = 300_000;

/** 各族本次调用内的最多尝试次数（含首次）。transient 由调用方预算决定 */
export const FAMILY_MAX_ATTEMPTS: Record<Exclude<ErrorFamily, "transient">, number> = {
  auth_suspect: 3,
  request_suspect: 2,
  local_fault: 2,
};

/** 「认不出」子集：同一指纹连续出现这么多次即放弃 */
export const UNRECOGNIZED_SAME_FINGERPRINT_CAP = 3;

/** 除 I1-例外外，任何族的实际尝试次数下限（至少重试一次） */
export const MIN_ATTEMPTS = 2;

/** auth_suspect 第 2、3 次的最小间隔；命中「真 key 作废」措辞时缩短为 1s（只加速，不判死） */
const AUTH_MIN_DELAYS_MS = [2_000, 8_000];
const AUTH_REAL_FAILURE_DELAY_MS = 1_000;
const REQUEST_SUSPECT_DELAY_MS = 2_000;

/** 从尾部数「与当前同族同指纹」的连续次数（含当前这次） */
function trailingSame(
  attempts: readonly AttemptRecord[],
  current: AttemptRecord,
  sameFingerprint: boolean,
): number {
  let n = 1;
  for (let i = attempts.length - 1; i >= 0; i--) {
    const a = attempts[i];
    if (a.family !== current.family) break;
    if (sameFingerprint && a.fingerprint !== current.fingerprint) break;
    n++;
  }
  return n;
}

export function decideRecovery(
  err: NormalizedLLMError,
  history: AttemptHistory,
  budget: CallBudget,
  now: number = Date.now(),
): RecoveryAction {
  const verdict = classifyFamily(err);
  const current: AttemptRecord = {
    family: verdict.family,
    reason: verdict.reason,
    recognized: verdict.recognized,
    fingerprint: err.fingerprint,
    status: err.status,
  };
  const attemptNo = history.attempts.length + 1;
  const giveUp = (reason: GiveUpReason, extra: Partial<GiveUpEvidence> = {}): RecoveryAction => ({
    kind: "give_up",
    verdict,
    evidence: {
      reason,
      family: verdict.family,
      attempts: attemptNo,
      statuses: [...history.attempts.map((a) => a.status ?? null), err.status ?? null],
      fingerprints: [...history.attempts.map((a) => a.fingerprint), err.fingerprint],
      spanMs: Math.max(0, now - history.startedAt),
      recognized: verdict.recognized,
      ...extra,
    },
  });

  // ═══ 第 0 步：I1-例外（顺序是契约：溢出必须先于族查表）═══
  const capReached = history.totalRetries >= budget.maxRetriesPerCall;

  // max_tokens 溢出：不是放弃，是带新 maxTokens 在漏斗内重试（计入单次调用上界）。
  //
  // ⚠️ 必须先于下面的上下文溢出转交：`input + max_tokens > limit` 这类措辞同时命中
  // `isPromptTooLong` 的「token…exceed」松散规则，但它说的是「输入放得下、只是 max_tokens
  // 设大了」—— 下调 max_tokens 就能治，转交压缩反而白丢历史。`tryRecoverMaxTokens`
  // 是按数字解析的精确判据（解析不出或下调后仍不够就返回 null），命中即说明这条路走得通。
  if (budget.maxTokensRecovery !== undefined) {
    if (capReached && !budget.persistent) return giveUp("per_call_cap");
    return {
      kind: "retry",
      delayMs: 0,
      baseDelayMs: 0,
      maxTokensOverride: budget.maxTokensRecovery,
      reopenReason: "max_tokens_adjust",
      verdict,
    };
  }

  // ⛔ 溢出判定挪到族查表之后，400 版会落进 request_suspect、无状态码版落进 transient，
  // 压缩被推迟 N 次请求 + 退避（设计 §2.7）。判据只用 `isPromptTooLong`，与 loop 闸门同源。
  if (isPromptTooLong(err.raw) || isPromptTooLong(err.message)) {
    return { kind: "handoff", to: "context_overflow" };
  }

  // 服务端结构化拒绝重试：这是服务端给的观测信号，不是我们猜的文案。
  if (err.serverRetryHint === false) return giveUp("server_declined");

  // 后台查询遇 529：现有省配额策略。
  if (verdict.reason === "overloaded" && !budget.retry529) return giveUp("background_529");

  // ═══ 第 1 步：空响应首次直降级（流式重试多少次都一样空）═══
  if (verdict.reason === "empty_response" && !history.degradeTried) {
    return { kind: "degrade_non_streaming", verdict };
  }

  // ═══ 第 2 步：按族查预算 ═══
  const callerAttempts = Math.max(MIN_ATTEMPTS, budget.callerMaxRetries + 1);
  const persistentTransient = budget.persistent && verdict.family === "transient";
  let persistentWait = false;

  if (verdict.family === "transient") {
    // 「认不出」子集同指纹封顶：已识别的（持续 429 / 502 / 超时）不封顶，否则会把调用方
    // 显式给的预算（cli 5、init-helpers 8）砍到 3。persistent 下照常生效。
    if (
      !verdict.recognized &&
      trailingSame(history.attempts, current, true) >= UNRECOGNIZED_SAME_FINGERPRINT_CAP
    ) {
      return giveUp("same_fingerprint");
    }
    if (verdict.reason === "overloaded" && history.consecutive529 + 1 >= MAX_529_CONSECUTIVE) {
      return giveUp("budget");
    }
    if (attemptNo >= callerAttempts) {
      if (!budget.persistent) return giveUp("budget");
      persistentWait = true;
    }
  } else {
    const familyAttempts = Math.max(
      MIN_ATTEMPTS,
      Math.min(FAMILY_MAX_ATTEMPTS[verdict.family], callerAttempts),
    );
    // auth / local：同指纹才累计（指纹变了说明网关状态在变，重新计数）；request：同族累计。
    const streak = trailingSame(history.attempts, current, verdict.family !== "request_suspect");
    if (streak >= familyAttempts) {
      return giveUp(verdict.family === "local_fault" ? "local_fault" : "same_fingerprint");
    }
    if (attemptNo >= callerAttempts) return giveUp("budget");
  }

  if (capReached && !persistentTransient) return giveUp("per_call_cap");

  // ═══ 退避 ═══
  const floorsOn = budget.backoffBaseMs > 0;
  let baseDelayMs: number;
  let refreshAuth: boolean | undefined;
  if (persistentWait) {
    baseDelayMs = PERSISTENT_MAX_DELAY_MS;
  } else if (verdict.family === "auth_suspect") {
    const streak = trailingSame(history.attempts, current, true);
    if (streak === 1) {
      // 首次立即重试，并先刷新凭据（原 B5-7 钩子，现在两条到达路径都能触发）。
      baseDelayMs = 0;
      refreshAuth = true;
    } else {
      const floor = verdict.realAuthFailure
        ? AUTH_REAL_FAILURE_DELAY_MS
        : AUTH_MIN_DELAYS_MS[Math.min(streak - 2, AUTH_MIN_DELAYS_MS.length - 1)];
      baseDelayMs = verdict.realAuthFailure
        ? floorsOn
          ? floor
          : 0
        : Math.max(budget.backoff(history.totalRetries, verdict, err), floorsOn ? floor : 0);
    }
  } else if (verdict.family === "request_suspect") {
    baseDelayMs = floorsOn ? REQUEST_SUSPECT_DELAY_MS : 0;
  } else if (verdict.family === "local_fault") {
    baseDelayMs = 0;
  } else {
    baseDelayMs = budget.backoff(history.totalRetries, verdict, err);
  }
  const delayMs = Math.max(baseDelayMs, budget.sharedCooldownMs ?? 0);

  // S3：退避睡完还来得及发一次有效请求吗？persistent 豁免（语义就是「等多久都行」）。
  if (
    !budget.persistent &&
    budget.deadlineRemainingMs !== undefined &&
    budget.deadlineRemainingMs <= delayMs + MIN_USEFUL_ATTEMPT_MS
  ) {
    return giveUp("deadline", {
      wantedDelayMs: delayMs,
      remainingMs: Math.max(0, budget.deadlineRemainingMs),
    });
  }

  return {
    kind: "retry",
    delayMs,
    baseDelayMs,
    ...(refreshAuth && { refreshAuth }),
    reopenReason: verdict.reason,
    verdict,
    ...(persistentWait && { persistentWait }),
  };
}
