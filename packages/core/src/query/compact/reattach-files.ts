/**
 * Post-compact 文件恢复（§2.1，对标 claude-code createPostCompactFileAttachments）
 *
 * 压缩会丢弃旧消息历史，模型压缩后往往要花 1-3 轮重新 read_file 才能继续之前的编辑工作（"断片"）。
 * 本模块在压缩成功后，主动把"最近访问的若干文件"的当前磁盘内容作为新消息重注入，
 * 让模型压缩后第一轮即可继续，无需重读。
 *
 * 预算守卫（防止恢复本身又把上下文撑爆）：
 *   - 最多 POST_COMPACT_MAX_FILES 个文件
 *   - 每个文件截断到 POST_COMPACT_PER_FILE_BUDGET token
 *   - 累计不超过 POST_COMPACT_TOTAL_BUDGET token
 *
 * 风险 10.1（恢复了已变更/已删除的文件）：恢复时**重读磁盘当前内容**而非用历史快照，
 * 并在 mtime 与读取记录不一致时标注"文件自上次读取后已变更"，避免给模型陈旧内容。
 */

import { statSync, readFileSync } from "node:fs";
import type { Message } from "../../llm/types.ts";
import type { FileReadTracker } from "../../tool/file-read-tracker.ts";
import { estimateTextTokens } from "../../context/token.ts";
import { getLogger } from "../../debug/index.ts";
import { REATTACH_FILE_PREFIX, REATTACH_ORIGIN } from "./reattach-markers.ts";

export const POST_COMPACT_MAX_FILES = 5;
export const POST_COMPACT_PER_FILE_BUDGET = 5_000; // tokens
export const POST_COMPACT_TOTAL_BUDGET = 50_000; // tokens

/** 按 token 预算截断文件内容（粗略 4 char ≈ 1 token，够用且无需精确） */
function truncateToTokenBudget(
  content: string,
  tokenBudget: number,
): { text: string; truncated: boolean } {
  const approxChars = tokenBudget * 4;
  if (content.length <= approxChars) return { text: content, truncated: false };
  return { text: content.slice(0, approxChars), truncated: true };
}

/**
 * 构造压缩后文件恢复消息对（user 提供文件内容 + assistant 确认）。
 * 无可恢复文件时返回空数组。
 *
 * @param tracker 文件读取追踪器（提供最近访问文件列表 + 历史 mtime）
 * @param opts 预算与数量上限（默认用模块常量）
 */
export function buildReattachFileMessages(
  tracker: FileReadTracker,
  opts?: { maxFiles?: number; perFileBudget?: number; totalBudget?: number },
): Message[] {
  const log = getLogger();
  const maxFiles = opts?.maxFiles ?? POST_COMPACT_MAX_FILES;
  const perFileBudget = opts?.perFileBudget ?? POST_COMPACT_PER_FILE_BUDGET;
  const totalBudget = opts?.totalBudget ?? POST_COMPACT_TOTAL_BUDGET;

  const recentFiles = tracker.getRecentFiles(maxFiles);
  if (recentFiles.length === 0) return [];

  const sections: string[] = [];
  let usedTokens = 0;
  let restoredCount = 0;

  for (const filePath of recentFiles) {
    if (usedTokens >= totalBudget) break;

    let content: string;
    let changed = false;
    try {
      const stat = statSync(filePath);
      if (stat.isDirectory()) continue;
      content = readFileSync(filePath, "utf-8");
      // 风险 10.1：判断文件是否自上次读取后被外部修改
      const expected = tracker.getRecordedMtime(filePath);
      if (expected !== null && stat.mtimeMs !== expected) changed = true;
    } catch {
      // 文件已删除 / 不可读：跳过（不注入陈旧快照）
      continue;
    }

    // 单文件预算 + 剩余总预算取小
    const remainingTotal = totalBudget - usedTokens;
    const fileBudget = Math.min(perFileBudget, remainingTotal);
    const { text, truncated } = truncateToTokenBudget(content, fileBudget);

    const changedNote = changed
      ? "（注意：此文件自上次读取后已被外部修改，以下为当前磁盘内容）"
      : "";
    const truncNote = truncated
      ? `\n\n[内容已截断到约 ${fileBudget} token，如需完整内容请重新 read]`
      : "";
    sections.push(`### ${filePath}${changedNote}\n\`\`\`\n${text}${truncNote}\n\`\`\``);

    usedTokens += estimateTextTokens(text);
    restoredCount++;
  }

  if (sections.length === 0) return [];

  log.info("POST_COMPACT_REATTACH", `恢复 ${restoredCount} 个最近文件，约 ${usedTokens} token`);

  const userMsg: Message = {
    role: "user",
    content: [
      {
        type: "text",
        text:
          `${REATTACH_FILE_PREFIX} 以下是你压缩前最近访问的 ${restoredCount} 个文件的当前内容，` +
          `已为你重新加载，可直接继续编辑，无需重读：\n\n${sections.join("\n\n")}`,
      },
    ],
    _meta: { origin: REATTACH_ORIGIN },
  };
  const ackMsg: Message = {
    role: "assistant",
    content: [{ type: "text", text: "好的，已重新加载最近的文件内容，我会继续之前的工作。" }],
    _meta: { origin: REATTACH_ORIGIN },
  };
  return [userMsg, ackMsg];
}

/**
 * P2-22：**只给路径清单、不带正文**的轻量恢复（emergency / blocking 截断专用）。
 *
 * 为什么不直接复用 `buildReattachFileMessages`：那条路径会读盘并注入最多 50K token 正文。
 * emergency / blocking 的定义是「剩余极少、连一次 LLM 往返都危险」——刚截断腾出的空间
 * 立刻塞回 50K 正文，是把上下文推回它刚逃离的悬崖，下一轮必然再次截断（截断是有损的，
 * 每次都真丢历史）。所以这里**一个字节的文件内容都不读**，只列路径。
 *
 * 为什么仍要做：截断后模型的体感是断片——它不知道自己刚才在改哪几个文件，于是要么
 * 瞎猜，要么从头 glob/grep 重新找。给出「你刚才在动这几个文件」这一条线索，代价是
 * 几十个 token（路径字符串），收益是模型能直接 read 它真正需要的那一个。
 * 这是刻意的取舍：`emergencyTruncate` 的 miniSummary 已经在列「涉及文件」，但那取的是
 * **被截掉那段**里出现过的路径；这里取的是 `FileReadTracker` 记的**最近实际读过**的文件，
 * 两者来源不同——截断段可能根本不含最近的读取（近端消息被保留，路径就不在截断段里）。
 *
 * 不注入 assistant ack：调用方（`runEmergencyReattach`）负责维持角色交替，见那里的注释。
 */
export function buildEmergencyFilePathReattach(
  tracker: FileReadTracker,
  opts?: { maxFiles?: number },
): Message[] {
  const maxFiles = opts?.maxFiles ?? POST_COMPACT_MAX_FILES;
  const recentFiles = tracker.getRecentFiles(maxFiles);
  if (recentFiles.length === 0) return [];

  const list = recentFiles.map((f) => `- ${f}`).join("\n");
  return [
    {
      role: "user",
      content: [
        {
          type: "text",
          text:
            `${REATTACH_FILE_PREFIX} 上下文已被紧急截断（不是摘要压缩，较早的历史已直接丢弃）。` +
            `你在截断前最近访问过这些文件：\n${list}\n\n` +
            `正文未随本条消息恢复（紧急路径必须省 token）。需要哪个文件就直接 read 它，` +
            `不要凭记忆改写。`,
        },
      ],
      _meta: { origin: REATTACH_ORIGIN },
    },
  ];
}
