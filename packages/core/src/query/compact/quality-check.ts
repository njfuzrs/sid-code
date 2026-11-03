/**
 * 压缩质量可观测（§4.1）
 *
 * 压缩是"信息有损"操作，但此前完全黑盒——无法知道一次摘要是否丢了关键信息。
 * 本模块在压缩后做**轻量本地抽样校验**（零额外 LLM 调用），评估摘要对关键实体的覆盖率：
 * 从被压缩的原始消息提取关键锚点（文件路径、用户消息要点、报错关键词），
 * 检查这些锚点是否在摘要文本中出现，算出覆盖率；结构化结果由调用方落 `CompactQuality` 轨迹事件。
 *
 * 覆盖率低于阈值时告警，便于发现"摘要质量塌陷"的会话，而不是等用户反馈"它忘了我说过的话"。
 */

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
  /**
   * 命中锚点按哪一档匹配上的（三项之和 == coveredAnchors）。
   *
   * basename 档最松，单独计数：读的人要能分辨「100% 里有多少是靠最松的那档拿到的」。
   */
  matchedBy: { exact: number; relative: number; basename: number };
}

/**
 * 覆盖率低于此值告警。
 *
 * 导出给 `trace/digest.ts` 复用：两边各写一个 0.5，任何一侧调阈值都会出现
 * 「运行时报了但周报不标」（或反过来）—— 与本仓 P1-6/7「压缩决策和压缩执行
 * 用两套尺子」同型。
 */
