/**
 * IDE RPC 调用封装
 * 对标 Claude Code 的 callIdeRpc()。
 *
 * 所有 IDE RPC 调用都有 try-catch 包裹，IDE 断开不影响主流程。
 */

import type { MCPManager } from "../mcp/manager.ts";
import { IDE_SERVER_NAME } from "./integration.ts";
import { getLogger } from "../debug/logger.ts";

/**
 * 调用 IDE 的 MCP 工具。
 * @returns 工具输出文本；IDE 未连接或调用失败返回 null
 */
export async function callIDERpc(
  mcpManager: MCPManager,
  toolName: string,
  args: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<string | null> {
  try {
    if (!mcpManager.isConnected(IDE_SERVER_NAME)) {
      return null;
    }

    const result = await mcpManager.callServerTool(IDE_SERVER_NAME, toolName, args, signal);
    return result?.output ?? null;
  } catch (err: any) {
    getLogger().debug("IDE", `RPC 调用 ${toolName} 失败: ${err.message}`);
    return null;
  }
}
