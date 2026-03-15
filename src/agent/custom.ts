/**
 * 自定义 Agent
 * 从 .sid-code/agents/*.md 加载用户自定义 Agent 定义
 * 每个 Agent 包装为 Tool，LLM 可自动调用
 */

import type { Tool, ToolResult } from "../tool/types.ts";
import type { Provider } from "../llm/provider.ts";
import type { Registry as ToolRegistry } from "../tool/registry.ts";
import { ExtensionLoader } from "../extension/loader.ts";
import { SubAgent } from "./sub-agent.ts";
import { getLogger } from "../debug/logger.ts";
import type { ExtensionSource } from "../extension/types.ts";

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
  async loadAll(projectDir?: string): Promise<CustomAgentDefinition[]> {
    const log = getLogger();
    const files = await this.extensionLoader.scan("agents", projectDir ?? process.cwd());
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
  private provider: Provider;
  private model: string;
  private toolRegistry: ToolRegistry;

  constructor(def: CustomAgentDefinition, provider: Provider, model: string, toolRegistry: ToolRegistry) {
    this.def = def;
    this.provider = provider;
    this.model = model;
    this.toolRegistry = toolRegistry;
  }

  name(): string {
    return `agent__${this.def.name}`;
  }

  description(): string {
    return this.def.description || `自定义 Agent: ${this.def.name}`;
  }

  inputSchema(): Record<string, unknown> {
    return {
      type: "object",
      properties: {
        task: {
          type: "string",
          description: "要执行的任务描述",
        },
      },
      required: ["task"],
    };
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

    const subAgent = new SubAgent(this.provider, this.model, this.toolRegistry);

    const result = await subAgent.executeCustom({
      systemPrompt: this.def.prompt,
      userPrompt: task,
      allowedTools: this.def.tools,
      maxTurns: 10,
      timeout: 120_000,
    }, signal);

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
