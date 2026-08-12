/**
 * `sid-code mcp serve` 入口（G5：把 sid-code 自身工具暴露为 MCP server）
 *
 * 对齐 CC `entrypoints/mcp.ts` startMCPServer：用 stdio 传输承载一个 JSON-RPC server，
 * 声明 `tools` 能力，`tools/list` 暴露内置工具、`tools/call` 执行工具。其他 MCP client
 * （Claude Desktop / 另一个 sid-code / 任意 MCP 宿主）可用
 *   {"command":"sid-code","args":["mcp","serve"]}
 * 把 sid-code 当作被集成的工具后端。
 *
 * 安全（重点）：对外暴露工具 = 给外部 client 在本机执行命令的能力。默认**只暴露只读工具**
 * （read/grep/glob/ls/read_many/web_fetch/web_search/lsp）；写/执行类工具（bash/edit/write…）
 * 需显式 `--allow-write` 才暴露。这是比"全量暴露"更保守的默认，防止把 mcp serve 配进
 * 不受信任的宿主时被反向利用。
 *
 * stdout 协议独占：JSON-RPC 消息只走 stdout，所有日志/诊断必须走 stderr，否则污染协议流。
 */

import type {
  JsonRpcRequest,
  JsonRpcResponse,
  MCPToolDefinition,
} from "@sid-code/core/mcp/types.ts";
import { CLIENT_PROTOCOL_VERSION } from "@sid-code/core/mcp/client.ts";
import { getRawVersion } from "@sid-code/shared/version.ts";
import type { LegacyTool } from "@sid-code/core/tool/types.ts";

/** 只读工具白名单（默认对外暴露的工具名）。 */
const READ_ONLY_TOOL_NAMES = new Set<string>([
  "read",
  "read_many",
  "grep",
  "glob",
  "ls",
  "web_fetch",
  "web_search",
  "lsp",
]);

/** 判定一个工具是否只读（优先工具自报 readOnly()，回退白名单）。 */
function isToolReadOnly(tool: LegacyTool): boolean {
  try {
    if (typeof tool.readOnly === "function") return tool.readOnly() === true;
  } catch {
    // 忽略，回退白名单
  }
  return READ_ONLY_TOOL_NAMES.has(tool.name());
}

/** stderr 日志（不能用 stdout，会污染 JSON-RPC 协议流）。 */
function logStderr(msg: string): void {
  try {
    process.stderr.write(`[mcp-serve] ${msg}\n`);
  } catch {
    // 忽略
  }
}

/**
 * 组装对外暴露的工具集。默认只只读工具；allowWrite=true 时暴露全部内置工具（不含 MCP 转发工具）。
 * 排除 mcp__ 前缀工具（避免把上游 MCP server 的工具二次转发，语义混乱）与需要交互 UI 的工具。
 */
async function buildServeTools(allowWrite: boolean): Promise<LegacyTool[]> {
  const { FileReadTracker } = await import("@sid-code/core/tool/file-read-tracker.ts");
  const { createStatefulTools } = await import("@sid-code/core/tool/stateful-tools.ts");
  const { BashTool } = await import("@sid-code/core/tool/bash.ts");
  const { GrepTool } = await import("@sid-code/core/tool/grep.ts");
  const { GlobTool } = await import("@sid-code/core/tool/glob.ts");
  const { LsTool } = await import("@sid-code/core/tool/ls.ts");
  const { WebFetchTool } = await import("@sid-code/core/tool/web-fetch.ts");
  const { LSPTool } = await import("@sid-code/core/tool/lsp.ts");
  const { createSearchBackend } = await import("@sid-code/core/tool/search-backends/factory.ts");
  const { WebSearchTool } = await import("@sid-code/core/tool/web-search.ts");

  const tracker = new FileReadTracker();
  const all: LegacyTool[] = [
    ...createStatefulTools(tracker), // read / edit / read_many / write
    new BashTool(),
    new GrepTool(),
    new GlobTool(),
    new LsTool(),
    new WebFetchTool(),
    new LSPTool(),
    new WebSearchTool(createSearchBackend()),
  ];

  // 默认只暴露只读工具；--allow-write 放开全部。
  return allowWrite ? all : all.filter((t) => isToolReadOnly(t));
}

