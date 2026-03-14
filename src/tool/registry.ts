/**
 * 工具注册表
 * 管理所有已注册的工具，提供查找和列举功能
 */

import type { Tool } from "./types.ts";
import type { ToolDefinition } from "../llm/types.ts";

export class Registry {
  private tools = new Map<string, Tool>();

  /** 注册一个工具 */
  register(tool: Tool): void {
    this.tools.set(tool.name(), tool);
  }

  /** 根据名称查找工具 */
  get(name: string): Tool | undefined {
    return this.tools.get(name);
  }

  /** 返回所有已注册的工具 */
  all(): Tool[] {
    return Array.from(this.tools.values());
  }

  /** 返回所有工具的 LLM 定义（用于发送给 AI） */
  definitions(): ToolDefinition[] {
    return this.all().map((t) => ({
      name: t.name(),
      description: t.description(),
      input_schema: t.inputSchema(),
    }));
  }

  /** 按名称过滤，返回只包含指定工具的新 Registry */
  filter(names: string[]): Registry {
    const filtered = new Registry();
    for (const name of names) {
      const tool = this.get(name);
      if (tool) filtered.register(tool);
    }
    return filtered;
  }

  /** 已注册工具数量 */
  size(): number {
    return this.tools.size;
  }
}
