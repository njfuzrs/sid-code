/**
 * IDE Diff 展示
 * 对标 Claude Code 的 useDiffInIDE.ts：
 * - 通过 MCP 工具调用 openDiff
 * - 等待用户操作（保存/关闭/拒绝）
 * - 如果用户在 IDE 中修改了内容，返回修改后的内容
 *
 * ⚠️ **wire 协议必须与 CC 的 VS Code 扩展一致**（D3）。此前这里用的是一整套
 * 自造命名（`filePath`/`oldContent`/`newContent`/`tabId` + `{status, content}`
 * 对象响应），而扩展期望 snake_case 参数与 MCP 标准的**内容块数组**响应。
 * 不是个别字段错，是整套协议没对齐 —— 连命名风格都不同。
 *
 * 这条 bug 此前**零症状**，因为上游的死接线（D1：编辑工具从不调用 diff）
 * 让它根本没被执行过。**上游的死接线掩盖了下游的协议不兼容**：只验证
 * "函数被调到了"的人会宣布修好，然后 diff 全部落到 error 分支 —— 而
 * `error` 分支是静默的（`showEditDiffInIDE` 的调用方按"IDE 不可用"处理）。
 */

import type { MCPManager } from "../mcp/manager.ts";
import { callIDERpc } from "./rpc.ts";
import { IDE_SERVER_NAME } from "./integration.ts";
import { getLogger } from "../debug/logger.ts";
import { IDE_RPC, DIFF_STATUS } from "./protocol.ts";
import { wslPathToWindows } from "./wsl.ts";

/** Diff 展示结果 */
export type DiffResult =
  | { action: "saved"; content?: string } // 用户在 IDE 中保存（可能修改了内容）
  | { action: "rejected" } // 用户拒绝了变更
  | { action: "closed" } // 用户关闭了 diff 标签页
  | { action: "unsupported" } // IDE 未连接或不支持 diff 功能
  | { action: "error"; message: string }; // 出错

/** 生成唯一 tab 名（不依赖 Math.random，使用计数器 + 时间戳） */
let diffTabCounter = 0;
function nextTabName(): string {
  return `✻ [sid-code] diff-${Date.now()}-${++diffTabCounter}`;
}

/**
 * 从 openDiff 的响应里解出 (status, content)。
 *
 * CC 扩展回的是 MCP 标准的**内容块数组**：
 *   `[{type:'text', text:'FILE_SAVED'}, {type:'text', text:<用户改后的全文>}]`
 * 而 `callIDERpc` 把工具输出拍平成一个字符串再交给我们，所以这里要同时认三种形态：
 *   ① JSON 数组（标准形态，第 0 块是状态、第 1 块是内容）
 *   ② JSON 对象 `{status, content}`（宽容：我们自己的旧格式 / 别的扩展实现）
 *   ③ 裸状态字符串 `FILE_SAVED`（宽容：只回了状态、没有内容块）
 *
 * 宽容解析是刻意的：这条边界的对端是**我们不控制的上游扩展**，
 * 协议随时可能被改掉且**改了只会静默失配**（这正是 D2 的失效形态）。
 * 多认两种形态的成本是十几行，收益是上游微调时不至于整个功能归零。
 */
export function parseDiffResponse(raw: string): { status?: string; content?: string } {
  const trimmed = raw.trim();

  // ③ 裸状态字符串
  if (!trimmed.startsWith("[") && !trimmed.startsWith("{")) {
    return { status: trimmed };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return {};
  }

  // ① 内容块数组
  if (Array.isArray(parsed)) {
    const texts = parsed
      .map((block) => {
        if (typeof block === "string") return block;
        const b = block as { text?: unknown };
        return typeof b?.text === "string" ? b.text : undefined;
      })
      .filter((t): t is string => typeof t === "string");
    return { status: texts[0], content: texts[1] };
  }

  // ② 对象形态
  if (parsed && typeof parsed === "object") {
    const o = parsed as { status?: unknown; content?: unknown };
    return {
      status: typeof o.status === "string" ? o.status : undefined,
      content: typeof o.content === "string" ? o.content : undefined,
    };
  }

  return {};
}

