/**
 * 旧命令体系 → 新命令体系适配器
 *
 * 用于渐进式迁移期间的向后兼容：
 * - 旧式 Command（方法式接口 + CommandResult）→ UnifiedCommand（属性式 + 判别联合）
 * - CommandContext（新，精简）→ AppContext（旧，命令执行时按需构造）
 *
 * 迁移策略：所有未迁移的内置命令通过 adaptLegacyCommand 包装为 LocalCommand，
 * 已迁移的命令直接定义为 UnifiedCommand。最终移除本文件。
 */

import type {
  Command as LegacyCommand,
  CommandResult as LegacyCommandResult,
  AppContext,
  CommandContext,
  CommandSource,
  UnifiedCommand,
  LocalCommandResult,
} from "./types.ts";

/**
 * 将新的 CommandContext 转换为旧的 AppContext
 * 旧命令依赖 AppContext.registry / setModel 等字段
 */
export function toAppContext(ctx: CommandContext): AppContext {
  return {
    ctxMgr: ctx.ctxMgr,
    registry: ctx.toolRegistry,
    config: ctx.config,
    sessionId: ctx.sessionId,
    provider: ctx.provider,
    providerRegistry: ctx.providerRegistry,
    mcpManager: ctx.mcpManager,
    setModel: ctx.setModel ?? (() => {}),
    exitRequested: false,
    sessionState: ctx.sessionState,
    sendToLLM: ctx.sendToLLM,
    customCommands: ctx.customCommands,
    confirmShellCommands: ctx.confirmShellCommands,
    hookSystem: ctx.hookSystem,
  };
}

/**
 * 将旧式 CommandResult 转换为新的 LocalCommandResult
 * 保留 confirm / dialog / submit_prompt 等语义（不再降级为 skip）
 */
export function convertResult(result: LegacyCommandResult): LocalCommandResult {
  switch (result.kind) {
    case "message":
      return { type: "text", value: result.message ?? "" };
    case "error":
      return { type: "text", value: `错误: ${result.message ?? ""}` };
    case "clear":
      return { type: "clear" };
    case "quit":
      return { type: "quit", message: result.message };
    case "submit_prompt":
      return { type: "submit_prompt", prompt: result.prompt ?? "" };
    case "dialog":
      // dialog 必有 dialog 字段；缺失时降级为文本
      return result.dialog
        ? { type: "dialog", dialog: result.dialog }
        : { type: "text", value: result.message ?? "" };
    case "confirm":
      return {
        type: "confirm",
        message: result.message ?? "",
        onConfirm: async () => {
          if (!result.onConfirm) return { type: "skip" };
          const next = await result.onConfirm();
          return convertResult(next);
        },
      };
    default:
      return { type: "skip" };
  }
}

/**
 * 将旧式 Command 接口适配为新的 UnifiedCommand（LocalCommand 变体）
 * 子命令递归适配
 */
export function adaptLegacyCommand(
  cmd: LegacyCommand,
  source: CommandSource = "builtin",
): UnifiedCommand {
  return {
    type: "local",
    name: cmd.name(),
    aliases: cmd.aliases(),
    description: cmd.description(),
    source,
    subCommands: cmd.subCommands
      ? () => cmd.subCommands!().map((sub) => adaptLegacyCommand(sub, source))
      : undefined,
    load: () =>
      Promise.resolve({
        call: async (args: string, ctx: CommandContext) => {
          const appCtx = toAppContext(ctx);
          const result = await cmd.execute(args, appCtx);
          return convertResult(result);
        },
      }),
  };
}
