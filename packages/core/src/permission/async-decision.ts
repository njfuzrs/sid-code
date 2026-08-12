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
 */

import type { Decision } from "./types.ts";
import { getLogger } from "../debug/logger.ts";

/** 决策来源 */
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

  return new Promise<DecisionResult>((outerResolve) => {
    let resolved = false;
    let graceExpired = !options.userDecision; // 无用户路径时 grace 立即过期
    const startTime = Date.now();

    const finish = (result: DecisionResult) => {
      if (resolved) return;
      resolved = true;
      outerResolve(result);
    };

    // Grace period timer
    if (options.userDecision && gracePeriodMs > 0) {
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
    if (options.userDecision && options.isInteractive && !options.isSubAgent) {
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
      options.userDecision(req, userResolve);
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

    // 非交互且无 hook/classifier → 立即 deny
    if (!options.isInteractive && !options.hookDecision && !options.classifierDecision) {
      finish({
        decision: { allowed: false, reason: "非交互模式，无自动决策路径" },
        source: "auto",
      });
    }
  });
}

// ── 保留旧 API 兼容（PermissionResolver 类） ──

/**
 * @deprecated 使用 resolvePermission() 替代
 */
export class PermissionResolver {
  private resolved = false;
  private resolveCallback: ((result: DecisionResult) => void) | null = null;

  waitForDecision(): Promise<DecisionResult> {
    return new Promise((resolve) => {
      this.resolveCallback = resolve;
    });
  }

  resolve(decision: Decision, source: DecisionSource, alwaysAllow?: boolean): boolean {
    if (this.resolved) return false;
    this.resolved = true;
    this.resolveCallback?.({ decision, source, alwaysAllow });
    return true;
  }

  isResolved(): boolean {
    return this.resolved;
  }

  cancel(reason: string): void {
    if (this.resolved) return;
    this.resolved = true;
    this.resolveCallback?.({
      decision: { allowed: false, reason },
      source: "timeout",
    });
  }
}

/** 生成唯一决策 ID */
let decisionCounter = 0;
export function createDecisionId(): string {
  return `perm_${++decisionCounter}_${Date.now()}`;
}
