/**
 * 命令执行引擎
 *
 * 根据 UnifiedCommand.type 分发到不同的执行路径：
 * - local: 同步执行，返回文本/压缩/清空/退出/对话框/确认
 * - local-jsx: 渲染 Ink 交互式 UI，通过 onDone 回调通知完成
 * - prompt: 生成 prompt 注入对话（inline）或 fork 到子代理执行
 *
 * 设计为独立类，与应用逻辑解耦，可独立测试。应用层通过 ExecutorCallbacks
 * 注入副作用（设置交互式 UI、清空对话等）。
 */

import type { ReactNode } from "react";
import type {
  CommandContext,
  CommandExecutionResult,
  LocalCommand,
  LocalJSXCommand,
  LocalJSXCommandOnDone,
  LocalCommandResult,
  PromptCommand,
  UnifiedCommand,
} from "./types.ts";
import { parseSlashCommand, looksLikeCommand } from "./parser.ts";
import { getLogger } from "../debug/logger.ts";

/** 应用层注入的副作用回调 */
export interface ExecutorCallbacks {
  /** 设置/清空交互式 UI（local-jsx 用）；null 表示关闭 */
  setToolJSX?: (jsx: ReactNode | null) => void;
}

export class CommandExecutor {
  constructor(
    private ctx: CommandContext,
    private callbacks: ExecutorCallbacks = {},
  ) {}

  /** 执行斜杠命令（完整流程：解析 → 查找 → 可见性检查 → 分发） */
  async executeSlashCommand(
    input: string,
    commands: UnifiedCommand[],
  ): Promise<CommandExecutionResult> {
    const parsed = parseSlashCommand(input);
    if (!parsed) {
      return { type: "error", message: "命令格式: /command [args]" };
    }

    const cmd = this.findCommand(parsed.commandName, commands);
    if (!cmd) {
      // 像命令名（仅字母数字连字符）→ 报未知命令；否则当作普通文本
      if (looksLikeCommand(parsed.commandName)) {
        return { type: "error", message: `未知命令: /${parsed.commandName}` };
      }
      return { type: "passthrough", value: input };
    }

    // 用户可调用性检查
    if (cmd.userInvocable === false) {
      return {
        type: "error",
        message: "此命令只能由模型调用，不支持手动触发",
      };
    }

    return this.dispatch(cmd, parsed.args);
  }

  /**
   * immediate 命令的即时执行（模型运行时插队用）
   * 仅分发，不做 passthrough 判断
   */
  async executeImmediate(
    cmd: UnifiedCommand,
    args: string,
  ): Promise<CommandExecutionResult> {
    return this.dispatch(cmd, args);
  }

  /** 按命令名/别名 + 子命令路径查找命令 */
  findCommand(
    name: string,
    commands: UnifiedCommand[],
  ): UnifiedCommand | undefined {
    const parts = name.trim().split(/\s+/);
    const top =
      commands.find((c) => c.name === parts[0]) ??
      commands.find((c) => c.aliases?.includes(parts[0]));
    if (!top || parts.length === 1) return top;

    // 子命令路径解析
    let current = top;
    for (let i = 1; i < parts.length; i++) {
      const subs = current.subCommands?.() ?? [];
      const found = subs.find(
        (c) => c.name === parts[i] || c.aliases?.includes(parts[i]),
      );
      if (!found) return current; // 子命令不存在 → 父命令处理参数
      current = found;
    }
    return current;
  }

  /** 按类型分发 */
  private dispatch(
    cmd: UnifiedCommand,
    args: string,
  ): Promise<CommandExecutionResult> {
    switch (cmd.type) {
      case "local":
        return this.executeLocal(cmd, args);
      case "local-jsx":
        return this.executeLocalJSX(cmd, args);
      case "prompt":
        return this.executePrompt(cmd, args);
    }
  }

  /** local 命令：延迟加载 → 调用 → 映射结果 */
  private async executeLocal(
    cmd: UnifiedCommand & LocalCommand,
    args: string,
  ): Promise<CommandExecutionResult> {
    const mod = await cmd.load();
    const result = await mod.call(args, this.ctx);
    return this.mapLocalResult(result);
  }

