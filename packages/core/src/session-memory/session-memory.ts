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
  /**
   * 会话 id（P0-4）。**必须传**，否则派生出的是跨会话共享的旧路径 ——
   * 并发会话与 `--resume` 会互相覆盖彼此的笔记，压缩时还会把别人的笔记
   * 当作「本次会话」的历史替代品注入（详见 `getSessionMemoryPath` 注释）。
   * 只有显式传 `filePath` 的测试可以省略它。
   */
  sessionId?: string;
  /**
   * 测试注入点：替换 fork 执行器（缺省 `runForkedAgent`）。生产代码不要传。
   * 与 `memory/extract/extractor.ts` 的 `ExtractContext.runFork` 同一形态 ——
   * 「后台闸门等的是真实工作」只能靠一个会挂住的假 fork 来验证（CP-7/C1）。
   */
  runFork?: typeof runForkedAgent;
}

/**
 * 初始化 Session Memory 系统。
 */
export function initSessionMemory(opts: InitSessionMemoryOptions): SessionMemoryHandle {
  const log = getLogger();
  const config: SessionMemoryConfig = { ...DEFAULT_SESSION_MEMORY_CONFIG, ...opts.config };
  const filePath = opts.filePath ?? getSessionMemoryPath(opts.cwd, opts.sessionId);
  if (!opts.filePath && !opts.sessionId) {
    // 不静默降级：这条路径是跨会话共享的，接线漏传 sessionId 必须留下痕迹，
    // 否则「两个会话互相覆盖笔记」在日志里看不出任何异常（缺陷 12：零埋点）。
    log.warn(
      "SESSION_MEM",
      `未传 sessionId，回退到跨会话共享的旧路径（并发/resume 会互相污染）: ${filePath}`,
    );
  }
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
        filePath,
      );
      const promptMessages: Message[] = [
        { role: "user", content: [{ type: "text", text: promptText }] },
      ];

      await (opts.runFork ?? runForkedAgent)(mainContext, {
        promptMessages,
        canUseTool: opts.canUseTool,
        // 不设 maxTurns（对齐 CC）：轨迹 166 次 run 中 65 次（39%）恰好停在 5 轮，
        // 说明是被截断而非自然收尾——笔记只更新了一半。轮数靠提示词「一次并行 Edit 后停止」收敛。
        querySource: "session-memory-update",
        // D16：会话笔记只用 read / edit；快照缺它们就退回全量工具（见 ForkedAgentOptions.requiredTools）
        requiredTools: ["read", "edit"],
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
        // 本轮没有真实工作：返回已 resolve 的 promise。不能把上一轮那条链
        // 冒充成本轮的时长 —— 闸门会拿它当"这一笔在跑多久"，串行就失真。
        return;
      }
      pending = runUpdate()
        .catch((err) => log.debug("SESSION_MEM", `更新失败: ${err.message}`))
        .finally(() => {
          pending = null;
        });
      // CP-7：必须把真实工作的 promise 交出去。`runBackgroundTask` 的闸门等的就是这个
      // 返回值 —— 这里若 fire-and-forget，几个微任务后 `inFlight` 就被清空，串行、
      // 退出排空（pre-flush drain）与 `/cost` 的「进行中」提示全部失效，而
      // `admitted/deferred` 统计看上去完全正常。调用方（`query/loop.ts`）不 await
      // 它，所以主循环收尾延迟不变。
      return pending;
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
