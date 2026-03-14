/**
 * 子代理工具
 * 让主代理可以 spawn 子代理执行子任务，子代理有独立的短上下文
 */

import type { Tool, ToolResult } from "../tool/types.ts";
import type { Provider } from "../llm/provider.ts";
import { Registry as ToolRegistry } from "../tool/registry.ts";
import { SubAgent } from "./sub-agent.ts";
import type { SubAgentType } from "./sub-agent.ts";
import { getLogger } from "../debug/logger.ts";

export class SubAgentTool implements Tool {
  private subAgent: SubAgent;

  constructor(provider: Provider, model: string, toolRegistry: ToolRegistry) {
    this.subAgent = new SubAgent(provider, model, toolRegistry);
  }

  name(): string {
    return "sub_agent";
  }

  description(): string {
    return `启动一个子代理来执行独立的子任务。子代理有自己独立的上下文，不会污染主对话。
适用场景：
- explore: 搜索和分析代码库，返回关键发现
- task: 执行特定的编码子任务
- summarize: 总结大量内容
子代理完成后只返回最终结果。`;
  }

  inputSchema(): Record<string, unknown> {
    return {
      type: "object",
      properties: {
        type: {
          type: "string",
          enum: ["explore", "task", "summarize"],
          description: "子代理类型：explore(代码探索)、task(任务执行)、summarize(内容总结)",
        },
        description: {
          type: "string",
          description: "子任务的简短描述",
        },
        prompt: {
          type: "string",
          description: "给子代理的详细指令",
        },
      },
      required: ["type", "description", "prompt"],
    };
  }

  async execute(input: unknown, signal?: AbortSignal): Promise<ToolResult> {
    const log = getLogger();
    const params = input as {
      type: SubAgentType;
      description: string;
      prompt: string;
    };

    if (!params.type || !params.description || !params.prompt) {
      return { output: "错误: 缺少必需参数 (type, description, prompt)", isError: true };
    }

    const validTypes: SubAgentType[] = ["explore", "task", "summarize"];
    if (!validTypes.includes(params.type)) {
      return { output: `错误: 无效的子代理类型 "${params.type}"，可选: ${validTypes.join(", ")}`, isError: true };
    }

    try {
      const result = await this.subAgent.execute(
        {
          type: params.type,
          description: params.description,
          prompt: params.prompt,
        },
        signal,
      );

      const summary = [
        `[子代理完成] 类型: ${params.type}, 轮次: ${result.turns}`,
        `Token 用量: input=${result.usage.inputTokens}, output=${result.usage.outputTokens}`,
        "",
        result.output,
      ].join("\n");

      return { output: summary };
    } catch (err: any) {
      log.error("SUBAGENT", `子代理执行失败`, { error: err.message, stack: err.stack });
      return { output: `子代理执行失败: ${err.message}`, isError: true };
    }
  }
}
