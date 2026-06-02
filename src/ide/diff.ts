/**
 * IDE Diff 展示
 * 对标 Claude Code 的 useDiffInIDE.ts：
 * - 通过 MCP 工具调用 openDiff
 * - 等待用户操作（保存/关闭/拒绝）
 * - 如果用户在 IDE 中修改了内容，返回修改后的内容
 */

import type { MCPManager } from "../mcp/manager.ts";
import { callIDERpc } from "./rpc.ts";
import { IDE_SERVER_NAME } from "./integration.ts";
import { getLogger } from "../debug/logger.ts";

/** Diff 展示结果 */
export type DiffResult =
  | { action: "saved"; content?: string }    // 用户在 IDE 中保存（可能修改了内容）
  | { action: "rejected" }                    // 用户拒绝了变更
  | { action: "closed" }                      // 用户关闭了 diff 标签页
  | { action: "unsupported" }                 // IDE 未连接或不支持 diff 功能
  | { action: "error"; message: string };     // 出错

/** 生成唯一 tab id（不依赖 Math.random，使用计数器 + 时间戳） */
let diffTabCounter = 0;
function nextTabId(): string {
  return `diff-${Date.now()}-${++diffTabCounter}`;
}

/**
 * 在 IDE 中展示 Diff。
 * @param mcpManager - MCP 管理器
 * @param filePath - 文件路径
 * @param oldContent - 原始内容
 * @param newContent - 修改后的内容
 */
export async function showDiffInIDE(
  mcpManager: MCPManager,
  filePath: string,
  oldContent: string,
  newContent: string,
): Promise<DiffResult> {
  const log = getLogger();

  if (!mcpManager.isConnected(IDE_SERVER_NAME)) {
    return { action: "unsupported" };
  }

  try {
    const tabId = nextTabId();

    const result = await callIDERpc(mcpManager, "openDiff", {
      filePath,
      oldContent,
      newContent,
      tabId,
    });

    if (result == null) {
      return { action: "unsupported" };
    }

    // 解析 IDE 响应
    let response: { status?: string; content?: string };
    try {
      response = typeof result === "string" ? JSON.parse(result) : result;
    } catch {
      return { action: "error", message: `无法解析 IDE 响应: ${result.slice(0, 200)}` };
    }

    switch (response.status) {
      case "FILE_SAVED":
        return { action: "saved", content: response.content };
      case "DIFF_REJECTED":
        return { action: "rejected" };
      case "TAB_CLOSED":
        return { action: "closed" };
      default:
        return { action: "error", message: `未知响应: ${response.status}` };
    }
  } catch (err: any) {
    log.error("IDE", `Diff 展示失败: ${err.message}`);
    return { action: "error", message: err.message };
  }
}

/**
 * 关闭所有 diff 标签页。
 * 在 Agent 循环结束时调用，清理残留的 diff 视图。
 */
export async function closeAllDiffTabs(mcpManager: MCPManager): Promise<void> {
  if (!mcpManager.isConnected(IDE_SERVER_NAME)) return;
  try {
    await callIDERpc(mcpManager, "closeAllDiffTabs", {});
  } catch {
    // 静默忽略
  }
}
