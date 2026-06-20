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
    setEffort: ctx.setEffort,
    setThinking: ctx.setThinking,
    getEffortState: ctx.getEffortState,
    getThinkingState: ctx.getThinkingState,
    exitRequested: false,
    sessionState: ctx.sessionState,
    sendToLLM: ctx.sendToLLM,
    customCommands: ctx.customCommands,
    confirmShellCommands: ctx.confirmShellCommands,
    hookSystem: ctx.hookSystem,
    unifiedRegistry: ctx.unifiedRegistry,
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
 * 将 AppContext（旧）转换为 CommandContext（新）
 * 用于反向桥接：UnifiedCommand 被注册到旧 Registry 后，由旧执行路径传入 AppContext
 */
export function toCommandContext(appCtx: AppContext): CommandContext {
  return {
    ctxMgr: appCtx.ctxMgr,
    toolRegistry: appCtx.registry,
    config: appCtx.config,
    sessionId: appCtx.sessionId,
    provider: appCtx.provider,
    providerRegistry: appCtx.providerRegistry,
    mcpManager: appCtx.mcpManager,
    setModel: appCtx.setModel,
    setEffort: appCtx.setEffort,
    setThinking: appCtx.setThinking,
    getEffortState: appCtx.getEffortState,
    getThinkingState: appCtx.getThinkingState,
    sessionState: appCtx.sessionState,
    sendToLLM: appCtx.sendToLLM,
    customCommands: appCtx.customCommands,
    confirmShellCommands: appCtx.confirmShellCommands,
    hookSystem: appCtx.hookSystem,
    cwd: process.cwd(),
    unifiedRegistry: appCtx.unifiedRegistry,
  };
}

/**
 * 将新体系 CommandExecutionResult 转换为旧 CommandResult
 */
function toLegacyResult(
  result: import("./types.ts").CommandExecutionResult,
): LegacyCommandResult {
  switch (result.type) {
    case "message":
      return { kind: "message", message: result.value };
    case "submit_prompt":
      return { kind: "submit_prompt", prompt: result.value };
    case "error":
      return { kind: "error", message: result.message };
    case "clear":
      return { kind: "clear" };
    case "quit":
      return { kind: "quit", message: result.message };
    case "compact":
      // 旧体系没有 compact，降级为 submit_prompt
      return { kind: "submit_prompt", prompt: result.summary };
    case "confirm":
      return {
        kind: "confirm",
        message: result.message,
        onConfirm: async () => toLegacyResult(await result.onConfirm()),
      };
    case "dialog":
      return { kind: "dialog", dialog: result.dialog };
    case "passthrough":
      return { kind: "submit_prompt", prompt: result.value };
    case "skip":
      return { kind: "message", message: "" };
    default:
      return { kind: "message", message: "" };
  }
}

/**
 * 将新体系 UnifiedCommand 适配为旧 Command 接口
 *
 * 用途：让 bundled skills 等新体系命令能被注册到旧 Registry，
 * 从而在 app.ts 现有执行路径（commandRegistry.get + .execute）中直接可用。
 *
 * execute 内部会创建 CommandExecutor，将 AppContext→CommandContext 桥接，
 * 执行后将 CommandExecutionResult→CommandResult 转换。
 */
export async function adaptUnifiedToLegacy(
  uc: UnifiedCommand,
): Promise<LegacyCommand> {
  // 递归适配子命令（同步，新旧体系 subCommands 都是同步的）
  let subAdapterCache: LegacyCommand[] | undefined;
  const adaptSubCommands = (): LegacyCommand[] => {
    if (!subAdapterCache && uc.subCommands) {
      subAdapterCache = uc.subCommands().map((sub) => ({
        name: () => sub.name,
        aliases: () => sub.aliases ?? [],
        description: () => sub.description,
        // 子命令暂不桥接 execute（bundled skills 无子命令，此路径未使用）
        execute: async (_args: string) => ({
          kind: "error" as const,
          message: `子命令 /${sub.name} 暂不支持旧 Registry 执行路径`,
        }),
      }));
    }
    return subAdapterCache ?? [];
  };

  return {
    name: () => uc.name,
    aliases: () => uc.aliases ?? [],
    description: () => uc.description,
    subCommands: uc.subCommands ? adaptSubCommands : undefined,
    async execute(args: string, appCtx: AppContext): Promise<LegacyCommandResult> {
      const { CommandExecutor } = await import("./executor.ts");
      const cmdCtx = toCommandContext(appCtx);
      const executor = new CommandExecutor(cmdCtx);
      const input = `/${uc.name}${args ? " " + args : ""}`;
      const result = await executor.executeSlashCommand(input, [uc]);
      return toLegacyResult(result);
    },
  };
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
