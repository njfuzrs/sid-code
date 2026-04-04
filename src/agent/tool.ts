/**
 * 子代理工具
 * 让主代理可以 spawn 子代理执行子任务，子代理有独立的短上下文
 */

import type { LegacyTool as Tool, LegacyToolResult as ToolResult } from "../tool/types.ts";
import type { ProviderRegistry } from "../llm/registry.ts";
import { Registry as ToolRegistry } from "../tool/registry.ts";
import { SubAgent } from "./sub-agent.ts";
import type { SubAgentType } from "./sub-agent.ts";
import { getLogger } from "../debug/logger.ts";

export class SubAgentTool implements Tool {
  private providerRegistry: ProviderRegistry;
  private toolRegistry: ToolRegistry;

  /** 并发控制 */
  static running = 0;
  static readonly MAX_CONCURRENT = 3;

  constructor(providerRegistry: ProviderRegistry, toolRegistry: ToolRegistry) {
    this.providerRegistry = providerRegistry;
    this.toolRegistry = toolRegistry;
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
- plan: 分析代码库并输出结构化的实现方案
子代理完成后只返回最终结果。`;
  }

  inputSchema(): Record<string, unknown> {
    return {
      type: "object",
      properties: {
        type: {
          type: "string",
          enum: ["explore", "task", "summarize", "plan"],
          description: "子代理类型：explore(代码探索)、task(任务执行)、summarize(内容总结)、plan(代码分析和规划)",
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

    // 并发控制
    if (SubAgentTool.running >= SubAgentTool.MAX_CONCURRENT) {
      return { output: `子代理并发数已达上限(${SubAgentTool.MAX_CONCURRENT})，请等待其他子代理完成`, isError: true };
    }

    const params = input as {
      type: SubAgentType;
      description: string;
      prompt: string;
    };

    if (!params.type || !params.description || !params.prompt) {
      return { output: "错误: 缺少必需参数 (type, description, prompt)", isError: true };
    }

    const validTypes: SubAgentType[] = ["explore", "task", "summarize", "plan"];
    if (!validTypes.includes(params.type)) {
      return { output: `错误: 无效的子代理类型 "${params.type}"，可选: ${validTypes.join(", ")}`, isError: true };
    }

    SubAgentTool.running++;
    try {
      // 每次执行创建新 SubAgent（轻量对象，通过 registry 动态获取 provider/model）
      const subAgent = SubAgent.fromRegistry(this.providerRegistry, this.toolRegistry);

      const result = await subAgent.execute(
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
    } finally {
      SubAgentTool.running--;
    }
  }
}