  /** 将 LocalCommandResult 映射为执行引擎结果 */
  private mapLocalResult(
    result: LocalCommandResult,
  ): CommandExecutionResult {
    switch (result.type) {
      case "text":
        return { type: "message", value: result.value };
      case "compact":
        return { type: "compact", summary: result.summary };
      case "clear":
        return { type: "clear" };
      case "quit":
        return { type: "quit", message: result.message };
      case "dialog":
        return { type: "dialog", dialog: result.dialog };
      case "submit_prompt":
        return { type: "submit_prompt", value: result.prompt, shouldQuery: true };
      case "confirm":
        return {
          type: "confirm",
          message: result.message,
          onConfirm: async () => this.mapLocalResult(await result.onConfirm()),
        };
      case "skip":
        return { type: "skip" };
    }
  }

  /** local-jsx 命令：Promise + onDone 桥接声明式 UI 与命令式执行 */
  private executeLocalJSX(
    cmd: UnifiedCommand & LocalJSXCommand,
    args: string,
  ): Promise<CommandExecutionResult> {
    return new Promise<CommandExecutionResult>((resolve) => {
      let doneWasCalled = false;

      const onDone: LocalJSXCommandOnDone = (result, options) => {
        if (doneWasCalled) return;
        doneWasCalled = true;
        this.callbacks.setToolJSX?.(null); // 关闭交互式 UI

        if (options?.display === "skip") {
          resolve({ type: "skip" });
          return;
        }
        resolve({
          type: "message",
          value: result ?? "",
          shouldQuery: options?.shouldQuery ?? false,
        });
      };

      cmd
        .load()
        .then((mod) => mod.call(onDone, this.ctx, args))
        .then((jsx) => {
          if (jsx && !doneWasCalled) {
            this.callbacks.setToolJSX?.(jsx); // 渲染交互式 UI
          }
        })
        .catch((e) => {
          // 异常兜底：必须 resolve，否则队列处理器死锁
          if (!doneWasCalled) {
            doneWasCalled = true;
            this.callbacks.setToolJSX?.(null);
            resolve({
              type: "error",
              message: `命令执行失败: ${e instanceof Error ? e.message : String(e)}`,
            });
          }
        });
    });
  }

  /** prompt 命令：inline 注入当前对话 / fork 子代理执行 */
  private async executePrompt(
    cmd: UnifiedCommand & PromptCommand,
    args: string,
  ): Promise<CommandExecutionResult> {
    const prompt = await cmd.getPromptForCommand(args, this.ctx);

    if (cmd.context === "fork") {
      return this.executeFork(cmd, prompt);
    }

    return { type: "submit_prompt", value: prompt, shouldQuery: true };
  }

  /** fork 模式：在子代理中独立执行，返回最终输出 */
  private async executeFork(
    cmd: UnifiedCommand & PromptCommand,
    prompt: string,
  ): Promise<CommandExecutionResult> {
    const log = getLogger();
    try {
      const { SubAgent } = await import("../agent/sub-agent.ts");

      if (!this.ctx.providerRegistry) {
        // 无 ProviderRegistry 时退回 inline 注入，避免命令不可用
        log.warn("COMMAND", `fork 命令 /${cmd.name} 无 providerRegistry，退回 inline`);
        return { type: "submit_prompt", value: prompt, shouldQuery: true };
      }

      const subAgent = SubAgent.fromRegistry(
        this.ctx.providerRegistry,
        this.ctx.toolRegistry,
        this.ctx.hookSystem,
      );

      const result = await subAgent.executeCustom({
        systemPrompt: "你是一个专注的助手，请完成以下任务。",
        userPrompt: prompt,
        allowedTools: cmd.allowedTools ?? [],
        maxTurns: cmd.maxTurns ?? 10,
        // 超时透传：对齐磁盘 skill 的钳制（默认 2 分钟，最大 30 分钟，见 skill/tool.ts:146）。
        // 不传 timeoutMins 时 executeCustom 内部默认 120_000ms，与历史行为一致。
        timeout:
          cmd.timeoutMins != null
            ? Math.min(Math.max(cmd.timeoutMins, 1), 30) * 60_000
            : undefined,
      });

      return {
        type: "message",
        value: result.success
          ? result.output
          : `子代理执行失败: ${result.output}`,
      };
    } catch (e: any) {
      return {
        type: "error",
        message: `fork 执行失败: ${e?.message ?? String(e)}`,
      };
    }
  }
}