export const COVERAGE_WARN_THRESHOLD = 0.5;

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
      } else if (block.type === "text" && msg.role === "user" && !block.persistentReminder) {
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
 * 太泛的文件名：单独出现在摘要里说明不了指的是哪个文件，basename 档要求带上一级目录。
 * 判据是「一个仓里常有多个同名文件」，不是长度 —— `runner.ts` 短但通常唯一，`index.ts` 不是。
 */
const AMBIGUOUS_BASENAMES = new Set([
  "index.ts",
  "index.tsx",
  "index.js",
  "types.ts",
  "utils.ts",
  "util.ts",
  "main.ts",
  "mod.rs",
  "lib.rs",
  "main.rs",
  "__init__.py",
  "package.json",
  "readme.md",
  "config.ts",
  "constants.ts",
]);

/** basename 太短也不单独用（`a.ts` 这类会在任意文本里误命中）。 */
const MIN_BASENAME_LEN = 6;

/**
 * 一个锚点能否在摘要里找到，按三档从严到松：
 *   1. exact    —— 原样子串（旧口径）
 *   2. relative —— 去掉绝对前缀后的相对路径（含一级以上目录，如 `src/hook/runner.ts`）
 *   3. basename —— 文件名；泛名或过短时退化成「上一级目录/文件名」
 *
 * 为什么要放宽：锚点取自 `tool_use.input.file_path`，几乎总是绝对路径；摘要是自然语言，
 * 写的是文件名或相对路径。只按原样匹配时覆盖率必然塌到 0 —— 2026-11-02 实测 23 次里 15 次 0%，
 * 而对应摘要里那些文件名都在（`runner.ts` 出现 11 次）。全部误报的告警等于没有告警。
 *
 * 非路径锚点（用户消息里抽出的 token）只走 exact。
 */
function matchAnchor(anchor: string, summary: string): "exact" | "relative" | "basename" | null {
  if (summary.includes(anchor)) return "exact";
  const norm = anchor.replace(/\\/g, "/").replace(/\/+$/, "");
  const parts = norm.split("/").filter(Boolean);
  if (parts.length < 2) return null;

  // relative：从后往前取至少两段（目录/文件），越长越严，任一后缀命中即可
  for (let k = parts.length - 1; k >= 2; k--) {
    const suffix = parts.slice(parts.length - k).join("/");
    if (summary.includes(suffix)) return "relative";
  }

  const base = parts[parts.length - 1];
  if (!/\.[A-Za-z0-9]{1,6}$/.test(base)) return null; // 不像文件名的不走 basename 档
  const ambiguous = AMBIGUOUS_BASENAMES.has(base.toLowerCase()) || base.length < MIN_BASENAME_LEN;
  if (ambiguous) return null; // 泛名只认带目录的写法，已在 relative 档试过
  return containsToken(summary, base) ? "basename" : null;
}

/**
 * `base` 作为独立 token 出现（前后不是路径字符）。防 `runner.ts` 命中 `my-runner.ts`。
 */
function containsToken(text: string, token: string): boolean {
  let from = 0;
  for (;;) {
    const i = text.indexOf(token, from);
    if (i < 0) return false;
    const before = i === 0 ? "" : text[i - 1];
    const after = text[i + token.length] ?? "";
    // 前面允许是 `/`（`hook/runner.ts` 算命中），不允许是字母数字、`-`、`_`、`.`
    const okBefore = before === "" || !/[\w.\-]/.test(before);
    const okAfter = after === "" || !/[\w\-]/.test(after);
    if (okBefore && okAfter) return true;
    from = i + 1;
  }
}

/**
 * 校验摘要对关键锚点的覆盖率（纯本地字符串判断，零 LLM 调用）。
 *
 * 定位是「零成本塌陷兜底」：能抓「摘要整块漏掉了某些文件」，测不了「因果写反」这类语义错误。
 */
export function checkCompactQuality(
  originalMessages: Message[],
  summary: string,
): CompactQualityReport {
  const anchors = extractAnchors(originalMessages);
  const matchedBy = { exact: 0, relative: 0, basename: 0 };
  if (anchors.length === 0) {
    return { totalAnchors: 0, coveredAnchors: 0, coverage: 1, missedSamples: [], matchedBy };
  }
  const missed: string[] = [];
  let covered = 0;
  for (const anchor of anchors) {
    const how = matchAnchor(anchor, summary);
    if (how) {
      covered++;
      matchedBy[how]++;
    } else if (missed.length < 10) missed.push(anchor);
  }
  return {
    totalAnchors: anchors.length,
    coveredAnchors: covered,
    coverage: covered / anchors.length,
    missedSamples: missed,
    matchedBy,
  };
}

/**
 * 执行质量校验 + 记日志。设计为 fire-and-forget，任何异常都吞掉不影响主流程。
 *
 * 不再自己落盘：原先写 `<sessionDir>/compact-quality.jsonl`，而 sessionDir 是
 * `/tmp/sid-code-<uid>/sessions/<id>/compact/`，生命周期不归 sid-code 管 ——
 * 2026-11-02 核到 4 个会话写过 23 次，文件全部已被清掉。结构化结果改由调用方
 * （`runPostCompact`）落 `CompactQuality` 事件到 events.jsonl，与 `CompactionAttempt`
 * / `PostCompactReattach` 同文件、可按会话直接 join。
 */
export function recordCompactQuality(
  originalMessages: Message[],
  summary: string,
): CompactQualityReport {
  const log = getLogger();
  const report = checkCompactQuality(originalMessages, summary);
  const how = `exact ${report.matchedBy.exact} / relative ${report.matchedBy.relative} / basename ${report.matchedBy.basename}`;

  if (report.totalAnchors > 0 && report.coverage < COVERAGE_WARN_THRESHOLD) {
    log.warn(
      "COMPACT_QUALITY",
      `压缩摘要覆盖率偏低 ${(report.coverage * 100).toFixed(0)}%（${report.coveredAnchors}/${report.totalAnchors}，${how}），` +
        `可能丢失关键信息。未覆盖样例: ${report.missedSamples.slice(0, 5).join(", ")}`,
    );
  } else {
    log.info(
      "COMPACT_QUALITY",
      `压缩摘要覆盖率 ${(report.coverage * 100).toFixed(0)}%（${report.coveredAnchors}/${report.totalAnchors}，${how}）`,
    );
  }

  return report;
}
