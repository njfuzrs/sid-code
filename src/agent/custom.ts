/**
 * 自定义 Agent
 * 从 .sid-code/agents/*.md 加载用户自定义 Agent 定义
 * 每个 Agent 包装为 Tool，LLM 可自动调用
 */

import type { LegacyTool as Tool, LegacyToolResult as ToolResult } from "../tool/types.ts";
import type { ProviderRegistry } from "../llm/registry.ts";
import type { Registry as ToolRegistry } from "../tool/registry.ts";
import { ExtensionLoader } from "../extension/loader.ts";
import type { ScanOptions } from "../extension/types.ts";
import { SubAgent } from "./sub-agent.ts";
import { getLogger } from "../debug/logger.ts";
import type { ExtensionSource } from "../extension/types.ts";
import { z } from "zod/v4";

/**
 * 自定义 Agent 工具输入 schema —— 运行时校验 + JSON Schema 生成的唯一真相源。
 *
 * 动态注册（每个自定义 agent 一个实例），所有实例 schema 相同（固定 task 字段），
 * 故用模块级常量。补上后 executor 的 safeParse 在工具边界拦截畸形 task 参数。
 */
const customAgentSchema = z.object({
  task: z.string().describe("要执行的任务描述"),
});

/** 自定义 Agent 定义 */
export interface CustomAgentDefinition {
  name: string;
  description: string;
  tools: string[];
  prompt: string;
  source: ExtensionSource;
  filePath: string;
}

/** 自定义 Agent 加载器 */
export class CustomAgentLoader {
  private extensionLoader: ExtensionLoader;

  constructor(extensionLoader?: ExtensionLoader) {
    this.extensionLoader = extensionLoader ?? new ExtensionLoader();
  }

  /** 加载所有自定义 Agent 定义 */
  async loadAll(projectDir?: string, scanOptions?: ScanOptions): Promise<CustomAgentDefinition[]> {
    const log = getLogger();
    const files = await this.extensionLoader.scan("agents", projectDir ?? process.cwd(), scanOptions);
    const agents: CustomAgentDefinition[] = [];

    for (const file of files) {
      const fm = file.frontmatter;

      // 解析 tools（支持逗号分隔字符串或数组）
      let tools: string[] = [];
      const rawTools = fm.tools;
      if (typeof rawTools === "string") {
        tools = rawTools.split(",").map(s => s.trim()).filter(Boolean);
      } else if (Array.isArray(rawTools)) {
        tools = rawTools.map(String);
      }

      agents.push({
        name: (fm.name as string) || file.name,
        description: (fm.description as string) || "",
        tools,
        prompt: file.body,
        source: file.source,
        filePath: file.filePath,
      });
    }

    if (agents.length > 0) {
      log.info("CUSTOM_AGENT", `加载了 ${agents.length} 个自定义 Agent`, {
        names: agents.map(a => a.name),
      });
    }

    return agents;
  }
}

/** 自定义 Agent 工具（包装为 Tool 接口） */
export class CustomAgentTool implements Tool {
  private def: CustomAgentDefinition;
  private providerRegistry: ProviderRegistry;
  private toolRegistry: ToolRegistry;
  /** 子代理 usage 归集 sink（P0-1，由主会话注入） */
  private usageSink?: import("./tool.ts").SubAgentUsageSink;

  /** zod schema：执行器据此做运行时校验，registry 据此生成 LLM 定义 */
  readonly zodSchema = customAgentSchema;

  constructor(def: CustomAgentDefinition, providerRegistry: ProviderRegistry, toolRegistry: ToolRegistry) {
    this.def = def;
    this.providerRegistry = providerRegistry;
    this.toolRegistry = toolRegistry;
  }

  /** 注入 usage 归集 sink（P0-1） */
  setUsageSink(sink: import("./tool.ts").SubAgentUsageSink): void {
    this.usageSink = sink;
  }

  name(): string {
    return `agent__${this.def.name}`;
  }

  description(): string {
    return this.def.description || `自定义 Agent: ${this.def.name}`;
  }

  inputSchema(): Record<string, unknown> {
    return z.toJSONSchema(customAgentSchema) as Record<string, unknown>;
  }

  readOnly(): boolean {
    const writeTools = ["write", "edit", "bash"];
    return !this.def.tools.some(t => writeTools.includes(t));
  }

  async execute(input: unknown, signal?: AbortSignal): Promise<ToolResult> {
    const log = getLogger();
    const params = input as { task: string };
    const task = params.task || "";

    log.info("CUSTOM_AGENT", `执行自定义 Agent: ${this.def.name}`, { task: task.slice(0, 200) });

    const subAgent = SubAgent.fromRegistry(this.providerRegistry, this.toolRegistry);

    const result = await subAgent.executeCustom({
      systemPrompt: this.def.prompt,
      userPrompt: task,
      allowedTools: this.def.tools,
      maxTurns: 10,
      timeout: 120_000,
    }, signal);

    // P0-1：把自定义子代理消耗的 token/费用回写主会话
    if (this.usageSink) {
      const u = result.usage;
      const hasUsage = (u?.inputTokens ?? 0) > 0 || (u?.outputTokens ?? 0) > 0 ||
        (u?.cacheReadInputTokens ?? 0) > 0 || (u?.cacheCreationInputTokens ?? 0) > 0;
      if (hasUsage) {
        try { this.usageSink(result); }
        catch (err: any) { log.warn("CUSTOM_AGENT", `usage 归集失败（不影响结果）: ${err?.message}`); }
      }
    }

    log.info("CUSTOM_AGENT", `Agent ${this.def.name} 完成`, {
      success: result.success,
      turns: result.turns,
    });

    return {
      output: result.output,
      isError: !result.success,
    };
  }
}
