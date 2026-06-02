/**
 * SDK 模式权限桥接（控制协议 ↔ 权限检查）
 *
 * SDK 模式下没有 TUI 弹窗，权限决策来自两个并行来源，先决定者胜出：
 * 1. Hook（PreToolUse）—— 本地静态规则 / 脚本
 * 2. SDK 宿主 —— 通过控制协议 can_use_tool 请求询问外部调用者
 *
 * Promise.race：谁先决定用谁的结果。Hook 先决定 → 取消 SDK 请求；
 * SDK 先响应 → 取消 Hook（abort signal）。
 *
 * 对齐 Claude Code StructuredIO.createCanUseTool() 的竞速设计（spec §5.2）。
 * 注意：sid-code 的 HookDecision 为 "allow" | "deny" | "block"，
 * 没有 shouldAutoApprove()，这里用 decision === "allow" 表示 Hook 主动放行。
 */

import type { StructuredIO } from "./structured-io.ts";
import type { SDKControlPermissionResponse } from "./types.ts";
import { SDKControlPermissionResponseSchema } from "./control-schemas.ts";
import type { HookSystem } from "../hook/system.ts";

export type PermissionBehavior = "allow" | "deny" | "always_allow";

export interface PermissionBridgeOptions {
  structuredIO: StructuredIO;
  hookSystem?: HookSystem;
}

/**
 * 创建 SDK 模式下的权限检查函数
 *
 * 返回的函数签名与内核权限检查器对齐：(toolName, toolInput, toolUseId) → behavior
 */
export function createSDKCanUseTool(opts: PermissionBridgeOptions) {
  const { structuredIO, hookSystem } = opts;

  return async (
    toolName: string,
    toolInput: unknown,
    toolUseId: string,
  ): Promise<PermissionBehavior> => {
    const hookAbortController = new AbortController();

    // Hook 评估（无 Hook 时永不 resolve，交给 SDK 宿主决定）
    const hookPromise: Promise<PermissionBehavior | null> = hookSystem
      ? executePermissionHook(hookSystem, toolName, toolInput, hookAbortController.signal)
      : new Promise<PermissionBehavior | null>(() => {});

    // SDK 宿主权限请求
    const sdkPromise = structuredIO.sendRequest<SDKControlPermissionResponse>(
      {
        subtype: "can_use_tool",
        tool_name: toolName,
        input: (toolInput ?? {}) as Record<string, unknown>,
        tool_use_id: toolUseId,
      },
      SDKControlPermissionResponseSchema(),
      hookAbortController.signal,
    );

    // 竞速
    const winner = await Promise.race([
      hookPromise.then((r) => ({ source: "hook" as const, result: r })),
      sdkPromise.then((r) => ({ source: "sdk" as const, result: r })),
    ]);

    if (winner.source === "hook" && winner.result) {
      // Hook 先决定 → 取消 SDK 请求
      hookAbortController.abort();
      return winner.result;
    }

    if (winner.source === "sdk") {
      // SDK 宿主先响应
      structuredIO.trackResolvedToolUseId(toolUseId);
      return winner.result.behavior;
    }

    // Hook 放弃决定（resolve null）→ 等待 SDK 宿主
    const sdkResult = await sdkPromise;
    structuredIO.trackResolvedToolUseId(toolUseId);
    return sdkResult.behavior;
  };
}

/**
 * 执行 PreToolUse Hook，映射为权限 behavior
 * @returns "deny"（阻塞）/ "allow"（主动放行）/ null（不做决定）
 */
async function executePermissionHook(
  hookSystem: HookSystem,
  toolName: string,
  toolInput: unknown,
  signal: AbortSignal,
): Promise<PermissionBehavior | null> {
  try {
    const result = await hookSystem.firePreToolUseEvent(
      toolName,
      (toolInput ?? {}) as Record<string, unknown>,
    );
    if (signal.aborted) return null;
    const out = result.finalOutput;
    if (!out) return null;
    if (out.isBlockingDecision()) return "deny";
    if (out.decision === "allow") return "allow";
    return null; // Hook 未做决定，交给 SDK 宿主
  } catch {
    return null;
  }
}
