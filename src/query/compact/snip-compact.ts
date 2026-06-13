/**
 * snipCompact — 裁剪最早的消息
 *
 * 在 autoCompact（LLM 摘要）之前先尝试裁剪最早的消息对，
 * 低成本地释放上下文空间。
 */

import type { Message } from "../../llm/types.ts";
import { getLogger } from "../../debug/index.ts";
import {
  checkMessageHistoryIntegrity,
  describeIntegrityViolation,
} from "../../agent/message-invariants.ts";

/** snipCompact 配置 */
export interface SnipCompactOptions {
  /** 最少保留的消息数（默认 6，即 3 轮对话） */
  minPreserveCount?: number;
  /** 每次裁剪的消息数（默认 2，即 1 轮对话） */
  snipSize?: number;
  /** 最大裁剪比例（默认 0.5，即最多裁剪一半） */
  maxSnipRatio?: number;
}

const DEFAULT_OPTIONS: Required<SnipCompactOptions> = {
  minPreserveCount: 6,
  snipSize: 2,
  maxSnipRatio: 0.5,
};

/** snipCompact 结果 */
export interface SnipCompactResult {
  /** 裁剪后的消息列表 */
  messages: Message[];
  /** 被裁剪的消息数 */
  snippedCount: number;
  /** 是否成功裁剪 */
  success: boolean;
}

/**
 * 裁剪最早的消息
 * 保留系统摘要消息（第一条 user 消息如果是摘要则保留）
 */
export function snipCompact(
  messages: Message[],
  options?: SnipCompactOptions,
): SnipCompactResult {
  const log = getLogger();
  const opts = { ...DEFAULT_OPTIONS, ...options };

  if (messages.length <= opts.minPreserveCount) {
    return { messages, snippedCount: 0, success: false };
  }

  const maxSnip = Math.floor(messages.length * opts.maxSnipRatio);
  const snipCount = Math.min(opts.snipSize, maxSnip);

  if (snipCount <= 0) {
    return { messages, snippedCount: 0, success: false };
  }

  // 检查第一条消息是否是压缩摘要（以 [自动截断] 或 [响应式压缩] 开头）
  let startIdx = 0;
  if (messages.length > 0 && messages[0].role === "user") {
    const firstText = messages[0].content
      .filter(b => b.type === "text")
      .map(b => b.type === "text" ? b.text : "")
      .join("");
    if (firstText.startsWith("[自动截断]") ||
        firstText.startsWith("[响应式压缩]") ||
        firstText.startsWith("[snipCompact]")) {
      startIdx = 1; // 跳过摘要消息
    }
  }

  // 确保裁剪后仍保留足够消息
  const remaining = messages.length - startIdx - snipCount;
  if (remaining < opts.minPreserveCount) {
    return { messages, snippedCount: 0, success: false };
  }

  // 生成裁剪摘要
  const snipped = messages.slice(startIdx, startIdx + snipCount);
  const summaryParts: string[] = [];
  for (const msg of snipped) {
    const texts = msg.content
      .filter(b => b.type === "text")
      .map(b => b.type === "text" ? b.text.slice(0, 100) : "")
      .filter(Boolean);
    if (texts.length > 0) {
      summaryParts.push(`[${msg.role}] ${texts[0]}...`);
    }
  }

  const summaryMsg: Message = {
    role: "user",
    content: [{
      type: "text",
      text: `[snipCompact] 裁剪了 ${snipCount} 条早期消息：\n${summaryParts.join("\n")}`,
    }],
  };

  // 组装结果：摘要 + 保留的消息
  const preserved = startIdx > 0 ? [messages[0]] : [];
  const result = [...preserved, summaryMsg, ...messages.slice(startIdx + snipCount)];

  log.info("SNIP_COMPACT", `裁剪了 ${snipCount} 条消息，${messages.length} → ${result.length}`);

  // PROTOCOL-5：snip 按"消息条数"切片，可能切掉 assistant(tool_use) 而留下孤儿/游离。
  // 发送前的 backfillOrphanToolResults 关卡会兜底修复，故此处只做事后只读校验 + 告警，
  // 让"压缩产生孤儿"这一事件显形（落到 audit.log），便于排查而非掩盖。不修改数据。
  const integrity = checkMessageHistoryIntegrity(result);
  if (!integrity.intact) {
    log.warn(
      "SNIP_COMPACT",
      `裁剪后消息历史出现 tool_use/tool_result 配对破缺（将由发送前关卡兜底修复）：${describeIntegrityViolation(integrity)}`,
    );
  }

  return { messages: result, snippedCount: snipCount, success: true };
}
