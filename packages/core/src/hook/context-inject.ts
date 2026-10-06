/**
 * Hook 上下文注入通道（§三.7 第 2 条，解决 HC16 / HC17）
 *
 * SessionStart / UserPromptSubmit（以及之后的 UserPromptExpansion / PostModelSwitch）的
 * 「exit 0 纯文本 stdout」与「JSON additionalContext」走同一个出口：独立的 `<system-reminder>`
 * 文本块，挂在本轮用户消息**之后**，**不拼进用户原文**。
 *
 * 原先 `finalInput = userInput + "\n\n" + additionalCtx` 再 `parseThinkingHint(finalInput)`：
 *   ① 模型把 hook 内容当成用户说的话（实测回答「暗号只出现在你的消息里」），不可信内容获得用户指令的权重；
 *   ② hook 输出里的 `think hard` / `ultrathink` 被当成思考档位触发词。
 * 现在调用方先对**原始用户输入**解析 thinking hint，再把本模块产出的块作为独立 text block 追加。
 *
 * 长度上限对齐 CC：每段 10,000 字符，超出转存会话目录，只留路径与前 2,000 字符预览。
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AggregatedHookResult } from "./types.ts";

/** 单段 hook 上下文的字符上限（CC 同值） */
export const HOOK_CONTEXT_MAX_CHARS = 10_000;
/** 超限时内联保留的预览长度 */
export const HOOK_CONTEXT_PREVIEW_CHARS = 2_000;

/** 从聚合结果里取出要注入上下文的文本（additionalContext；纯文本 stdout 已由 runner 归到这里） */
export function extractHookContext(result: AggregatedHookResult | undefined): string | undefined {
  const ctx = result?.finalOutput?.getAdditionalContext();
  return ctx && ctx.trim() ? ctx : undefined;
}

/**
 * 把一段 hook 上下文格式化成 `<system-reminder>` 块。
 * @param overflowDir 超限时转存的目录（会话目录）；不传则直接截断并注明。
 */
export function formatHookContextReminder(
  eventName: string,
  text: string,
  overflowDir?: string,
): string {
  let body = text;
  if (text.length > HOOK_CONTEXT_MAX_CHARS) {
    const preview = text.slice(0, HOOK_CONTEXT_PREVIEW_CHARS);
    let where = "";
    if (overflowDir) {
      try {
        mkdirSync(overflowDir, { recursive: true });
        const file = join(overflowDir, `hook-context-${eventName}-${Date.now()}.txt`);
        writeFileSync(file, text);
        where = `完整内容已保存到 ${file}，需要时用 read 工具读取。`;
      } catch {
        where = "完整内容转存失败，已截断。";
      }
    } else {
      where = "已截断。";
    }
    body = `${preview}\n\n[hook 输出共 ${text.length} 字符，超过 ${HOOK_CONTEXT_MAX_CHARS} 上限，${where}]`;
  }
  return `<system-reminder>\n${eventName} hook 附加的上下文：\n${body}\n</system-reminder>`;
}
