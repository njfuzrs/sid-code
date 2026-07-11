/**
 * Bundled Skill 工具包装器（Gap 1）
 *
 * 背景：磁盘 Skill 通过 SkillTool 注册为工具，模型可自动调用；而 Bundled Skill
 * 此前只暴露为斜杠命令（UnifiedCommandRegistry），模型看不到、无法自动调用 ——
 * 这是 sid-code 内部的能力不对等（不是"对标 claude-code"，claude-code 的 /commit
 * 等本身也只是斜杠命令）。
 *
 * 本包装器把一个 fork 模式的 Bundled Skill(PromptCommand) 适配为 LegacyTool，
 * 执行路径与 CommandExecutor.executeFork 完全一致（SubAgent.executeCustom +
 * allowedTools 白名单 + timeoutMins 钳制）。
 *
 * 适用范围约束（重要）：
 *   - 仅 fork 模式可包装。inline 模式语义是"把 prompt 注入主对话"，不是"返回结果
 *     给模型"，做成工具语义不符——inline skill（如 /commit）只保留斜杠命令。
 *   - 是否暴露由 BundledSkillDefinition.disableModelInvocation 控制。带强副作用的
 *     skill（commit-push-pr / pr-workflow / pr-comments）应显式 disableModelInvocation，
 *     避免模型在无显式指令时自主 push / 建 PR。只读的 review 适合暴露。
 */

import type { LegacyTool as Tool, LegacyToolResult as ToolResult } from "../../tool/types.ts";
import type { ProviderRegistry } from "../../llm/registry.ts";
import type { Registry as ToolRegistry } from "../../tool/registry.ts";
import type { HookSystem } from "../../hook/system.ts";
import type { UnifiedCommand, PromptCommand, CommandContext } from "../../command/types.ts";
import { SubAgent } from "../../agent/sub-agent.ts";
import { getLogger } from "../../debug/logger.ts";
import { z } from "zod/v4";

/** 工具输入：透传给 skill 的 getPromptForCommand(args) */
const inputSchema = z.object({
  input: z
    .string()
    .default("")
    .describe("传递给 Skill 的输入参数（如审查重点 / diff 路径），可为空"),
});

type BundledPromptCommand = UnifiedCommand & PromptCommand;

export class BundledSkillTool implements Tool {
  readonly zodSchema = inputSchema;
  /** 权限检查器（子代理 dontAsk 语义，由主会话注入） */
  private permissionChecker?: import("../../permission/types.ts").Checker;

  constructor(
    private cmd: BundledPromptCommand,
    private providerRegistry: ProviderRegistry,
    private toolRegistry: ToolRegistry,
    private hookSystem?: HookSystem,
  ) {}

  /** 注入权限检查器（子代理 dontAsk 语义） */
  setPermissionChecker(checker: import("../../permission/types.ts").Checker): void {
    this.permissionChecker = checker;
  }

  name(): string {
    return `skill__${this.cmd.name}`;
  }

  description(): string {
    let desc = this.cmd.description;
    if (this.cmd.whenToUse) {
      desc += `\n何时使用: ${this.cmd.whenToUse}`;
    }
    return desc;
  }

  inputSchema(): Record<string, unknown> {
    return z.toJSONSchema(this.zodSchema) as Record<string, unknown>;
  }

  readOnly(): boolean {
    // 取决于 allowedTools 是否含写工具（review 锁只读 → true）
    const writeTools = ["write", "edit", "bash"];
    if (this.cmd.allowedTools) {
      return !this.cmd.allowedTools.some((t) => writeTools.includes(t));
    }
    return true;
  }

  async execute(input: unknown, signal?: AbortSignal): Promise<ToolResult> {
    const log = getLogger();
    const args = (input as { input?: string })?.input ?? "";

    // 注：CommandContext 在工具调用场景下不可用（工具没有命令执行上下文）。
    // bundled skill 的 getPromptForCommand 仅用到 args，不依赖 ctx 字段；
    // 传一个最小占位 ctx 以满足签名。若将来某 skill 真的读 ctx，需在此补齐。
    const prompt = await this.cmd.getPromptForCommand(args, {} as CommandContext);

    const subAgent = SubAgent.fromRegistry(
      this.providerRegistry,
      this.toolRegistry,
      this.hookSystem,
    );
    if (this.permissionChecker) subAgent.setPermissionChecker(this.permissionChecker);

    const timeoutMins = this.cmd.timeoutMins;
    const result = await subAgent.executeCustom(
      {
        systemPrompt: "你是一个专注的助手，请完成以下任务。",
        userPrompt: prompt,
        allowedTools: this.cmd.allowedTools ?? [],
        // P2-2：内置 skill 若忘记声明 maxTurns 时的兜底默认，从 10 提到 30
        // （与 sub-agent.ts/skill/tool.ts 的常规子代理默认对齐；现有内置 skill 均已显式声明，不受影响）
        maxTurns: this.cmd.maxTurns ?? 30,
        timeout:
          timeoutMins != null
            ? Math.min(Math.max(timeoutMins, 1), 30) * 60_000
            : undefined,
        // G13：以内置 skill 名作为 agent 类型，让同一 skill 跨会话沉淀领域经验
        type: `skill:${this.cmd.name}`,
      },
      signal,
    );

    log.info("SKILL", `Bundled Skill ${this.cmd.name} 完成`, {
      success: result.success,
      turns: result.turns,
    });

    return {
      output: result.success ? result.output : `子代理执行失败: ${result.output}`,
      isError: !result.success,
    };
  }
}