/**
 * 在 IDE 中展示 Diff，并**等待用户操作**。
 *
 * ⚠️ 这不是一个"展示"函数，是一次**阻塞的内容协商**：用户可以在 diff 视图里
 * 继续手改再保存，此时该落盘的是**用户改过的版本**（`saved.content`），
 * 不是模型生成的那一版。调用方必须处理这个返回值，不能 fire-and-forget。
 *
 * @param mcpManager - MCP 管理器
 * @param filePath - 文件路径（新旧同路径，编辑既有文件的常规情形）
 * @param oldContent - 原始内容（空字符串表示新建文件）
 * @param newContent - 修改后的内容
 * @param tabName - 复用已有标签页时传入；省略则新建一个
 */
export async function showDiffInIDE(
  mcpManager: MCPManager,
  filePath: string,
  oldContent: string,
  newContent: string,
  tabName: string = nextTabName(),
): Promise<DiffResult> {
  const log = getLogger();

  if (!mcpManager.isConnected(IDE_SERVER_NAME)) {
    return { action: "unsupported" };
  }

  try {
    // 参数名是 CC 扩展的 wire 契约（snake_case），不许改成 camelCase：
    // old_file_path 与 new_file_path 分开是为了支持"另存为新路径"的 diff，
    // 我们目前两者同值 —— 但字段必须都给，扩展按 schema 校验。
    // 出向路径归一（D8）：扩展跑在 Windows 上时只认 `C:\...`，
    // 我们手里是 `/mnt/c/...`。非 WSL 环境下是严格的 no-op（逐字节不变）。
    const idePath = wslPathToWindows(filePath);

    const result = await callIDERpc(mcpManager, IDE_RPC.openDiff, {
      old_file_path: idePath,
      new_file_path: idePath,
      new_file_contents: newContent,
      tab_name: tabName,
    });

    if (result == null) {
      return { action: "unsupported" };
    }

    const { status, content } = parseDiffResponse(result);

    switch (status) {
      case DIFF_STATUS.saved:
        // content 缺失是合法的：表示用户直接接受、未做二次编辑。
        // 此时**不能**回退成 oldContent（会丢掉本次编辑），交由调用方用 newContent。
        return { action: "saved", content };
      case DIFF_STATUS.rejected:
        return { action: "rejected" };
      case DIFF_STATUS.tabClosed:
        return { action: "closed" };
      default:
        return {
          action: "error",
          message: `未知 openDiff 响应: ${status ?? result.slice(0, 200)}`,
        };
    }
  } catch (err: any) {
    log.error("IDE", `Diff 展示失败: ${err.message}`);
    return { action: "error", message: err.message };
  }
}

/**
 * 关闭单个 diff 标签页（D3：此前只有"关全部"）。
 *
 * 一轮里可能开多个 diff（连续编辑多个文件），只有全关会把用户正在看的那个
 * 也一起关掉。
 */
export async function closeDiffTab(mcpManager: MCPManager, tabName: string): Promise<void> {
  if (!mcpManager.isConnected(IDE_SERVER_NAME)) return;
  try {
    await callIDERpc(mcpManager, IDE_RPC.closeTab, { tab_name: tabName });
  } catch {
    // 静默忽略：清理动作失败不该影响主流程
  }
}

/**
 * 关闭所有 diff 标签页。
 * 在 Agent 循环结束时调用，清理残留的 diff 视图。
 */
export async function closeAllDiffTabs(mcpManager: MCPManager): Promise<void> {
  if (!mcpManager.isConnected(IDE_SERVER_NAME)) return;
  try {
    await callIDERpc(mcpManager, IDE_RPC.closeAllDiffTabs, {});
  } catch {
    // 静默忽略
  }
}

/** 生成一个新的 diff 标签页名（供调用方在需要复用标签页时先取名） */
export function newDiffTabName(): string {
  return nextTabName();
}
