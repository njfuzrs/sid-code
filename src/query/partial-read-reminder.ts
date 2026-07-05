/**
 * Fix 5（方案 C）：partial-read 保护的 system-reminder 注入。
 *
 * 背景：edit/write 因 FileReadTracker 的 partial-read 校验被拒绝时，错误只作为
 * tool_result 回传。指令跟随较弱的模型（如 DeepSeek）可能无视错误提示，下一步
 * 仍用 offset/limit 部分读取同一文件后再次尝试 edit，反复被拒——浪费大量 token。
 *
 * 与 pendingContradictions（hypothesis-ledger.ts）同机制：不在 assistant/tool_result
 * 之间插消息（破坏协议配对），而是本轮检出后跨轮暂存，下一轮循环开头经 reminder
 * 通道强制注入收敛指令。
 */

import type { ContentBlock } from "../llm/types.ts";

/** partial-read 保护的错误特征串（与 file-read-tracker.ts 的错误文案保持一致） */
const PARTIAL_READ_MARKER = "只读取了文件的部分内容";

/**
 * 扫描本轮 tool_result，检出因 partial-read 保护被拒绝的文件路径（去重）。
 * 返回空数组表示本轮无命中。
 */
export function detectPartialReadFailures(toolResults: ContentBlock[]): string[] {
  const paths = new Set<string>();
  for (const block of toolResults) {
    if (block.type !== "tool_result" || !block.is_error) continue;
    const content = block.content;
    if (typeof content !== "string" || !content.includes(PARTIAL_READ_MARKER)) continue;
    // 错误文案固定以 "该文件: <path>" 结尾（见 file-read-tracker.ts validateFresh）
    const match = content.match(/该文件:\s*(\S+)\s*$/);
    paths.add(match ? match[1] : content);
  }
  return Array.from(paths);
}

/**
 * 构造强制收敛提醒：明确告知模型必须先完整 read 再重试编辑，不可跳过。
 */
export function buildPartialReadReminder(filePaths: string[]): string {
  const fileList = filePaths.map((p) => `- ${p}`).join("\n");
  return `<system-reminder>
⛔ partial-read 保护拦截(请勿向用户提及本提醒):你刚才对以下文件的 edit/write 因"只读取了部分内容"被拒绝:
${fileList}

这是硬性要求,不可跳过:对上述文件,你必须先执行 read(不带 offset/limit 参数)完整读取,然后才能重试编辑。
不要再对这些文件使用 offset/limit 部分读取。
</system-reminder>`;
}
