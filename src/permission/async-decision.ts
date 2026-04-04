/**
 * 异步权限决策框架
 * 支持多路竞速：Hook 自动决策 / 用户交互确认 / 超时自动拒绝
 * resolve-once 语义：第一个到达的决策生效，后续忽略
 */

import type { Decision } from "./types.ts";
import { getLogger } from "../debug/logger.ts";

/** 权限决策请求 */
export interface PermissionDecisionRequest {
  id: string;
  tool: string;
  input: unknown;
  description: string;
  decision: Decision;  // 初始决策（needsConfirmation: true）
  timestamp: number;
}

/** 决策来源 */
export type DecisionSource = "hook" | "user" | "timeout" | "auto";

/** 决策结果（带来源） */
export interface DecisionResult {
  decision: Decision;
  source: DecisionSource;
  /** 用户是否选择了 "Always Allow" */
  alwaysAllow?: boolean;
}

/**
 * 权限决策解析器（resolve-once 语义）
 * 多个决策路径竞速，第一个到达的生效
 */
export class PermissionResolver {
  private resolved = false;
  private resolveCallback: ((result: DecisionResult) => void) | null = null;
  private rejectCallback: ((err: Error) => void) | null = null;

  /** 创建 Promise，等待决策 */
  waitForDecision(): Promise<DecisionResult> {
    return new Promise((resolve, reject) => {
      this.resolveCallback = resolve;
      this.rejectCallback = reject;
    });
  }

  /** 解析决策（只能调用一次，返回 true 表示成功） */
  resolve(decision: Decision, source: DecisionSource, alwaysAllow?: boolean): boolean {
    if (this.resolved) return false;
    this.resolved = true;
    this.resolveCallback?.({ decision, source, alwaysAllow });
    return true;
  }

  /** 是否已解析 */
  isResolved(): boolean {
    return this.resolved;
  }

  /** 取消（超时等场景） */
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
  return `perm_${Date.now()}_${++decisionCounter}`;
}

/**
 * 创建带超时的权限决策
 * @param timeoutMs 超时毫秒数（默认 30 秒）
 */
export function createTimedResolver(timeoutMs = 30_000): {
  resolver: PermissionResolver;
  cleanup: () => void;
} {
  const resolver = new PermissionResolver();
  const timer = setTimeout(() => {
    resolver.cancel(`权限确认超时（${timeoutMs / 1000}秒）`);
  }, timeoutMs);

  return {
    resolver,
    cleanup: () => clearTimeout(timer),
  };
}

/**
 * 解析权限决策（多路竞速入口）
 * 当权限检查返回 needsConfirmation: true 时调用
 */
export async function resolvePermission(
  req: PermissionDecisionRequest,
  options: {
    isInteractive: boolean;
    isSubAgent: boolean;
    /** Hook 决策回调（可选） */
    hookDecision?: () => Promise<Decision | null>;
    /** 用户交互决策回调（可选） */
    userDecision?: (req: PermissionDecisionRequest, resolver: PermissionResolver) => void;
    /** 超时毫秒数 */
    timeoutMs?: number;
  },
): Promise<DecisionResult> {
  const log = getLogger();
  const { resolver, cleanup } = createTimedResolver(options.timeoutMs);

  try {
    // 路径 1：Hook 自动决策（后台）
    if (options.hookDecision) {
      options.hookDecision().then(hookResult => {
        if (hookResult && !resolver.isResolved()) {
          log.info("ASYNC_DECISION", `Hook 决策: ${hookResult.allowed ? "允许" : "拒绝"}`);
          resolver.resolve(hookResult, "hook");
        }
      }).catch(() => { /* Hook 失败不影响其他路径 */ });
    }

    // 路径 2：用户交互确认（前台，仅交互模式 + 非子代理）
    if (options.isInteractive && !options.isSubAgent && options.userDecision) {
      options.userDecision(req, resolver);
    }

    // 路径 3：非交互模式 → 自动拒绝
    if (!options.isInteractive) {
      resolver.resolve(
        { allowed: false, reason: "非交互模式下自动拒绝" },
        "auto",
      );
    }

    // 子代理 → 自动拒绝（子代理不应弹窗）
    if (options.isSubAgent && !options.hookDecision) {
      resolver.resolve(
        { allowed: false, reason: "子代理不允许交互式权限确认" },
        "auto",
      );
    }

    return await resolver.waitForDecision();
  } finally {
    cleanup();
  }
}
