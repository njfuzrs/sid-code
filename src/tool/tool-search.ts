/**
 * ToolSearchTool — 工具目录搜索 / 延迟工具按需调出
 *
 * 对标 claude-code ToolSearchTool。工具数膨胀（50+ MCP 工具）时，全部塞进首轮
 * LLM 上下文会线性吞 token。延迟加载机制让长尾工具默认不进上下文（shouldDefer），
 * 由模型经本工具按需搜索并激活——激活后该工具进入后续轮次的首轮上下文。
 *
 * 双模式：
 * 1. select:<tool_name>[,<tool_name>...] —— 精确激活指定工具（模型已知名时跳过搜索）
 * 2. 关键词搜索 —— 在延迟工具的 name/description/searchHint 上做分词匹配
 *
 * 与 registry 的协作：
 * - searchDeferredTools(query)：关键词匹配延迟工具
 * - activateTool(name)：把工具从"延迟"切到"激活"，下一轮进上下文
 * - 仅当 config.toolSearch 开启、主循环改用 activeDefinitions 时，激活才真正影响上下文。
 */

import type { LegacyTool as Tool, LegacyToolResult as ToolResult } from "./types.ts";
import type { Registry as ToolRegistry } from "./registry.ts";
import { getLogger } from "../debug/logger.ts";
import { z } from "zod/v4";
import { lazySchema } from "../sdk/lazy-schema.ts";

const SELECT_PREFIX = "select:";

const toolSearchSchema = lazySchema(() =>
  z.object({
    query: z
      .string()
      .describe(
        '搜索词，用于发现当前未加载的延迟工具。也可用 "select:<工具名>" 精确激活已知工具，' +
          '多个用逗号分隔，如 "select:notebook_edit,notebook_read"。',
      ),
    max_results: z
      .number()
      .int()
      .positive()
      .optional()
      .default(5)
      .describe("返回的最大匹配数（默认 5）"),
  }),
);

export class ToolSearchTool implements Tool {
  private registry: ToolRegistry;

  /**
   * 可选：返回"仍在连接中"的 MCP server 名列表。
   *
   * 注入而非直连 MCP manager——保持工具与 MCP 子系统解耦、便于单测。
   * CLI 启动初期 MCP 异步连接尚未完成时，搜索无果若不提示 pending，模型会误判
   * "工具不存在"而放弃；有此回调则追加"稍后重试"提示（对标 claude-code
   * pending_mcp_servers）。未注入时行为不变。
   */
  private pendingMcpServers?: () => string[];

  /** zod schema：执行器据此做运行时校验，registry 据此生成 LLM 定义 */
  readonly zodSchema = toolSearchSchema();

  /**
   * 强制首轮可见：ToolSearch 是"调出其它延迟工具"的唯一入口，自身绝不能被延迟，
   * 否则模型永远无法发现延迟工具，整个机制死锁。
   */
  readonly alwaysLoad = true;

  readonly searchHint = "search discover deferred tools 搜索 工具 发现";

  constructor(registry: ToolRegistry) {
    this.registry = registry;
  }

  /**
   * 注入 MCP pending server 检测回调。
   *
   * 由 cli.ts 在 MCPManager 创建后回填——ToolSearchTool 注册时 MCP 可能尚未初始化，
   * 延迟注入避免循环依赖（与 setHookSystem / setUsageSink 同一模式）。
   */
  setPendingMcpServers(fn: () => string[]): void {
    this.pendingMcpServers = fn;
  }

  name(): string {
    return "tool_search";
  }

  description(): string {
    return (
      "搜索并激活当前未加载到上下文的延迟工具。当你需要某个工具但它不在可用工具列表里时，" +
      '用本工具按关键词搜索；若已知工具名，用 "select:<工具名>" 直接激活。' +
      "激活后该工具会出现在后续轮次的可用工具列表中，即可正常调用。"
    );
  }

  inputSchema(): Record<string, unknown> {
    return z.toJSONSchema(toolSearchSchema()) as Record<string, unknown>;
  }

  /** 只读：仅查询/激活工具元数据，不触碰文件系统或外部状态 */
  readOnly(): boolean {
    return true;
  }

  isConcurrencySafe(): boolean {
    return true;
  }

