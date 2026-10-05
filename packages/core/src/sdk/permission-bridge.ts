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
 * 「Hook 主动放行」只认显式表态（H4）：顶层 `decision:"allow"/"approve"`（isApproveDecision），
 * 或 `hookSpecificOutput.permissionDecision:"allow"`。纯审计 hook（exit 0 无 JSON）与
 * exit 1 告警 hook 没有任何权限意见，必须落到宿主 can_use_tool，不能凭空变成 allow。
 */

import type { StructuredIO } from "./structured-io.ts";
import type { SDKControlPermissionResponse } from "./types.ts";
import { SDKControlPermissionResponseSchema } from "./control-schemas.ts";
import type { HookSystem } from "../hook/system.ts";

export type PermissionBehavior = "allow" | "deny" | "always_allow";

export interface PermissionBridgeOptions {
  structuredIO: StructuredIO;
  /**
   * ⚠️ 生产接线（app.ts runHeadlessSDK）**刻意不传**：走到 ask 通道时 PreToolUse
   * 已经在 tool-executor 里 fire 过一次（preToolUseCache），这里再传就会 fire 两次。
   * 保留它是给「绕开 tool-executor、直接拿这个函数当权限检查器」的嵌入方用的。
   */
  hookSystem?: HookSystem;
  /**
   * 宿主迟迟不答时的上限，到点按 deny 处理（fail-closed）。0 = 不设上限。
   * 默认 60s，与 Bridge 的 PermissionProxy 同值：两者都是「把 ask 交给远端」。
   */
  timeoutMs?: number;
}

/** 宿主不答 can_use_tool 时的默认上限（见 PermissionBridgeOptions.timeoutMs）。 */
export const SDK_PERMISSION_TIMEOUT_MS = 60_000;

export interface SDKCanUseToolCallOptions {
  /** 本轮的 abort 信号：interrupt / 会话超时时放弃等待，按 deny 闭合 */
  signal?: AbortSignal;
}

/**
 * 创建 SDK 模式下的权限检查函数
 *
 * 返回的函数签名与内核权限检查器对齐：(toolName, toolInput, toolUseId) → behavior
 */
export function createSDKCanUseTool(opts: PermissionBridgeOptions) {
  const { structuredIO, hookSystem } = opts;
  const timeoutMs = opts.timeoutMs ?? SDK_PERMISSION_TIMEOUT_MS;

  return async (
    toolName: string,
    toolInput: unknown,
    toolUseId: string,
    callOpts: SDKCanUseToolCallOptions = {},
  ): Promise<PermissionBehavior> => {
    // 一个 controller 收三种「别等了」：Hook 先决定 / 外部 abort / 超时。
    // 超时与 abort 都让 sendRequest reject —— 调用方必须把 reject 当 deny（fail-closed）。
    const hookAbortController = new AbortController();
    const external = callOpts.signal;
    const onExternalAbort = () => hookAbortController.abort();
    if (external?.aborted) hookAbortController.abort();
    else external?.addEventListener("abort", onExternalAbort, { once: true });
    const timer = timeoutMs > 0 ? setTimeout(() => hookAbortController.abort(), timeoutMs) : null;
    const cleanup = () => {
      if (timer) clearTimeout(timer);
      external?.removeEventListener("abort", onExternalAbort);
    };
    try {
      return await decide(hookAbortController, toolName, toolInput, toolUseId);
    } finally {
      cleanup();
    }
  };

  async function decide(
    hookAbortController: AbortController,
    toolName: string,
    toolInput: unknown,
    toolUseId: string,
  ): Promise<PermissionBehavior> {
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
  }
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
    if (out.isApproveDecision() || out.hookSpecificOutput?.["permissionDecision"] === "allow") {
      return "allow";
    }
    return null; // Hook 未做决定（含纯审计 / 告警 hook），交给 SDK 宿主
  } catch {
    return null;
  }
}
