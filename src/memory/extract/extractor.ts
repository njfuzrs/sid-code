/**
 * 后台记忆提取调度器（Task 3）
 *
 * 在每轮对话结束后（end_turn），fire-and-forget 地跑一个 Forked Agent，
 * 从对话中提取值得记住的信息写入记忆目录。
 *
 * 互斥机制：若主代理本轮已直接写入记忆（save_memory / Write 到 memoryDir），
 * 则跳过本轮后台提取，避免重复写入。
 */

import type { Message } from "../../llm/types.ts";
import type { ForkedAgentContext, CanUseToolFn } from "../../agent/forked-agent.ts";
import { runForkedAgent } from "../../agent/forked-agent.ts";
import { scanMemoryFiles, formatMemoryManifest } from "../scan.ts";
import { buildExtractPrompt } from "./prompts.ts";
import { getLogger } from "../../debug/logger.ts";

/** 提取系统句柄 */
export interface ExtractMemoriesHandle {
  /** 每轮对话结束后调用（fire-and-forget） */
  executeExtract: () => Promise<void>;
  /** 会话关闭前调用，等待进行中的提取完成 */
  drainPending: (timeoutMs?: number) => Promise<void>;
}

/** 提取上下文 */
export interface ExtractContext {
  getMainContext: () => ForkedAgentContext;
  memoryDir: string;
  canUseTool: CanUseToolFn;
  appendSystemMessage?: (msg: Message) => void;
}

/**
 * 检查主代理是否在最后一条用户消息之后写入了记忆文件。
 * 扫描 assistant 消息中的 tool_use 块，检查是否有 save_memory，
 * 或 Write/Edit 指向记忆目录。
 */
export function hasMemoryWritesSince(messages: Message[], memoryDir: string): boolean {
  // 找到最后一条 user（非 tool_result）消息的位置
  let lastUserIdx = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg.role === "user") {
      const isToolResult = msg.content.every((b) => b.type === "tool_result");
      if (!isToolResult) {
        lastUserIdx = i;
        break;
      }
    }
  }

  const path = require("path");
  for (let i = Math.max(0, lastUserIdx); i < messages.length; i++) {
    const msg = messages[i];
    if (msg.role !== "assistant") continue;
    for (const block of msg.content) {
      if (block.type !== "tool_use") continue;
      if (block.name === "save_memory") return true;
      if (block.name === "write" || block.name === "edit") {
        const input = block.input as Record<string, unknown> | undefined;
        const fp = input?.file_path ?? input?.path;
        if (typeof fp === "string") {
          const resolved = path.resolve(fp);
          if (resolved.startsWith(path.resolve(memoryDir))) return true;
        }
      }
    }
  }
  return false;
}

/** 从 forked agent 结果中提取被写入的记忆文件路径 */
export function extractWrittenPaths(messages: Message[], memoryDir: string): string[] {
  const path = require("path");
  const paths: string[] = [];
  for (const msg of messages) {
    if (msg.role !== "assistant") continue;
    for (const block of msg.content) {
      if (block.type !== "tool_use") continue;
      if (block.name === "save_memory") {
        const input = block.input as Record<string, unknown> | undefined;
        const key = input?.key;
        if (typeof key === "string") paths.push(key);
      } else if (block.name === "write" || block.name === "edit") {
        const input = block.input as Record<string, unknown> | undefined;
        const fp = input?.file_path ?? input?.path;
        if (typeof fp === "string" && path.resolve(fp).startsWith(path.resolve(memoryDir))) {
          paths.push(path.basename(fp));
        }
      }
    }
  }
  return paths;
}

/**
 * 初始化记忆提取系统。
 */
export function initExtractMemories(ctx: ExtractContext): ExtractMemoriesHandle {
  const log = getLogger();
  let pending: Promise<void> | null = null;

  async function runExtraction(): Promise<void> {
    const mainContext = ctx.getMainContext();

    // 互斥：主代理已写入记忆则跳过
    if (hasMemoryWritesSince(mainContext.messages, ctx.memoryDir)) {
      log.debug("EXTRACT", "主代理本轮已写入记忆，跳过后台提取");
      return;
    }

    // 扫描现有记忆构建清单
    const headers = await scanMemoryFiles(ctx.memoryDir);
    const manifest = formatMemoryManifest(headers);
    const promptText = buildExtractPrompt(manifest);

    const promptMessages: Message[] = [
      { role: "user", content: [{ type: "text", text: promptText }] },
    ];

    const result = await runForkedAgent(mainContext, {
      promptMessages,
      canUseTool: ctx.canUseTool,
      maxTurns: 5,
      querySource: "memory-extract",
      timeoutMs: 60_000,
    });

    const written = extractWrittenPaths(result.messages, ctx.memoryDir);
    if (written.length > 0 && ctx.appendSystemMessage) {
      ctx.appendSystemMessage({
        role: "user",
        content: [
          {
            type: "text",
            text: `<system-reminder>已保存 ${written.length} 条记忆: ${written.join(", ")}</system-reminder>`,
          },
        ],
      });
      log.info("EXTRACT", `后台提取保存了 ${written.length} 条记忆`);
    }
  }

  return {
    executeExtract: async () => {
      // 上一次提取未完成则跳过（避免堆积）
      if (pending) {
        log.debug("EXTRACT", "上一次提取尚未完成，跳过本轮");
        return;
      }
      pending = runExtraction()
        .catch((err) => log.debug("EXTRACT", `后台提取失败: ${err.message}`))
        .finally(() => { pending = null; });
      // fire-and-forget：不 await
    },

    drainPending: async (timeoutMs = 60_000) => {
      if (!pending) return;
      const timeout = new Promise<void>((resolve) => setTimeout(resolve, timeoutMs));
      await Promise.race([pending, timeout]);
    },
  };
}