  async execute(input: unknown): Promise<ToolResult> {
    const log = getLogger();
    const params = input as { query: string; max_results?: number };
    const query = (params.query || "").trim();
    const maxResults = params.max_results ?? 5;

    if (!query) {
      return { output: "错误: query 不能为空", isError: true };
    }

    // 模式 1：select:<tool_name>[,...] 精确激活
    if (query.toLowerCase().startsWith(SELECT_PREFIX)) {
      const names = query
        .slice(SELECT_PREFIX.length)
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
      return this.selectTools(names, log);
    }

    // 模式 2：关键词搜索
    return this.searchTools(query, maxResults, log);
  }

  /** 精确激活模式 */
  private selectTools(
    names: string[],
    log: ReturnType<typeof getLogger>,
  ): ToolResult {
    if (names.length === 0) {
      return { output: "错误: select: 后未指定任何工具名", isError: true };
    }

    const activated: string[] = [];
    const alreadyVisible: string[] = [];
    const notFound: string[] = [];

    for (const name of names) {
      const tool = this.registry.get(name);
      if (!tool) {
        notFound.push(name);
        continue;
      }
      // activateTool 返回 false 有两种情况：未注册（上面已拦）或本就可见
      if (this.registry.activateTool(name)) {
        activated.push(name);
      } else {
        alreadyVisible.push(name);
      }
    }

    log.info("TOOL_SEARCH", `select 激活: ${activated.join(", ") || "(无)"}`, {
      alreadyVisible,
      notFound,
    });

    const lines: string[] = [];
    if (activated.length > 0) {
      lines.push(`已激活 ${activated.length} 个工具，将在下一轮出现在可用工具列表中：`);
      for (const name of activated) {
        const tool = this.registry.get(name)!;
        lines.push(`  - ${name}: ${tool.description().split("\n")[0]}`);
      }
    }
    if (alreadyVisible.length > 0) {
      lines.push(`以下工具本就可用，无需激活：${alreadyVisible.join(", ")}`);
    }
    if (notFound.length > 0) {
      lines.push(`未找到以下工具：${notFound.join(", ")}`);
    }

    return { output: lines.join("\n"), isError: false };
  }

  /** 关键词搜索模式 */
  private searchTools(
    query: string,
    maxResults: number,
    log: ReturnType<typeof getLogger>,
  ): ToolResult {
    // 快路径：query 恰好是某工具名（含延迟与已加载）。模型常不带 select: 前缀直接
    // 写工具名（子代理 / compact 后高发），按名直选避免无谓的关键词匹配与重试churn。
    // 对标 claude-code searchTools 的 exactMatch fast path。
    const exact = this.registry.get(query.trim());
    if (exact) {
      return this.selectTools([query.trim()], log);
    }

    const matches = this.registry.searchDeferredTools(query).slice(0, maxResults);

    log.info("TOOL_SEARCH", `关键词搜索 "${query}" 命中 ${matches.length} 个延迟工具`);

    if (matches.length === 0) {
      const total = this.registry.deferredSize();
      const base =
        total === 0
          ? `没有找到匹配 "${query}" 的工具，且当前没有任何延迟工具（所有工具已在上下文中）。`
          : `没有找到匹配 "${query}" 的延迟工具（共 ${total} 个延迟工具）。请换用其它关键词，` +
            `或用 "select:<工具名>" 直接激活已知工具。`;
      return {
        output: base + this.pendingMcpHint(),
        isError: false,
      };
    }

    // 命中即激活：搜到的工具直接调出，省去模型再发一次 select 的往返
    const lines: string[] = [`找到 ${matches.length} 个匹配 "${query}" 的工具并已激活，将在下一轮可用：`];
    for (const tool of matches) {
      const name = tool.name();
      this.registry.activateTool(name);
      const firstLine = tool.description().split("\n")[0];
      lines.push(`  - ${name}: ${firstLine}`);
    }

    return { output: lines.join("\n"), isError: false };
  }

  /**
   * 生成 MCP pending server 提示（无 pending 或未注入回调时返回空串）。
   *
   * 搜索/select 无果时追加，告诉模型"某些 MCP server 仍在连接中，稍后重试可能发现更多工具"——
   * 避免 CLI 启动初期（MCP 异步连接未完成）模型误判工具不存在而放弃。
   */
  private pendingMcpHint(): string {
    if (!this.pendingMcpServers) return "";
    const pending = this.pendingMcpServers();
    if (!pending || pending.length === 0) return "";
    return (
      `\n\n注意：以下 MCP 服务器仍在连接中，稍后重试可能发现更多工具：${pending.join(", ")}`
    );
  }
}
