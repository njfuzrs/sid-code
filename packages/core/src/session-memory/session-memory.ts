/**
 * Session Memory 管理器（Task 4）
 *
 * 在压缩发生之前持续维护一份结构化会话摘要（.session_memory.md），
 * 压缩时注入，作为"被丢弃历史"的替代品，解决长会话"压缩后失忆"。
 *
 * 提取通过 Forked Agent 完成，代理只能编辑 .session_memory.md 单个文件。
 */

import { existsSync, mkdirSync } from "fs";
import { dirname } from "path";
import type { Message } from "../llm/types.ts";
import type { ForkedAgentContext, CanUseToolFn } from "../agent/forked-agent.ts";
import { runForkedAgent } from "../agent/forked-agent.ts";
import { getSessionMemoryPath } from "../memory/paths.ts";
import { getLogger } from "../debug/logger.ts";
import { DEFAULT_SESSION_MEMORY_TEMPLATE, buildSessionMemoryUpdatePrompt } from "./prompts.ts";
import {
  type SessionMemoryConfig,
  type SessionMemoryState,
  DEFAULT_SESSION_MEMORY_CONFIG,
  initialSessionMemoryState,
  shouldExtractSessionMemory,
  estimateMessagesTokens,
} from "./utils.ts";

/** Session Memory 系统句柄 */
export interface SessionMemoryHandle {
  /** 后采样钩子，每轮结束后调用 */
  updateSessionMemory: () => Promise<void>;
  /** 获取当前 Session Memory 内容（无内容返回 null） */
  getContent: () => Promise<string | null>;
  /** 等待进行中的提取完成 */
  waitForExtraction: (timeoutMs?: number) => Promise<void>;
  /** 记录一次工具调用（用于双阈值计数） */
  recordToolCall: () => void;
  /** 当前文件路径 */
  filePath: string;
  /** 当前状态（只读快照，测试用） */
  getState: () => Readonly<SessionMemoryState>;
}

/** Session Memory 初始化选项 */
export interface InitSessionMemoryOptions {
  getMainContext: () => ForkedAgentContext;
  /** 提取代理工具权限（限制只能编辑 session memory 文件） */
  canUseTool: CanUseToolFn;
  config?: Partial<SessionMemoryConfig>;
  /** 覆盖文件路径（测试用） */
  filePath?: string;
  /** 覆盖工作目录（用于派生文件路径） */
  cwd?: string;
}

/**
 * 初始化 Session Memory 系统。
 */
export function initSessionMemory(opts: InitSessionMemoryOptions): SessionMemoryHandle {
  const log = getLogger();
  const config: SessionMemoryConfig = { ...DEFAULT_SESSION_MEMORY_CONFIG, ...opts.config };
  const filePath = opts.filePath ?? getSessionMemoryPath(opts.cwd);
  const state = initialSessionMemoryState();
  let pending: Promise<void> | null = null;

  async function readContent(): Promise<string | null> {
    if (!existsSync(filePath)) return null;
    try {
      const text = await Bun.file(filePath).text();
      return text.trim() || null;
    } catch {
      return null;
    }
  }

  async function ensureFile(): Promise<string> {
    if (!existsSync(filePath)) {
      const dir = dirname(filePath);
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
      await Bun.write(filePath, DEFAULT_SESSION_MEMORY_TEMPLATE);
    }
    return (await readContent()) ?? DEFAULT_SESSION_MEMORY_TEMPLATE;
  }

  async function runUpdate(): Promise<void> {
    const mainContext = opts.getMainContext();
    const messages = mainContext.messages;

    if (!shouldExtractSessionMemory(state, messages, config)) {
      return;
    }

    state.extractionInProgress = true;
    state.extractionStartedAt = Date.now();
    try {
      const currentContent = await ensureFile();
      const promptText = buildSessionMemoryUpdatePrompt(
        currentContent,
        DEFAULT_SESSION_MEMORY_TEMPLATE,
      );
      const promptMessages: Message[] = [
        { role: "user", content: [{ type: "text", text: promptText }] },
      ];

      await runForkedAgent(mainContext, {
        promptMessages,
        canUseTool: opts.canUseTool,
        maxTurns: 5,
        querySource: "session-memory-update",
        timeoutMs: 60_000,
      });

      // 更新状态
      state.initialized = true;
      state.lastSummarizedTokenCount = estimateMessagesTokens(messages);
      state.toolCallsSinceLastUpdate = 0;
      log.debug("SESSION_MEM", `Session Memory 已更新 (${filePath})`);
    } finally {
      state.extractionInProgress = false;
    }
  }

  return {
    filePath,

    updateSessionMemory: async () => {
      if (pending) {
        log.debug("SESSION_MEM", "上一次更新尚未完成，跳过本轮");
        return;
      }
      pending = runUpdate()
        .catch((err) => log.debug("SESSION_MEM", `更新失败: ${err.message}`))
        .finally(() => {
          pending = null;
        });
      // fire-and-forget
    },

    getContent: readContent,

    waitForExtraction: async (timeoutMs = 15_000) => {
      if (!pending) return;
      const timeout = new Promise<void>((resolve) => setTimeout(resolve, timeoutMs));
      await Promise.race([pending, timeout]);
    },

    recordToolCall: () => {
      state.toolCallsSinceLastUpdate++;
    },

    getState: () => ({ ...state }),
  };
}
