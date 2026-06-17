/**
 * 工具输出遮罩服务
 * 混合后向扫描 FIFO，保护最近 50K token 输出，旧输出保存到临时文件并替换为摘要
 */

import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { ensureSessionTempDir } from "../utils/temp-dir.ts";
import { estimateTextTokens } from "./token.ts";
import { isPersistedReference } from "./tool-result-storage.ts";
import type { Message } from "../llm/types.ts";

/** 保护窗口：最近 50K token 的工具输出不遮罩 */
const PROTECTION_THRESHOLD = 50_000;
/** 累积超过 30K token 的可修剪输出才触发批量遮罩 */
const MIN_PRUNABLE_THRESHOLD = 30_000;
/** 遮罩标识 */
const MASKING_TAG = "[tool_output_masked]";
/** 不遮罩的工具列表（记忆、用户交互等关键工具） */
const EXEMPT_TOOLS = new Set(["memory", "ask_user"]);

/** 已清理的工具输出的占位文本（统一常量，避免硬编码分散） */
export const TOOL_RESULT_CLEARED_MESSAGE = "[旧的工具输出已清理]";

interface MaskCandidate {
  msgIdx: number;
  blockIdx: number;
  tokens: number;
  toolName: string;
  content: string;
}

export class ToolOutputMaskingService {
  private sessionDir: string;

  constructor(sessionId?: string) {
    // 多用户隔离：会话级临时目录带 UID（getSidTempDirName），以 0o700 创建
    this.sessionDir = ensureSessionTempDir(sessionId, "masked-outputs");
  }

  /**
   * 对消息列表执行工具输出遮罩
   * 返回遮罩后的消息列表（深拷贝，不修改原始数据）
   */
  mask(messages: Message[]): Message[] {
    // 第一遍：后向扫描，收集保护窗口外的可修剪候选
    let protectedTokens = 0;
    const candidates: MaskCandidate[] = [];

    for (let i = messages.length - 1; i >= 0; i--) {
      const msg = messages[i];
      for (let j = msg.content.length - 1; j >= 0; j--) {
        const block = msg.content[j];
        if (block.type !== "tool_result") continue;

        // 已是持久化引用（约 200 字节），跳过遮罩（无需再压缩）
        if (typeof block.content === "string" && isPersistedReference(block.content)) {
          continue;
        }

        const tokens = estimateTextTokens(block.content);

        // 查找对应的 tool_use 获取工具名
        const toolName = this.findToolName(messages, block.tool_use_id);
        if (EXEMPT_TOOLS.has(toolName)) continue;

        if (protectedTokens < PROTECTION_THRESHOLD) {
          protectedTokens += tokens;
          continue; // 在保护窗口内，跳过
        }

        candidates.push({ msgIdx: i, blockIdx: j, tokens, toolName, content: block.content });
      }
    }

    // 检查是否达到批量触发阈值
    const totalPrunable = candidates.reduce((sum, c) => sum + c.tokens, 0);
    if (totalPrunable < MIN_PRUNABLE_THRESHOLD) {
      return messages; // 不值得遮罩，直接返回
    }

    // 构建候选集合用于快速查找
    const candidateSet = new Map<string, MaskCandidate>();
    for (const c of candidates) {
      candidateSet.set(`${c.msgIdx}:${c.blockIdx}`, c);
    }

    // 第二遍：执行遮罩
    const masked: Message[] = messages.map((msg, msgIdx) => ({
      role: msg.role,
      content: msg.content.map((block, blockIdx) => {
        const candidate = candidateSet.get(`${msgIdx}:${blockIdx}`);
        if (!candidate) return block;

        // 生成预览摘要
        const preview = this.generatePreview(candidate.content, candidate.toolName);
        // 离线存储完整内容
        const filePath = this.saveToFile(candidate);

        return {
          ...block,
          content: `${MASKING_TAG}\n${preview}\n[完整输出已保存到: ${filePath}]`,
        };
      }),
    }));

    return masked;
  }

  /** 生成结构化预览 */
  private generatePreview(content: string, toolName: string): string {
    // bash 工具：提取 Output/Error/Exit Code 结构
    if (toolName === "bash") {
      return this.generateBashPreview(content);
    }
    // 其他工具：保留前 5 行 + 后 3 行
    const lines = content.split("\n");
    if (lines.length <= 10) return content;
    const head = lines.slice(0, 5).join("\n");
    const tail = lines.slice(-3).join("\n");
    return `${head}\n... [省略 ${lines.length - 8} 行] ...\n${tail}`;
  }

  /** bash 输出的结构化预览 */
  private generateBashPreview(content: string): string {
    const lines = content.split("\n");
    const parts: string[] = [];
    // 提取前 3 行输出
    parts.push(`Output (前 3 行): ${lines.slice(0, 3).join("\n")}`);
    // 提取退出码（如果有）
    const exitMatch = content.match(/exit code[:\s]*(\d+)/i);
    if (exitMatch) parts.push(`Exit Code: ${exitMatch[1]}`);
    parts.push(`总行数: ${lines.length}`);
    return parts.join("\n");
  }

  /** 保存完整输出到临时文件 */
  private saveToFile(candidate: MaskCandidate): string {
    const filename = `tool-output-${candidate.msgIdx}-${candidate.blockIdx}.txt`;
    const filePath = join(this.sessionDir, filename);
    try {
      writeFileSync(filePath, candidate.content, "utf-8");
    } catch {
      return "[保存失败]";
    }
    return filePath;
  }

  /** 从消息历史中查找 tool_use_id 对应的工具名 */
  private findToolName(messages: Message[], toolUseId: string): string {
    for (const msg of messages) {
      for (const block of msg.content) {
        if (block.type === "tool_use" && block.id === toolUseId) {
          return block.name;
        }
      }
    }
    return "unknown";
  }
}
