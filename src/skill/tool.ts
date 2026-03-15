/**
 * Skill 工具
 * 将 SkillDefinition 包装为 Tool 接口，LLM 可自动调用
 */

import type { Tool, ToolResult } from "../tool/types.ts";
import type { Provider } from "../llm/provider.ts";
import type { Registry as ToolRegistry } from "../tool/registry.ts";
import { SubAgent } from "../agent/sub-agent.ts";
import { getLogger } from "../debug/logger.ts";
import type { SkillDefinition } from "./types.ts";

export class SkillTool implements Tool {
  private skill: SkillDefinition;
  private provider: Provider;
  private model: string;
  private toolRegistry: ToolRegistry;

  constructor(skill: SkillDefinition, provider: Provider, model: string, toolRegistry: ToolRegistry) {
    this.skill = skill;
    this.provider = provider;
    this.model = model;
    this.toolRegistry = toolRegistry;
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
    return {
      type: "object",
      properties: {
        input: {
          type: "string",
          description: this.skill.argumentHint || "传递给 Skill 的输入参数",
        },
      },
      required: ["input"],
    };
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
    const log = getLogger();
    const params = input as { input: string };
    const userInput = params.input || "";

    log.info("SKILL", `执行 Skill: ${this.skill.name}`, { input: userInput.slice(0, 200) });

    // 构建用户提示词：Skill 模板 + 用户输入
    const userPrompt = this.skill.prompt + (userInput ? `\n\n用户输入:\n${userInput}` : "");

    const subAgent = new SubAgent(
      this.provider,
      this.skill.model || this.model,
      this.toolRegistry,
    );

    const result = await subAgent.executeCustom({
      systemPrompt: `你是一个专门执行 "${this.skill.name}" 任务的代理。${this.skill.description}`,
      userPrompt,
      allowedTools: this.skill.allowedTools || [],
      maxTurns: 10,
      timeout: 120_000,
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
