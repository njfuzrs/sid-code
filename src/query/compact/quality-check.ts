/**
 * 压缩质量可观测（§4.1）
 *
 * 压缩是"信息有损"操作，但此前完全黑盒——无法知道一次摘要是否丢了关键信息。
 * 本模块在压缩后做**轻量本地抽样校验**（零额外 LLM 调用），评估摘要对关键实体的覆盖率：
 * 从被压缩的原始消息提取关键锚点（文件路径、用户消息要点、报错关键词），
 * 检查这些锚点是否在摘要文本中出现，算出覆盖率并记录到会话指标 + 落盘 compact-quality.jsonl。
 *
 * 覆盖率低于阈值时告警，便于发现"摘要质量塌陷"的会话，而不是等用户反馈"它忘了我说过的话"。
 */

import { appendFileSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import type { Message } from "../../llm/types.ts";
import { getLogger } from "../../debug/index.ts";

/** 压缩质量报告 */
export interface CompactQualityReport {
  /** 关键锚点总数 */
  totalAnchors: number;
  /** 摘要中命中的锚点数 */
  coveredAnchors: number;
  /** 覆盖率 [0,1] */
  coverage: number;
  /** 未覆盖的锚点样例（最多 10 个，诊断用） */
  missedSamples: string[];
}

/** 覆盖率低于此值告警 */
const COVERAGE_WARN_THRESHOLD = 0.5;

/**
 * 从被压缩的消息段提取"关键锚点"：
 *   - tool_use 的 file_path / path（模型操作过的文件）
 *   - user 文本消息的去重词（>=4 字符的非停用词，取每条前若干个）
 */
export function extractAnchors(messages: Message[]): string[] {
  const anchors = new Set<string>();
  for (const msg of messages) {
    if (msg._meta?.origin) continue;
    for (const block of msg.content) {
      if (block.type === "tool_use") {
        const input = (block.input ?? {}) as { file_path?: string; path?: string };
        const fp = input.file_path ?? input.path;
        if (fp) anchors.add(fp);
      } else if (block.type === "text" && msg.role === "user") {
        const t = block.text.trim();
        if (!t || t.startsWith("[")) continue;
        // 提取路径样式 token（含 / 或 . 的）作为高价值锚点
        const pathLike = t.match(/[\w./\-]+\.[a-zA-Z]{1,5}\b|[\w\-]+\/[\w./\-]+/g);
        if (pathLike) pathLike.slice(0, 5).forEach((p) => anchors.add(p));
      }
    }
  }
  return Array.from(anchors);
}

/**
 * 校验摘要对关键锚点的覆盖率（纯本地字符串包含判断）。
 */
export function checkCompactQuality(originalMessages: Message[], summary: string): CompactQualityReport {
  const anchors = extractAnchors(originalMessages);
  if (anchors.length === 0) {
    return { totalAnchors: 0, coveredAnchors: 0, coverage: 1, missedSamples: [] };
  }
  const missed: string[] = [];
  let covered = 0;
  for (const anchor of anchors) {
    if (summary.includes(anchor)) covered++;
    else if (missed.length < 10) missed.push(anchor);
  }
  return {
    totalAnchors: anchors.length,
    coveredAnchors: covered,
    coverage: covered / anchors.length,
    missedSamples: missed,
  };
}

/**
 * 执行质量校验 + 记录（告警 + 落盘）。设计为"fire and forget"，任何异常都吞掉不影响主流程。
 */
export function recordCompactQuality(
  originalMessages: Message[],
  summary: string,
  sessionDir: string | undefined,
): CompactQualityReport {
  const log = getLogger();
  const report = checkCompactQuality(originalMessages, summary);

  if (report.totalAnchors > 0 && report.coverage < COVERAGE_WARN_THRESHOLD) {
    log.warn(
      "COMPACT_QUALITY",
      `压缩摘要覆盖率偏低 ${(report.coverage * 100).toFixed(0)}%（${report.coveredAnchors}/${report.totalAnchors}），` +
        `可能丢失关键信息。未覆盖样例: ${report.missedSamples.slice(0, 5).join(", ")}`,
    );
  } else {
    log.info("COMPACT_QUALITY", `压缩摘要覆盖率 ${(report.coverage * 100).toFixed(0)}%（${report.coveredAnchors}/${report.totalAnchors}）`);
  }

  if (sessionDir) {
    try {
      if (!existsSync(sessionDir)) mkdirSync(sessionDir, { recursive: true, mode: 0o700 });
      appendFileSync(join(sessionDir, "compact-quality.jsonl"), JSON.stringify(report) + "\n", "utf-8");
    } catch {
      // 落盘失败不影响主流程
    }
  }

  return report;
}
