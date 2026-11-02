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
// 缺陷 13：路径判据复用权限层同一个函数（带分隔符），两层对「是不是记忆写入」结论一致。
import { isAutoMemPath } from "../paths.ts";
import { logMemoryExtract } from "../../analytics/events.ts";
import { indexTypeRank } from "../index-budget.ts";
import { formatIndexCapacity, readIndexCapacity } from "../index-capacity.ts";
import type { MemoryHeader } from "../types.ts";

/**
 * 解析抽取节流间隔（横向剖析 T2）。优先级：env `SID_CODE_MEMORY_EXTRACT_INTERVAL` >
 * settings `memoryExtractInterval` > 1。非正整数一律回落 1（宁可行为不变，也不让一个
 * 拼错的值把抽取整个关掉 —— 关掉有专门的 autoMemory 开关）。
 */
export function resolveMemoryExtractInterval(settingValue?: number): number {
  const parse = (v: unknown): number | undefined => {
    const n = typeof v === "string" ? Number(v.trim()) : v;
    return typeof n === "number" && Number.isInteger(n) && n >= 1 ? n : undefined;
  };
  const env = process.env.SID_CODE_MEMORY_EXTRACT_INTERVAL;
  if (env !== undefined && env !== "") {
    const n = parse(env);
    if (n !== undefined) return n;
  }
  return parse(settingValue) ?? 1;
}

/**
 * 清单排序（T3）：按索引保留优先级分组、组内 mtime 倒序 —— 与 `writeIndex` 同一顺序，
 * 模型先看到的就是会进索引的那部分。
 */
export function sortManifestHeaders(headers: MemoryHeader[]): MemoryHeader[] {
  return [...headers].sort(
    (a, b) => indexTypeRank(a.type) - indexTypeRank(b.type) || b.mtimeMs - a.mtimeMs,
  );
}

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
  // 不再有 teamMemoryEnabled：后台代理只能写 project，见 extract/prompts.ts 顶部注释。
  /**
   * 横向剖析 T2：每 N 个 end_turn 才真跑一次（缺省 1 = 行为不变）。
   * 由调用方经 `resolveMemoryExtractInterval` 解析 env / settings 后传入。
   */
  interval?: number;
  /** 测试注入点：替换 fork 执行器（缺省 runForkedAgent）。生产代码不要传。 */
  runFork?: typeof runForkedAgent;
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

  for (let i = Math.max(0, lastUserIdx); i < messages.length; i++) {
    const msg = messages[i];
    if (msg.role !== "assistant") continue;
    for (const block of msg.content) {
      if (block.type !== "tool_use") continue;
      if (block.name === "save_memory") return true;
      if (block.name === "write" || block.name === "edit") {
        const input = block.input as Record<string, unknown> | undefined;
        const fp = input?.file_path ?? input?.path;
        // 裸 startsWith 会把 `memory-backup/` 当成 `memory/`，本轮提取被误跳过（缺陷 13）。
        if (typeof fp === "string" && isAutoMemPath(fp, memoryDir)) return true;
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
        if (typeof fp === "string" && isAutoMemPath(fp, memoryDir)) {
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
  const interval = Math.max(1, Math.floor(ctx.interval ?? 1));
  let pending: Promise<void> | null = null;
  /** 本会话第几个触发抽取的 end_turn（跳过的也占号，影子模拟要靠它对齐） */
  let seq = 0;
  /**
   * 自上次真跑以来是否有被节流跳过的 end_turn（T2 第 3 条的积压）。
   * 只需要布尔：fork 每次都看完整对话，补跑一次就覆盖了全部积压轮次。
   */
  let backlog = false;

  async function runExtraction(runSeq: number, catchUp: boolean): Promise<void> {
    const mainContext = ctx.getMainContext();

    // 互斥：主代理已写入记忆则跳过
    if (hasMemoryWritesSince(mainContext.messages, ctx.memoryDir)) {
      log.debug("EXTRACT", "主代理本轮已写入记忆，跳过后台提取");
      logMemoryExtract({
        outcome: "skipped",
        reason: "main_wrote",
        seq: runSeq,
        interval,
        catchUp,
      });
      return;
    }

    // 扫描现有记忆构建清单。T3：按索引保留优先级排序 + 头部给出容量状态。
    const headers = sortManifestHeaders(await scanMemoryFiles(ctx.memoryDir));
    const manifest = formatMemoryManifest(headers);
    const promptText = buildExtractPrompt(
      manifest,
      formatIndexCapacity(readIndexCapacity(ctx.memoryDir)),
    );

    const promptMessages: Message[] = [
      { role: "user", content: [{ type: "text", text: promptText }] },
    ];

    const result = await (ctx.runFork ?? runForkedAgent)(mainContext, {
      promptMessages,
      canUseTool: ctx.canUseTool,
      maxTurns: 5,
      querySource: "memory-extract",
      timeoutMs: 60_000,
    });

    // 去重（对话重播幻觉修复 Fix 4）：同一 key/文件在一次提取中被 save_memory 多次
    // （或 write+edit 混用）会重复出现，导致"已保存 N 条记忆: x, x"这类误导文案。
    const written = [...new Set(extractWrittenPaths(result.messages, ctx.memoryDir))];
    // T2 影子统计：真跑的那次记录写了几条、花了多少 token（模拟 N=3/5 的依据）
    logMemoryExtract({
      outcome: "ran",
      seq: runSeq,
      interval,
      written: written.length,
      inputTokens: result.usage?.inputTokens ?? 0,
      outputTokens: result.usage?.outputTokens ?? 0,
      catchUp,
    });
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

  function start(runSeq: number, catchUp: boolean): Promise<void> {
    backlog = false;
    const p = runExtraction(runSeq, catchUp)
      .catch((err) => log.debug("EXTRACT", `后台提取失败: ${err.message}`))
      .finally(() => {
        pending = null;
      });
    pending = p;
    return p;
  }

  return {
    executeExtract: async () => {
      seq += 1;
      // 上一次提取未完成则跳过（避免堆积）。在途那次看到的对话不含本轮，记为积压。
      if (pending) {
        // 不记积压：这条路径在节流前就存在（行为是直接丢弃），interval=1 时必须行为不变，
        // 补跑只为节流兜底（T2 第 3 条），不扩大到在途跳过。
        log.debug("EXTRACT", "上一次提取尚未完成，跳过本轮");
        logMemoryExtract({ outcome: "skipped", reason: "in_flight", seq, interval });
        return;
      }
      // T2：每 N 个 end_turn 才真跑一次。interval=1 时恒跑（行为不变）。
      if (seq % interval !== 0) {
        backlog = true;
        logMemoryExtract({ outcome: "skipped", reason: "interval", seq, interval });
        return;
      }
      void start(seq, false);
      // fire-and-forget：不 await
    },

    drainPending: async (timeoutMs = 60_000) => {
      const deadline = Date.now() + timeoutMs;
      const waitFor = async (p: Promise<void>) => {
        const left = deadline - Date.now();
        if (left <= 0) return;
        let timer: ReturnType<typeof setTimeout> | undefined;
        const timeout = new Promise<void>((resolve) => {
          timer = setTimeout(resolve, left);
        });
        await Promise.race([p, timeout]);
        if (timer) clearTimeout(timer);
      };
      if (pending) await waitFor(pending);
      // T2 第 3 条：节流后有未跑的积压 → 会话收尾补跑一次，避免整段会话一次都没抽。
      // 仍在途（上面超时了）就不补：同一时刻只允许一个抽取 fork。
      if (backlog && !pending && deadline - Date.now() > 0) {
        await waitFor(start(seq, true));
      }
    },
  };
}
