/**
 * 统一异步权限决策框架（三路竞争 + grace period）
 *
 * 三路竞争：
 * 1. Hook 路径 — PermissionRequest hook 自动决策
 * 2. Classifier 路径 — LLM 分类器判断安全性（仅 auto 模式/enableLLMClassifier 时激活）
 * 3. User 路径 — 用户交互确认（TUI/Bridge/SDK）
 *
 * Grace period (200ms)：
 * 用户路径在前 gracePeriodMs 内的 resolve 被 suppress——
 * 如果 hook/classifier 在宽限期内先返回则优先采纳，减少误触。
 *
 * resolve-once 语义：第一个到达的决策生效，后续忽略。
 *
 * 兜底 fail-closed：三路**都没接上**时立即拒绝，不白等满超时。判据是
 * 「有没有路径可等」而不是 isInteractive —— 后者只决定 user 路径启不启动。
 */

import type { Decision } from "./types.ts";
import { getLogger } from "../debug/logger.ts";

/**
 * 决策来源。
 * - `auto`：三路都没接上时的框架兜底（立即 fail-closed），不是「非交互」的别名。
 */
export type DecisionSource = "hook" | "classifier" | "user" | "timeout" | "auto";

/** 决策结果（带来源） */
export interface DecisionResult {
  decision: Decision;
  source: DecisionSource;
  /** 用户是否选择了 "Always Allow" */
  alwaysAllow?: boolean;
}

/** 权限决策请求（传给三路竞争的输入） */
export interface PermissionDecisionRequest {
  toolName: string;
  input: unknown;
  description: string;
}

/** 三路竞争配置 */
export interface ResolvePermissionOptions {
  /** 是否交互模式（非交互 → 无用户路径） */
  isInteractive: boolean;
  /** 是否子代理（子代理 → 无用户路径，timeout 更短） */
  isSubAgent: boolean;
  /** Hook 决策路径（返回 null 表示不干预/跳过） */
  hookDecision?: () => Promise<Decision | null>;
  /** 分类器决策路径（返回 null 表示不干预/不可用） */
  classifierDecision?: () => Promise<Decision | null>;
  /** 用户交互路径（调用方启动 TUI/Bridge 弹窗，通过 resolve 回调返回结果） */
  userDecision?: (req: PermissionDecisionRequest, resolve: UserResolve) => void;
  /** 超时（毫秒）。默认 300000(5分钟)，子代理 5000 */
  timeoutMs?: number;
  /** Grace period（毫秒）。用户路径在此期间的 resolve 被 suppress。默认 200 */
  gracePeriodMs?: number;
}

/** 用户路径 resolve 回调 */
export interface UserResolve {
  resolve(decision: Decision, alwaysAllow?: boolean): void;
  isResolved(): boolean;
}

/**
 * 三路竞争解析权限决策。
 *
 * @returns 最终决策（含来源和 alwaysAllow 标志）
 */
export async function resolvePermission(
  req: PermissionDecisionRequest,
  options: ResolvePermissionOptions,
): Promise<DecisionResult> {
  const log = getLogger();
  const timeoutMs = options.timeoutMs ?? (options.isSubAgent ? 5000 : 300_000);
  const gracePeriodMs = options.gracePeriodMs ?? 200;

  // 用户路径是否真的会启动。三处判据（grace 初始化 / Race 3 / 兜底）必须同源：
  // 只判 `options.userDecision` 会让「传了 userDecision 但 isInteractive=false」的
  // 情形 grace 计时器空转、兜底又误以为有路可等，最后白等满超时（默认 5 分钟）。
  const userDecisionPath =
    options.userDecision && options.isInteractive && !options.isSubAgent
      ? options.userDecision
      : null;

  return new Promise<DecisionResult>((outerResolve) => {
    let resolved = false;
    let graceExpired = !userDecisionPath; // 无用户路径时 grace 立即过期
    const startTime = Date.now();

    const finish = (result: DecisionResult) => {
      if (resolved) return;
      resolved = true;
      outerResolve(result);
    };

    // Grace period timer
    if (userDecisionPath && gracePeriodMs > 0) {
      setTimeout(() => {
        graceExpired = true;
      }, gracePeriodMs);
    }

    // Race 1: Hook 路径
    if (options.hookDecision) {
      void (async () => {
        try {
          const hookResult = await options.hookDecision!();
          if (resolved) return;
          if (hookResult !== null) {
            log.debug("PERMISSION", `Hook 决策: ${hookResult.allowed ? "允许" : "拒绝"}`);
            finish({ decision: hookResult, source: "hook" });
          }
        } catch (err) {
          log.debug("PERMISSION", `Hook 路径异常(忽略): ${err}`);
        }
      })();
    }

    // Race 2: Classifier 路径
    if (options.classifierDecision) {
      void (async () => {
        try {
          const classifierResult = await options.classifierDecision!();
          if (resolved) return;
          if (classifierResult !== null) {
            log.debug("PERMISSION", `分类器决策: ${classifierResult.allowed ? "允许" : "需确认"}`);
            finish({ decision: classifierResult, source: "classifier" });
          }
        } catch (err) {
          log.debug("PERMISSION", `分类器路径异常(忽略): ${err}`);
        }
      })();
    }

    // Race 3: User 路径
    if (userDecisionPath) {
      const userResolve: UserResolve = {
        resolve(decision: Decision, alwaysAllow?: boolean) {
          if (resolved) return;
          // Grace period: 用户在宽限期内的操作被 suppress
          if (!graceExpired) {
            log.debug("PERMISSION", "用户决策在 grace period 内,延迟处理");
            // 延迟到 grace 过期再检查
            const remaining = gracePeriodMs - (Date.now() - startTime);
            setTimeout(
              () => {
                if (resolved) return;
                finish({ decision, source: "user", alwaysAllow });
              },
              Math.max(0, remaining),
            );
            return;
          }
          finish({ decision, source: "user", alwaysAllow });
        },
        isResolved() {
          return resolved;
        },
      };
      userDecisionPath(req, userResolve);
    }

    // Timeout fallback
    setTimeout(() => {
      if (resolved) return;
      log.info("PERMISSION", `权限决策超时 (${timeoutMs}ms)，自动拒绝`);
      finish({
        decision: { allowed: false, reason: "权限决策超时" },
        source: "timeout",
      });
    }, timeoutMs);

    // 兜底：三路都没接上时立即 fail-closed，不白等超时。
    //
    // 判据刻意**不是** isInteractive —— 它只决定 user 路径启不启动，
    // 「有没有路可等」才是会不会挂满超时的根源。典型形态：调用方传了
    // isInteractive=true 却没接 userDecision，旧判据不成立，只能等满
    // 300s 才超时拒绝（交互式会话就这么被卡住 5 分钟）。
    //
    // 非交互场景的 ask 到不了这里：checker 在非交互模式下已经把 ask 落成
    // deny（`checker.ts` 的 `isNonInteractive()` 分支），返回的决策不带
    // needsConfirmation，调用方根本不会启动三路竞争。这里保留兜底只为
    // 框架自身的 fail-closed 语义（任何一路都没接时不许静默挂起）。
    if (!userDecisionPath && !options.hookDecision && !options.classifierDecision) {
      finish({
        decision: { allowed: false, reason: "无任何权限决策路径，立即拒绝" },
        source: "auto",
      });
    }
  });
}
