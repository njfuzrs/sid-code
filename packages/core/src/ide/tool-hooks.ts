/**
 * IDE 工具执行集成
 *
 * 在文件编辑工具**写盘之前**于 IDE 中展示 diff，并把用户在 diff 视图里手改后的
 * 内容拾取回来作为最终内容。
 *
 * 注意（与原 spec §5.2.7 的差异）：
 * sid-code 的 PostToolUse hook 载荷（PostToolUseInput）不携带文件的
 * 原始/新内容，且 hook 系统不暴露程序式 `.on()` 注册接口。因此本模块
 * 提供可被调用的 diff 展示函数，由持有 old/new 内容的一方（编辑工具或
 * 其上层）显式调用，而非通过 hook 事件被动触发。
 *
 * ⚠️ **上面这段注释此前描述的是一个未完成的计划**（D1）：
 * 它准确地说明了"由编辑工具显式调用"这个设计意图，**而那个调用方就是没实现** ——
 * `grep -rn "tool-hooks" packages` 曾是 0 命中，整条 diff 链是死代码。
 * 现在 `negotiateContentViaIDE()` 被 `tool/edit.ts` 与 `tool/write.ts` 真实调用。
 */

import type { MCPManager } from "../mcp/manager.ts";
import { showDiffInIDE, closeAllDiffTabs, closeDiffTab, newDiffTabName } from "./diff.ts";
import type { DiffResult } from "./diff.ts";
import { IDE_SERVER_NAME } from "./integration.ts";
import { getIDEDiffRuntime } from "./runtime.ts";
import { getLogger } from "../debug/logger.ts";

/**
 * 文件编辑后在 IDE 中展示 diff（IDE 未连接时静默跳过）。
 * @returns diff 展示结果；IDE 未连接返回 unsupported
 */
export async function showEditDiffInIDE(
  mcpManager: MCPManager,
  filePath: string,
  oldContent: string,
  newContent: string,
): Promise<DiffResult> {
  if (!mcpManager.isConnected(IDE_SERVER_NAME)) {
    return { action: "unsupported" };
  }
  return showDiffInIDE(mcpManager, filePath, oldContent, newContent);
}

/** 内容协商结果 */
export type ContentNegotiation =
  /** 按 content 写盘（可能是用户在 IDE 里手改过的版本） */
  | { proceed: true; content: string; userEdited: boolean }
  /** 用户拒绝了这次编辑，不要写盘 */
  | { proceed: false; reason: string };

/**
 * 写盘**之前**在 IDE 里和用户协商最终内容（D1 的真实接线点）。
 *
 * 这是一次**阻塞的内容协商**，不是"展示一下"：用户可以在 diff 视图里继续手改
 * 再保存，此时该落盘的是**用户改过的版本**。所以：
 *   - 必须排在 `Bun.write` **之前**（接在"改完之后"就失去了协商的意义）
 *   - 返回值必须被消费（`proceed: false` 时调用方必须真的不写）
 *
 * **没有 IDE / 没开开关 / 任何一步出错，都返回"照原样写"** —— IDE 是可选增强，
 * 一个预览功能不该有能力阻断编辑。唯一会阻断的是**用户明确拒绝**这一种情形。
 *
 * ⚠️ `error` 分支在此前的实现里是**静默**的（调用方按"IDE 不可用"处理）。
 * 这里改成打一条 warn：diff 弹不出来时用户会以为功能坏了，而静默让他无从判断。
 */
export async function negotiateContentViaIDE(
  filePath: string,
  oldContent: string,
  newContent: string,
): Promise<ContentNegotiation> {
  const runtime = getIDEDiffRuntime();
  // 未注入 / 未启用 —— 正常路径，照原样写
  if (!runtime) return { proceed: true, content: newContent, userEdited: false };

  const { mcpManager } = runtime;
  if (!mcpManager.isConnected(IDE_SERVER_NAME)) {
    return { proceed: true, content: newContent, userEdited: false };
  }

  const log = getLogger();
  // 自己持有 tab 名，才能只关掉这一个（D3 补的 close_tab）；
  // 用 closeAllDiffTabs 会把用户正在看的其他 diff 一起关掉。
  const tabName = newDiffTabName();

  let result: DiffResult;
  try {
    result = await showDiffInIDE(mcpManager, filePath, oldContent, newContent, tabName);
  } catch (err: any) {
    // 抛异常也不阻断编辑 —— 但要留下痕迹
    log.warn("IDE", `diff 预览异常，按原内容写入: ${err?.message ?? err}`);
    return { proceed: true, content: newContent, userEdited: false };
  }

  switch (result.action) {
    case "saved": {
      // content 缺失是合法的：用户直接接受、未做二次编辑。
      // 此时用 newContent，**不能**回退成 oldContent（会丢掉本次编辑）。
      const finalContent = result.content ?? newContent;
      const userEdited = result.content !== undefined && result.content !== newContent;
      if (userEdited) {
        log.info("IDE", `采用用户在 IDE 中修改后的内容: ${filePath}`);
      }
      await closeDiffTab(mcpManager, tabName);
      return { proceed: true, content: finalContent, userEdited };
    }

    case "rejected":
      await closeDiffTab(mcpManager, tabName);
      return { proceed: false, reason: "用户在 IDE 的 diff 视图中拒绝了此次编辑" };

    case "closed":
      // 关掉标签页 ≠ 拒绝。用户可能只是关掉了预览窗口，把它当拒绝会让编辑莫名消失。
      // 按"未表态"处理：照原内容写，与没有 IDE 时行为一致。
      log.debug("IDE", `diff 标签页被关闭（未表态），按原内容写入: ${filePath}`);
      return { proceed: true, content: newContent, userEdited: false };

    case "unsupported":
      return { proceed: true, content: newContent, userEdited: false };

    case "error":
      // 此前这条分支是静默的 —— diff 全部失败时用户完全看不出来
      log.warn("IDE", `diff 预览失败，按原内容写入: ${result.message}`);
      await closeDiffTab(mcpManager, tabName);
      return { proceed: true, content: newContent, userEdited: false };
  }
}

/**
 * Agent 循环结束时清理 IDE 中残留的 diff 标签页。
 * 在主循环 end_turn / abort 时调用。
 */
export async function cleanupIDEDiffTabs(mcpManager?: MCPManager): Promise<void> {
  const manager = mcpManager ?? getIDEDiffRuntime()?.mcpManager;
  if (!manager) return;
  await closeAllDiffTabs(manager);
}
