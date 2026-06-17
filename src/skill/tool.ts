/**
 * Skill 工具
 * 将 SkillDefinition 包装为 Tool 接口，LLM 可自动调用
 */

import type { LegacyTool as Tool, LegacyToolResult as ToolResult } from "../tool/types.ts";
import type { ProviderRegistry } from "../llm/registry.ts";
import type { Registry as ToolRegistry } from "../tool/registry.ts";
import { SubAgent } from "../agent/sub-agent.ts";
import { getLogger } from "../debug/logger.ts";
import type { SkillDefinition } from "./types.ts";
import { scanSkillResources } from "./resources.ts";
import { dirname } from "node:path";
import { z } from "zod/v4";

/**
 * Skill 工具输入 schema 工厂 —— 运行时校验 + JSON Schema 生成的唯一真相源。
 *
 * 动态注册的工具（每个 skill 一个实例）此前绕过执行器的 zod 校验，模型给畸形
 * 参数（如 input:123）会带病走到 executeDelegate 内部。这里补上 zodSchema 后，
 * query/agent 两个 executor 的 safeParse 在工具边界统一拦截。
 * description 取 skill 的 argumentHint（逐 skill 不同），故按实例构造。
 */
function buildSkillSchema(argumentHint?: string) {
  return z.object({
    input: z.string().describe(argumentHint || "传递给 Skill 的输入参数"),
  });
}

export class SkillTool implements Tool {
  private skill: SkillDefinition;
  private providerRegistry: ProviderRegistry;
  private toolRegistry: ToolRegistry;

  /** zod schema：执行器据此做运行时校验，registry 据此生成 LLM 定义 */
  readonly zodSchema: z.ZodType;

  constructor(skill: SkillDefinition, providerRegistry: ProviderRegistry, toolRegistry: ToolRegistry) {
    this.skill = skill;
    this.providerRegistry = providerRegistry;
    this.toolRegistry = toolRegistry;
    this.zodSchema = buildSkillSchema(skill.argumentHint);
  }

  name(): string {
    return `skill__${this.skill.name}`;
  }

  description(): string {
    let desc = this.skill.description;
    if (this.skill.whenToUse) {
      desc += `\n何时使用: ${this.skill.whenToUse}`;
    }
    return desc;
  }

  inputSchema(): Record<string, unknown> {
    return z.toJSONSchema(this.zodSchema) as Record<string, unknown>;
  }

  readOnly(): boolean {
    // Skill 可能执行写操作，取决于 allowedTools
    const writeTools = ["write", "edit", "bash"];
    if (this.skill.allowedTools) {
      return !this.skill.allowedTools.some(t => writeTools.includes(t));
    }
    return true;
  }

  async execute(input: unknown, signal?: AbortSignal): Promise<ToolResult> {
    const mode = this.skill.mode || "delegate";

    if (mode === "activate") {
      return this.executeActivate(input);
    }
    return this.executeDelegate(input, signal);
  }

  /**
   * 激活模式：将 Skill 指令和资源目录注入当前对话上下文
   */
  private async executeActivate(input: unknown): Promise<ToolResult> {
    const log = getLogger();
    const params = input as { input: string };
    const userInput = params.input || "";

    log.info("SKILL", `激活 Skill: ${this.skill.name}`, { mode: "activate" });

    const skillDir = dirname(this.skill.filePath);
    const folderStructure = await scanSkillResources(skillDir);

    const output = `<activated_skill name="${this.skill.name}">
  <instructions>
${this.skill.prompt}
  </instructions>
${folderStructure ? `\n  <available_resources>\n${folderStructure}\n  </available_resources>` : ""}
</activated_skill>

Skill "${this.skill.name}" 已激活。${userInput ? `\n\n用户输入: ${userInput}` : ""}`;

    return {
      output,
      isError: false,
    };
  }

  /**
   * 委托模式：通过 SubAgent 独立执行
   */
  private async executeDelegate(input: unknown, signal?: AbortSignal): Promise<ToolResult> {
    const log = getLogger();
    const params = input as { input: string };
    const userInput = params.input || "";

    log.info("SKILL", `执行 Skill: ${this.skill.name}`, { mode: "delegate", input: userInput.slice(0, 200) });

    // 构建用户提示词：Skill 模板 + 用户输入
    const userPrompt = this.skill.prompt + (userInput ? `\n\n用户输入:\n${userInput}` : "");

    // 通过 registry 创建 SubAgent，skill.model 作为 modelOverride
    const subAgent = SubAgent.fromRegistry(
      this.providerRegistry,
      this.toolRegistry,
      undefined,
      this.skill.model,
    );

    // 使用配置的 maxTurns 和 timeout
    const maxTurns = Math.min(this.skill.maxTurns || 10, 50);
    const timeoutMins = Math.min(this.skill.timeoutMins || 2, 30);
    const timeout = timeoutMins * 60_000;

    const result = await subAgent.executeCustom({
      systemPrompt: `你是一个专门执行 "${this.skill.name}" 任务的代理。${this.skill.description}`,
      userPrompt,
      allowedTools: this.skill.allowedTools || [],
      maxTurns,
      timeout,
    }, signal);

    log.info("SKILL", `Skill ${this.skill.name} 完成`, {
      success: result.success,
      turns: result.turns,
    });

    return {
      output: result.output,
      isError: !result.success,
    };
  }
}
