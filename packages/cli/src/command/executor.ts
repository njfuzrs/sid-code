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
import { getLogger } from "@sid-code/core/debug/logger.ts";
// P0-1 漏斗 4：斜杠命令使用分布，回答「哪些功能是死功能」。
// 自定义命令名可能含项目/客户名，脱敏规则在门面里，见 analytics/events.ts。
import { logCommandInvoke, logCommandRejected } from "@sid-code/core/analytics/events.ts";

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
      logCommandRejected("parse_error");
      return { type: "error", message: "命令格式: /command [args]" };
    }

    const cmd = this.findCommand(parsed.commandName, commands);
    if (!cmd) {
      // 像命令名（仅字母数字连字符）→ 报未知命令；否则当作普通文本
      if (looksLikeCommand(parsed.commandName)) {
        // unknown_command 的分布能直接看出「用户以为存在但其实没有」的功能——
        // 这是功能缺口的一手信号。刻意**不上报用户输入的那个名字**：它是自由文本，
        // 可能含路径或私有名称。要看具体名字请查本地日志。
        logCommandRejected("unknown_command");
        return { type: "error", message: `未知命令: /${parsed.commandName}` };
      }
      return { type: "passthrough", value: input };
    }

    // 用户可调用性检查
    if (cmd.userInvocable === false) {
      logCommandRejected("not_user_invocable");
      return {
        type: "error",
        message: "此命令只能由模型调用，不支持手动触发",
      };
    }

    // 启用性检查（兜底）：UnifiedCommandRegistry.getCommands 已按 isEnabled 过滤，
    // 但本方法也接受调用方自备的命令数组（测试、immediate 路径、未过滤快照）。
    // 对 skill 来说 isEnabled 承载两件事：/skills 禁用态，以及 P1-2 条件激活 gate
    //（未触发的条件 skill 不可调用）——漏掉这层就能按名直呼绕过条件。
    if (cmd.isEnabled && !cmd.isEnabled()) {
      logCommandRejected("disabled");
      return {
        type: "error",
        message: `/${cmd.name} 当前不可用（已禁用，或为尚未触发的条件激活 Skill）`,
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
    // 漏斗 4 · 命令（P0-1）：斜杠命令使用分布，回答「哪些功能是死功能」。
    //
    // 埋在 dispatch 而非 executeSlashCommand，是为了同时覆盖 executeImmediate
    // （模型运行时插队执行）这条路径——只埋前者会漏掉插队调用，让统计偏低且偏得静默。
    //
    // 命令名脱敏规则见 logCommandInvoke：内置命令名是固定枚举（/model、/compact…），
    // 不含用户数据，可明文；自定义 / skill / plugin 命令名由用户定义，**可能含项目或
    // 客户名**，只上报 "custom" 占位，真名进 _PROTECTED_ 通道仅特权后端可见。
    logCommandInvoke({
      commandName: cmd.name,
      isBuiltin: (cmd.source ?? "builtin") === "builtin",
      commandType: cmd.type,
      hasArgs: args.trim().length > 0,
    });

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
    // ── skill 来源命令：先走 P0-3 权限判定，再注册 P0-2 生命周期 hooks ──
    // 顺序铁律：权限 → hooks → 执行。被拒的 skill 不能留下 hooks 污染后续工具调用。
    const skill = cmd.skill;
    let registeredHookCount = 0;

    if (skill) {
      const { authorizeSkill, resolveSkillAsk, registerSkillLifecycleHooks } = await import(
        "@sid-code/core/skill/executor.ts"
      );
      const auth = authorizeSkill(skill, { permissionRules: this.ctx.permissionRules });
      if (auth.decision === "deny") {
        return { type: "error", message: `权限拒绝：${auth.reason ?? skill.name}` };
      }
      if (auth.decision === "ask") {
        const allowed = await resolveSkillAsk(skill, auth.reason ?? "", {
          confirm: this.ctx.requestUserConfirmation,
        });
        if (!allowed) {
          return { type: "error", message: `已取消：Skill "${skill.name}" 未获批准。` };
        }
      }
      registeredHookCount = registerSkillLifecycleHooks(skill, this.ctx.hookSystem);
    }

    try {
      const prompt = await cmd.getPromptForCommand(args, this.ctx);

      if (cmd.context === "fork") {
        return await this.executeFork(cmd, prompt);
      }

      // inline：prompt 注入主对话。hooks 需在整段对话期间存活，故**不卸载**
      // （对齐 CC 的 session hook 语义：注册即持续到会话结束或 skill 卸载）。
      registeredHookCount = 0;

      // 审计第 19 条：skill 来源的 inline 注入要上报 addInvokedSkill，
      // 否则压缩丢弃旧消息后模型遗忘 skill 工作流指令（ctxMgr 侧保留机制早已接线，
      // 缺的一直是喂数据这一侧）。这条路径（UnifiedCommandRegistry → CommandExecutor）
      // 是 TUI 斜杠命令的真实路径，与 SkillCommand.execute 并列，两者都要上报。
      // 非 skill 来源的 prompt 命令不上报：它们不是"工作流指令"，压缩后无需重注入。
      if (skill) {
        try {
          this.ctx.ctxMgr?.addInvokedSkill(skill.name, prompt);
        } catch (e: any) {
          getLogger().warn(
            "COMMAND",
            `记录 inline skill 调用失败（不阻断）: ${e?.message ?? String(e)}`,
          );
        }
      }

      return { type: "submit_prompt", value: prompt, shouldQuery: true };
    } finally {
      // fork：hooks 作用域仅本次子代理调用，返回后卸载（与 SkillMetaTool.executeDelegate 同口径）。
      if (registeredHookCount > 0 && skill && this.ctx.hookSystem) {
        const removed = this.ctx.hookSystem.removeSkillHooks(skill.name);
        if (removed > 0) {
          getLogger().debug(
            "SKILL",
            `fork skill "${skill.name}" 返回，卸载 ${removed} 个会话 hook`,
          );
        }
      }
    }
  }

  /** fork 模式：在子代理中独立执行，返回最终输出 */
  private async executeFork(
    cmd: UnifiedCommand & PromptCommand,
    prompt: string,
  ): Promise<CommandExecutionResult> {
    const log = getLogger();
    try {
      const { SubAgent } = await import("@sid-code/core/agent/sub-agent.ts");

      if (!this.ctx.providerRegistry) {
        // 无 ProviderRegistry 时退回 inline 注入，避免命令不可用
        log.warn("COMMAND", `fork 命令 /${cmd.name} 无 providerRegistry，退回 inline`);
        return { type: "submit_prompt", value: prompt, shouldQuery: true };
      }

      const skill = cmd.skill;

      // P1-1：skill 来源命令透传 effort / agent 类型 / model（与模型路径 SkillMetaTool 同口径）。
      let effort: "low" | "medium" | "high" | "xhigh" | "max" | undefined;
      let agentType: string | undefined;
      if (skill) {
        const { normalizeSkillEffort, resolveSkillAgentType } = await import(
          "@sid-code/core/skill/executor.ts"
        );
        effort = normalizeSkillEffort(skill.effort);
        agentType = await resolveSkillAgentType(skill.agent, skill.name);
      }

      const subAgent = SubAgent.fromRegistry(
        this.ctx.providerRegistry,
        this.ctx.toolRegistry,
        this.ctx.hookSystem,
        skill?.model,
      );
      // 子代理内的工具权限判定沿用主会话 checker（未注入时子代理走自身默认）
      if (this.ctx.permissionChecker) {
        subAgent.setPermissionChecker(this.ctx.permissionChecker);
      }

      const result = await subAgent.executeCustom({
        systemPrompt: skill
          ? `你是一个专门执行 "${skill.name}" 任务的代理。${skill.description}`
          : "你是一个专注的助手，请完成以下任务。",
        userPrompt: prompt,
        allowedTools: cmd.allowedTools ?? [],
        // P2-2：fork 命令无 forkMessages/继承主对话概念（systemPrompt 是全新的“专注助手”提示词），
        // 与常规非 fork 子代理同档：默认从 10 提到 30。
        maxTurns: cmd.maxTurns ?? 30,
        // 超时透传：对齐磁盘 skill 的钳制（默认 2 分钟，最大 30 分钟）。
        // 不传 timeoutMins 时 executeCustom 内部默认 120_000ms，与历史行为一致。
        timeout:
          cmd.timeoutMins != null
            ? Math.min(Math.max(cmd.timeoutMins, 1), 30) * 60_000
            : undefined,
        effort,
        // agent 优先作为 agent 类型（memory/system prompt 跟随）；否则沿用 skill:<name>
        type: skill ? (agentType ?? `skill:${skill.name}`) : undefined,
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