/** LegacyTool → MCP 工具定义（inputSchema 已是 JSON Schema）。 */
function toMcpToolDef(tool: LegacyTool): MCPToolDefinition {
  let inputSchema: Record<string, unknown>;
  try {
    inputSchema = tool.inputSchema();
  } catch {
    inputSchema = { type: "object", properties: {} };
  }
  return {
    name: tool.name(),
    description: tool.description(),
    inputSchema,
    annotations: { readOnlyHint: isToolReadOnly(tool) },
  };
}

/**
 * 运行 MCP server（读 stdin，写 stdout，直到 EOF）。
 *
 * @param args `mcp serve` 之后的参数（识别 `--allow-write`）。
 */
export async function runMcpServe(args: string[]): Promise<void> {
  const allowWrite = args.includes("--allow-write");

  const { handler, tools } = await createMcpServeHandler(allowWrite);

  logStderr(
    `启动 MCP server（协议 ${CLIENT_PROTOCOL_VERSION}），暴露 ${tools.length} 个工具` +
      `${allowWrite ? "（--allow-write：含写/执行类工具）" : "（默认仅只读工具，加 --allow-write 放开写类）"}: ` +
      tools.map((t) => t.name()).join(", "),
  );

  const { StdioServerTransport } = await import("@sid-code/core/mcp/server-transport.ts");

  const transport = new StdioServerTransport({
    onRequest: handler,
    onNotification: (n) => {
      // notifications/initialized 等通知：忽略即可。
      logStderr(`收到通知: ${n.method}`);
    },
  });

  await transport.start();
  logStderr("stdin 关闭，MCP server 退出。");
}

/**
 * 构造 MCP server 的请求处理器（可测试，独立于 stdio 传输）。
 *
 * @param allowWrite 是否放开写/执行类工具（默认 false 仅只读）。
 * @returns handler（JSON-RPC 请求 → 响应）与已暴露工具列表。
 */
export async function createMcpServeHandler(allowWrite: boolean): Promise<{
  handler: (req: JsonRpcRequest) => Promise<JsonRpcResponse>;
  tools: LegacyTool[];
}> {
  const tools = await buildServeTools(allowWrite);
  const toolMap = new Map<string, LegacyTool>();
  for (const t of tools) toolMap.set(t.name(), t);

  let initialized = false;

  const handler = async (req: JsonRpcRequest): Promise<JsonRpcResponse> => {
    const reply = (result: unknown): JsonRpcResponse => ({ jsonrpc: "2.0", id: req.id, result });
    const fail = (code: number, message: string): JsonRpcResponse => ({
      jsonrpc: "2.0",
      id: req.id,
      error: { code, message },
    });

    // initialize 之前只允许 initialize / ping（宽容：其余方法返回 -32600 而非断开）。
    if (!initialized && req.method !== "initialize" && req.method !== "ping") {
      return fail(-32600, "尚未 initialize");
    }

    switch (req.method) {
      case "initialize": {
        initialized = true;
        return reply({
          protocolVersion: CLIENT_PROTOCOL_VERSION,
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: "sid-code", version: getRawVersion() },
        });
      }

      case "ping":
        return reply({});

      case "tools/list": {
        return reply({ tools: tools.map(toMcpToolDef) });
      }

      case "tools/call": {
        const params = (req.params ?? {}) as { name?: string; arguments?: unknown };
        const name = params.name;
        if (!name || typeof name !== "string") {
          return fail(-32602, "tools/call 缺少 name 参数");
        }
        const tool = toolMap.get(name);
        if (!tool) {
          // 工具不存在，或存在但因安全策略未暴露（写类工具未 --allow-write）。
          return fail(-32602, `工具未暴露或不存在: ${name}`);
        }
        // 二次安全门：非 allowWrite 模式下，即便某工具混进来也必须是只读。
        if (!allowWrite && !isToolReadOnly(tool)) {
          return {
            jsonrpc: "2.0",
            id: req.id,
            result: {
              content: [
                {
                  type: "text",
                  text: `拒绝执行：工具 "${name}" 为写/执行类，mcp serve 默认只放行只读工具。启动时加 --allow-write 放开。`,
                },
              ],
              isError: true,
            },
          };
        }
        try {
          const result = await tool.execute(params.arguments ?? {});
          return reply({
            content: [{ type: "text", text: result.output ?? "" }],
            isError: result.isError === true,
          });
        } catch (err: any) {
          return {
            jsonrpc: "2.0",
            id: req.id,
            result: {
              content: [{ type: "text", text: `工具执行失败: ${err?.message ?? err}` }],
              isError: true,
            },
          };
        }
      }

      default:
        return fail(-32601, `方法未找到: ${req.method}`);
    }
  };

  return { handler, tools };
}
