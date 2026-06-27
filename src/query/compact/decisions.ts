/**
 * 关键决策点外化（§4.3，对标"把易丢失的决策落盘 + 摘要引用路径"）
 *
 * 全量摘要会把"为什么这么做"的关键决策稀释成一两句话甚至丢失。本模块在压缩前从被压缩的
 * 消息段提取候选"决策点"（用户纠正、明确指令、架构选择），追加写入会话级 decisions.jsonl，
 * 并构造一条"决策点已外化到 <path>，关键决策摘要如下"的重注入消息，使压缩后：
 *   - 关键决策有持久化副本（decisions.jsonl）可随时查阅
 *   - 模型上下文里保留决策点精炼列表（而非淹没在全量摘要里）
 *
 * 提取是纯启发式（关键词匹配），零 LLM 调用——决策外化必须便宜，否则每次压缩多一次往返。
 */

import { appendFileSync, mkdirSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import type { Message } from "../../llm/types.ts";
import { getLogger } from "../../debug/index.ts";
import { REATTACH_DECISIONS_PREFIX, REATTACH_ORIGIN } from "./reattach-markers.ts";

/** 单条决策记录 */
export interface DecisionRecord {
  /** 决策来源：用户纠正 / 用户指令 / 架构选择 */
  kind: "correction" | "instruction" | "architecture";
  /** 决策正文（截断到合理长度） */
  text: string;
  /** 该决策在原消息历史的下标（诊断用） */
  messageIndex: number;
}

/** 用户纠正信号（"不要这样"、"应该"、"错了"等） */
const CORRECTION_PATTERNS = [
  /不要/, /别/, /错了?/, /不对/, /不应该/, /应该是/, /其实/, /而不是/,
  /don'?t/i, /should not/i, /instead/i, /actually/i, /wrong/i, /no,? /i,
];
/** 架构/技术选择信号 */
const ARCHITECTURE_PATTERNS = [
  /用\s*\S+\s*而不是/, /选择/, /架构/, /方案/, /改用/, /决定/,
  /use\s+\S+\s+instead/i, /architecture/i, /approach/i, /decide/i,
];

/**
 * 从被压缩的消息段提取决策点（纯启发式）。
 * 只看 user 文本消息（决策几乎都来自用户），跳过内部摘要消息。
 */
export function extractDecisions(messages: Message[]): DecisionRecord[] {
  const decisions: DecisionRecord[] = [];
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    if (msg.role !== "user" || msg._meta?.origin) continue;
    for (const block of msg.content) {
      if (block.type !== "text") continue;
      const text = block.text.trim();
      if (!text || text.startsWith("[")) continue; // 跳过占位/摘要

      if (CORRECTION_PATTERNS.some((p) => p.test(text))) {
        decisions.push({ kind: "correction", text: clip(text), messageIndex: i });
      } else if (ARCHITECTURE_PATTERNS.some((p) => p.test(text))) {
        decisions.push({ kind: "architecture", text: clip(text), messageIndex: i });
      }
    }
  }
  return decisions;
}

function clip(text: string): string {
  return text.length > 400 ? text.slice(0, 400) + "…" : text;
}

const KIND_LABEL: Record<DecisionRecord["kind"], string> = {
  correction: "用户纠正",
  instruction: "用户指令",
  architecture: "架构选择",
};

/**
 * 把决策点追加写入 decisions.jsonl（每行一条 JSON）。失败仅告警不抛错。
 * @returns 写入的文件路径；写入失败返回 null。
 */
export function persistDecisions(decisions: DecisionRecord[], sessionDir: string): string | null {
  if (decisions.length === 0) return null;
  const log = getLogger();
  try {
    if (!existsSync(sessionDir)) mkdirSync(sessionDir, { recursive: true, mode: 0o700 });
    const filePath = join(sessionDir, "decisions.jsonl");
    const lines = decisions
      .map((d) => JSON.stringify({ ...d, ts: undefined })) // ts 由调用方在外部补；此处不依赖 Date
      .join("\n");
    appendFileSync(filePath, lines + "\n", "utf-8");
    return filePath;
  } catch (err: any) {
    log.warn("DECISIONS", `决策点外化写入失败: ${err.message}`);
    return null;
  }
}

/**
 * 构造决策点重注入消息对（无决策返回空数组）。
 * @param decisions 提取的决策点
 * @param decisionsPath decisions.jsonl 路径（null 表示未落盘，仅内联摘要）
 */
export function buildDecisionReattachMessages(
  decisions: DecisionRecord[],
  decisionsPath: string | null,
): Message[] {
  if (decisions.length === 0) return [];
  const list = decisions
    .map((d, idx) => `${idx + 1}. [${KIND_LABEL[d.kind]}] ${d.text}`)
    .join("\n");
  const pathNote = decisionsPath ? `\n\n（完整决策记录已外化到：${decisionsPath}）` : "";
  const userMsg: Message = {
    role: "user",
    content: [
      {
        type: "text",
        text: `${REATTACH_DECISIONS_PREFIX} 压缩前的关键决策点（务必继续遵循，尤其是用户纠正）：\n${list}${pathNote}`,
      },
    ],
    _meta: { origin: REATTACH_ORIGIN },
  };
  const ackMsg: Message = {
    role: "assistant",
    content: [{ type: "text", text: "好的，我记下了这些关键决策，会继续遵循。" }],
    _meta: { origin: REATTACH_ORIGIN },
  };
  return [userMsg, ackMsg];
}

/** 确保 dirname 存在（供调用方落盘前调用） */
export function ensureDir(filePath: string): void {
  const dir = dirname(filePath);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
}
