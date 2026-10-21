/**
 * Bundled Skill 工具包装器（Gap 1）
 *
 * 背景：磁盘 Skill 通过 `Skill` 元工具（SkillMetaTool）暴露给模型，可自动调用；而 Bundled Skill
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
 *     skill（如 pr-workflow）应显式 disableModelInvocation，
 *     避免模型在无显式指令时自主 push / 建 PR。只读的 review 适合暴露。
 */

import type { LegacyTool as Tool, LegacyToolResult as ToolResult } from "../../tool/types.ts";
import type { ProviderRegistry } from "../../llm/registry.ts";
import type { Registry as ToolRegistry } from "../../tool/registry.ts";
import type { HookSystem } from "../../hook/system.ts";
import type {
  UnifiedCommand,
  PromptCommand,
  CommandContext,
} from "../../command-contract/types.ts";
import { runForkedCommand } from "../../agent/forked-command.ts";
import { resolveAgent } from "../../agent/agent-definition.ts";
import { parseAllowedToolsSpec } from "../../tool/allowed-tools-spec.ts";
import { getLogger } from "../../debug/logger.ts";
import { emitSkillInvoked } from "../telemetry.ts";
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

  /** M-1：自报需要权限检查器（契约见 tool/types.ts ToolCapabilityFields），wire 时与 setter 对账。 */
  readonly needsPermissionChecker = true;

  /**
   * B3：注入禁用态查询（生产传 SkillManager.isNameDisabled，与 slash 路径共享同一份名单）。
   * 传函数而非快照：/skills disable 运行时改名单，工具须当场失效、启用后当场恢复。
   */
  setDisabledQuery(query: (name: string) => boolean): void {
    this.isDisabled = query;
  }
  private isDisabled?: (name: string) => boolean;

  name(): string {
    return `skill__${this.cmd.name}`;
  }

  /** 被禁用时不进模型 schema（registry 的 isEnabled 过滤） */
  isEnabled(): boolean {
    return !this.isDisabled?.(this.cmd.name);
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
    // 方案 E：由 agent 类型推导（allowed-tools 已不是工具白名单，不能再据此判只读）
    if (!this.cmd.agent) return false;
    return resolveAgent(this.cmd.agent)?.readOnly === true;
  }

  async execute(input: unknown, signal?: AbortSignal): Promise<ToolResult> {
    const log = getLogger();
    const args = (input as { input?: string })?.input ?? "";

    // B3：isEnabled 只把工具挡出 schema；模型凭历史上下文按名直调仍会到这里，执行层再拦一次
    //（与 SkillMetaTool 的 skill.disabled guard 同口径）。
    if (this.isDisabled?.(this.cmd.name)) {
      return { output: `错误：Skill "${this.cmd.name}" 已被禁用。`, isError: true };
    }

    // 注：CommandContext 在工具调用场景下不可用（工具没有命令执行上下文）。
    // bundled skill 的 getPromptForCommand 仅用到 args，不依赖 ctx 字段；
    // 传一个最小占位 ctx 以满足签名。若将来某 skill 真的读 ctx，需在此补齐。
    const prompt = await this.cmd.getPromptForCommand(args, {} as CommandContext);
    // 本地轨迹的 skill 调用埋点（模型路径 · bundled fork skill，如 review）
    emitSkillInvoked({ name: this.cmd.name, via: "model", loadedFrom: "bundled" });

    // P3：统一入口——必注入 checker；工具集按 agent 类型，allowed-tools 只作本次 fork 的 allow 规则
    const result = await runForkedCommand({
      providerRegistry: this.providerRegistry,
      toolRegistry: this.toolRegistry,
      hookSystem: this.hookSystem,
      permissionChecker: this.permissionChecker ?? null,
      name: this.cmd.name,
      prompt,
      allowedRules: this.cmd.allowedTools
        ? parseAllowedToolsSpec(this.cmd.allowedTools)
        : undefined,
      trusted: true, // bundled 随二进制发布，可信
      agentType: this.cmd.agent,
      // PR-B：未声明即无上限，对齐 CC（不再 `?? 30` 兜底；timeoutMins 不再换算成墙钟）
      maxTurns: this.cmd.maxTurns,
      // G13：以内置 skill 名作为 agent 类型，让同一 skill 跨会话沉淀领域经验
      type: `skill:${this.cmd.name}`,
      signal,
    });

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
