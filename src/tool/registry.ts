/**
 * 工具注册表（分层架构）
 *
 * Layer 1：静态注册（内置工具 + MCP 工具分开存储）
 * Layer 2：动态过滤与组装（isEnabled + deny rules + 模式裁剪 + prompt cache 排序）
 */

import type { LegacyTool as Tool } from "./types.ts";
import type { ToolDefinition } from "../llm/types.ts";

/** 工具池组装配置 */
export interface AssembleOptions {
  /** 权限规则（deny rules 过滤） */
  denyRules?: string[];
  /** 运行模式 */
  mode?: "normal" | "plan" | "simple";
  /** 子代理类型 */
  agentType?: string;
}

/** simple 模式下可用的工具 */
const SIMPLE_MODE_TOOLS = new Set([
  "read", "grep", "glob", "ls", "read_many",
]);

export class Registry {
  private builtInTools = new Map<string, Tool>();
  private mcpTools = new Map<string, Tool>();
  /** 延迟加载工具集合（预留给 ToolSearch） */
  private deferredTools = new Set<string>();

  // ===== Layer 1：静态注册 =====

  /** 注册工具（自动区分内置/MCP） */
  register(tool: Tool): void {
    const name = tool.name();
    if (name.startsWith("mcp__")) {
      this.mcpTools.set(name, tool);
    } else {
      this.builtInTools.set(name, tool);
    }
  }

  /** 根据名称查找工具（两层都查） */
  get(name: string): Tool | undefined {
    return this.builtInTools.get(name) ?? this.mcpTools.get(name);
  }

  /** 返回所有已注册的工具（内置优先，MCP 在后） */
  all(): Tool[] {
    return [...this.builtInTools.values(), ...this.mcpTools.values()];
  }

  // ===== Layer 2：动态过滤与组装 =====

  /**
   * 组装最终工具池
   * 内置工具在前（稳定顺序，利于 prompt cache），MCP 工具在后
   */
  assembleToolPool(options?: AssembleOptions): Tool[] {
    // 1. 内置工具过滤
    let builtIn = [...this.builtInTools.values()];

    // 2. deny rules 过滤
    if (options?.denyRules?.length) {
      const denySet = new Set(options.denyRules);
      builtIn = builtIn.filter(t => !denySet.has(t.name()));
    }

    // 3. 运行模式裁剪
    if (options?.mode === "simple") {
      builtIn = builtIn.filter(t => SIMPLE_MODE_TOOLS.has(t.name()));
    }

    // 4. MCP 工具（同样应用 deny rules，但不受模式裁剪影响）
    let mcp = [...this.mcpTools.values()];
    if (options?.denyRules?.length) {
      const denySet = new Set(options.denyRules);
      mcp = mcp.filter(t => !denySet.has(t.name()));
    }

    // 4.1 MCP 工具按名称排序，保证 prompt cache 稳定性。
    //   多个 MCP server 的连接顺序不确定，会导致工具定义顺序漂移，
    //   进而使 Anthropic prompt cache（基于 tools 定义内容哈希）失效。
    //   内置工具顺序是人工精心编排的（不排序），仅对 MCP 部分排序。
    mcp.sort((a, b) => a.name().localeCompare(b.name()));

    // 5. 内置工具在前（稳定顺序），MCP 工具在后
    return [...builtIn, ...mcp];
  }

  /** 返回所有工具的 LLM 定义（用于发送给 AI） */
  definitions(options?: AssembleOptions): ToolDefinition[] {
    const tools = options ? this.assembleToolPool(options) : this.all();
    const defs = tools.map((t) => {
      let desc = t.description();
      if (t.usageGuide) {
        const guide = t.usageGuide();
        if (guide) desc += `\n\n使用指南:\n${guide}`;
      }
      return {
        name: t.name(),
        description: desc,
        input_schema: t.inputSchema(),
      };
    });
    // D2 前缀稳定性：工具定义按 name 固定字典序输出，杜绝注册顺序抖动（尤其 MCP 异步连接顺序）
    // 废掉工具 schema 缓存前缀。序列化顺序只影响请求载荷的缓存前缀，不影响执行查找（按 name 索引）。
    defs.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    return defs;
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

  /** 移除名称以指定前缀开头的所有工具 */
  removeByPrefix(prefix: string): void {
    for (const name of this.builtInTools.keys()) {
      if (name.startsWith(prefix)) this.builtInTools.delete(name);
    }
    for (const name of this.mcpTools.keys()) {
      if (name.startsWith(prefix)) this.mcpTools.delete(name);
    }
  }

  /** 已注册工具数量 */
  size(): number {
    return this.builtInTools.size + this.mcpTools.size;
  }

  /** 内置工具数量 */
  builtInSize(): number {
    return this.builtInTools.size;
  }

  /** MCP 工具数量 */
  mcpSize(): number {
    return this.mcpTools.size;
  }

  // ===== Layer 3：延迟发现（预留架构） =====

  /** 标记工具为可延迟加载（未来 ToolSearch 使用） */
  markDeferred(toolName: string): void {
    this.deferredTools.add(toolName);
  }

  /** 取消延迟标记 */
  unmarkDeferred(toolName: string): void {
    this.deferredTools.delete(toolName);
  }

  /** 检查工具是否为延迟加载 */
  isDeferred(toolName: string): boolean {
    return this.deferredTools.has(toolName);
  }

  /** 获取非延迟工具的定义（用于初始 prompt，减少 token 消耗） */
  activeDefinitions(options?: AssembleOptions): ToolDefinition[] {
    const tools = options ? this.assembleToolPool(options) : this.all();
    return tools
      .filter(t => !this.deferredTools.has(t.name()))
      .map((t) => {
        let desc = t.description();
        if (t.usageGuide) {
          const guide = t.usageGuide();
          if (guide) desc += `\n\n使用指南:\n${guide}`;
        }
        return {
          name: t.name(),
          description: desc,
          input_schema: t.inputSchema(),
        };
      });
  }

  /** 搜索延迟工具（未来 ToolSearchTool 调用） */
  searchDeferredTools(query: string): Tool[] {
    const terms = query.toLowerCase().split(/\s+/);
    return [...this.deferredTools]
      .map(name => this.get(name))
      .filter((t): t is Tool => t !== undefined)
      .filter(t => {
        const text = `${t.name()} ${t.description()}`.toLowerCase();
        return terms.some(term => text.includes(term));
      });
  }

  /** 延迟工具数量 */
  deferredSize(): number {
    return this.deferredTools.size;
  }
}
