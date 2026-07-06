/**
 * @deprecated 使用 src/permission/async-decision.ts 的 resolvePermission() 替代。
 *
 * 多路并发权限决策框架（旧版，未接入生产路径）。
 * 保留代码供参考，新功能应使用 async-decision.ts 的统一三路竞争框架。
 */

import { createResolveOnce } from "./resolve-once.ts";
import type { HookSystem } from "./system.ts";
import { getLogger } from "../debug/logger.ts";

export interface PermissionDecision {
  allowed: boolean;
  source: "user" | "hook" | "classifier" | "rule";
  reason?: string;
  permUpdates?: Record<string, unknown>;
}

export interface PermissionRequest {
  toolName: string;
  input: Record<string, unknown>;
  permissionMode: string;
}

export interface InteractivePermissionOptions {
  hookSystem?: HookSystem;
  classifier?: BashClassifier;
  promptUser: (request: PermissionRequest) => Promise<PermissionDecision>;
}

export interface BashClassifier {
  classify(command: string): Promise<ClassifierResult | null>;
}

export interface ClassifierResult {
  safe: boolean;
  confidence: "high" | "medium" | "low";
  matchedRule?: string;
  reason?: string;
}

export async function handleInteractivePermission(
  request: PermissionRequest,
  options: InteractivePermissionOptions,
): Promise<PermissionDecision> {
  const log = getLogger();

  return new Promise<PermissionDecision>((resolve) => {
    const guard = createResolveOnce(resolve);

    // Race 1: 用户交互
    void (async () => {
      try {
        const result = await options.promptUser(request);
        if (!guard.claim()) return;
        guard.resolve(result);
      } catch (err) {
        log.debug("PERMISSION", `用户交互路径异常: ${err}`);
      }
    })();

    // Race 2: PermissionRequest Hook
    if (options.hookSystem) {
      void (async () => {
        try {
          if (guard.isResolved()) return;
          const hookResult = await options.hookSystem!.firePermissionRequestEvent(
            request.toolName,
            request.input,
            request.permissionMode,
          );
          if (!hookResult.finalOutput) return;
          if (!guard.claim()) return;

          const decision = hookResult.finalOutput.decision;
          if (decision === "allow") {
            guard.resolve({ allowed: true, source: "hook" });
          } else if (decision === "deny" || decision === "block") {
            guard.resolve({
              allowed: false,
              source: "hook",
              reason: hookResult.finalOutput.reason || hookResult.finalOutput.stopReason,
            });
          }
        } catch (err) {
          log.debug("PERMISSION", `Hook 路径异常: ${err}`);
        }
      })();
    }

    // Race 3: Bash 分类器（仅 bash 工具）
    if (options.classifier && request.toolName === "bash") {
      void (async () => {
        try {
          if (guard.isResolved()) return;
          const command = (request.input as any).command;
          if (!command) return;

          const result = await options.classifier!.classify(command);
          if (!result || !guard.claim()) return;

          if (result.safe && result.confidence === "high") {
            guard.resolve({
              allowed: true,
              source: "classifier",
              reason: result.matchedRule,
            });
          }
        } catch (err) {
          log.debug("PERMISSION", `分类器路径异常: ${err}`);
        }
      })();
    }
  });
}
