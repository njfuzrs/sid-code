/**
 * 记忆动态召回（Task 2）
 *
 * 不再把所有记忆全量注入系统提示词，而是根据当前查询用轻量 LLM 初筛，
 * 选出最相关的 ≤5 个记忆文件，读取完整正文 + 附加新鲜度警告后返回。
 *
 * 设计：用 LLM 选择器而非向量搜索——向量搜索需要 embedding 模型 + 向量库，
 * 引入额外依赖；LLM 选择器只需一次轻量调用（≤256 tokens），成本极低，
 * 且能理解语义关系。
 *
 * 为可测试性，sideQuery 通过依赖注入传入，单测可用 stub。
 *
 * ─────────────────────────────────────────────────────────────────────
 * 【接线状态：休眠能力，非死代码】（2026-07 对标 claude-code 后定性）
 *
 * 当前主循环走的是「MEMORY.md 索引全量注入 system prompt，模型按需 Read」路径
 * （见 memory/prompt.ts + query/init-helpers.ts），与 claude-code 的**默认**行为
 * 一致——claude-code 也是默认全量注入，仅在 feature flag `tengu_moth_copse` 打开时
 * 才切换到这里这种「Sonnet sideQuery 筛 top-5 再注入」的语义召回路径。
 *
 * 索引本身极轻（一行一指针，claude-code 实测硬截断到 200 行 / 25KB），全量注入对
 * 中小记忆库完全可控，所以召回是「大记忆库省 token」的优化项，而非必需。
 *
 * 本模块保留为 **flag 门控的休眠能力**（对齐 claude-code「两路温存、开关切换」，而非
 * 删除）：`isMemoryRecallEnabled()` 默认 false，仅 `SID_CODE_MEMORY_RECALL=1` 时启用。
 * 接通点见 `isMemoryRecallEnabled` 的文档注释。**未接通期间不要在文档里宣称记忆走
 * 语义召回**——那是文档失实（本轮已修正 E.11 FAQ）。
 * ─────────────────────────────────────────────────────────────────────
 */

import { existsSync } from "fs";
import { scanMemoryFiles, formatMemoryManifest, stripFrontmatter } from "./scan.ts";
import { buildFreshnessWarning } from "./freshness.ts";
import { MEMORY_LIMITS, type RelevantMemory } from "./types.ts";
import { getLogger } from "../debug/logger.ts";
import { recordSideCall } from "../trace/side-call-sink.ts";
import { withSideCallDeadline, SIDE_CALL_NO_THINK } from "../llm/side-call-timeout.ts";
import { SIDE_CALL_TIMEOUT_REASON } from "../llm/errors.ts";
import { resolveSideCallTimeouts } from "../config/network-profile.ts";

/**
 * 记忆语义召回是否启用（flag 门控的休眠能力，对齐 claude-code `tengu_moth_copse`）。
 *
 * 默认 **false**：走全量索引注入（memory/prompt.ts），与 claude-code 默认一致。
 * 设 `SID_CODE_MEMORY_RECALL=1` 时启用语义召回——此时应在主循环每轮（或每 N 轮）
 * 调用 `findRelevantMemories`，把结果经 `generateRecalledMemoryAttachment`
 * （config/attachments.ts，优先级 MEMORY_RECALLED）注入，并停止全量索引注入。
 *
 * 之所以门控而非直接接通：全量注入对中小记忆库足够，语义召回每轮多一次 sideQuery，
 * 只有记忆库大到全量注入吃紧时才划算——把决策权交给部署方，而不是写死。
 */
export function isMemoryRecallEnabled(): boolean {
  return process.env.SID_CODE_MEMORY_RECALL === "1";
}

/** 轻量 LLM 调用签名（依赖注入，便于测试） */
export type SideQueryFn = (opts: {
  system: string;
  user: string;
  maxTokens: number;
  signal?: AbortSignal;
}) => Promise<string>;

/** 召回选择器系统提示词 */
const SELECTOR_SYSTEM = `你是记忆选择器。给定当前查询和可用记忆清单，从中挑选与查询最相关的记忆文件。
规则：
- 最多选择 ${MEMORY_LIMITS.RECALL_MAX} 个
- 只选真正相关的，宁缺毋滥；不相关时返回空数组
- 只返回 JSON，格式：{"selected": ["filename1.md", "filename2.md"]}
- 不要输出任何其他文字`;

/** 从 LLM 输出解析选中的文件名 */
export function parseSelection(text: string, validFilenames: Set<string>): string[] {
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) return [];
  try {
    const obj = JSON.parse(match[0]);
    const arr: unknown = obj.selected ?? obj.selected_memories ?? obj.memories;
    if (!Array.isArray(arr)) return [];
    return arr
      .filter((x): x is string => typeof x === "string")
      .filter((fn) => validFilenames.has(fn))
      .slice(0, MEMORY_LIMITS.RECALL_MAX);
  } catch {
    return [];
  }
}

/**
 * 根据当前查询，从记忆目录中选出最相关的记忆文件。
 *
 * @param query        当前用户查询
 * @param memoryDir    记忆目录
 * @param sideQuery    轻量 LLM 调用
 * @param opts.signal           中止信号
 * @param opts.recentTools      最近使用过的工具（其相关 reference 记忆会被排除，避免重复）
 * @param opts.alreadySurfaced  已经注入过的记忆文件名（避免多轮重复注入）
 */
export async function findRelevantMemories(
  query: string,
  memoryDir: string,
  sideQuery: SideQueryFn,
  opts?: {
    signal?: AbortSignal;
    recentTools?: readonly string[];
    alreadySurfaced?: ReadonlySet<string>;
  },
): Promise<RelevantMemory[]> {
  const log = getLogger();
  if (!existsSync(memoryDir)) return [];

  const headers = await scanMemoryFiles(memoryDir, opts?.signal);
  if (headers.length === 0) return [];

  // 排除已注入过的记忆
  const surfaced = opts?.alreadySurfaced ?? new Set<string>();
  const candidates = headers.filter((h) => !surfaced.has(h.filename));
  if (candidates.length === 0) return [];

  const manifest = formatMemoryManifest(candidates);
  const validFilenames = new Set(candidates.map((h) => h.filename));

  let selectedNames: string[];
  try {
    const out = await sideQuery({
      system: SELECTOR_SYSTEM,
      user: `Query: ${query}\n\nAvailable memories:\n${manifest}`,
      maxTokens: 256,
      signal: opts?.signal,
    });
    selectedNames = parseSelection(out, validFilenames);
  } catch (err: any) {
    log.debug("MEMORY", `记忆召回 sideQuery 失败，跳过: ${err.message}`);
    // T13.3：记录失败的 side-call
    recordSideCall({
      label: "memory-recall",
      model: "unknown",
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      durationMs: 0,
      success: false,
      error: err.message,
      timedOut: /timeout|超时|timed out/i.test(err.message),
    });
    return [];
  }

  if (selectedNames.length === 0) return [];

  // 读取选中文件完整正文
  const results: RelevantMemory[] = [];
  for (const filename of selectedNames) {
    const header = candidates.find((h) => h.filename === filename);
    if (!header) continue;
    try {
      const raw = await Bun.file(header.filePath).text();
      const body = stripFrontmatter(raw);
      const warning = buildFreshnessWarning(header.mtimeMs);
      const content = warning ? `<system-reminder>${warning}</system-reminder>\n\n${body}` : body;
      results.push({
        path: header.filePath,
        filename: header.filename,
        mtimeMs: header.mtimeMs,
        content,
      });
    } catch {
      // 跳过读取失败的文件
    }
  }

  log.debug("MEMORY", `记忆召回: 选中 ${results.length}/${candidates.length} 条`);
  return results;
}

/**
 * 构造一个基于 Provider 的 sideQuery 实现。
 * 复用主对话 provider，但走独立短调用，不影响主上下文。
 */
export function makeSideQuery(
  provider: { sendMessageStream: (params: any, signal?: AbortSignal) => AsyncIterable<any> },
  model: string,
  availability?: import("../llm/availability.ts").ModelAvailabilityService,
): SideQueryFn {
  return async ({ system, user, maxTokens, signal }) => {
    // T3.4：记忆召回是轻量初筛（≤256 tokens），15s 硬超时足够。超时后 throw
    // SideCallTimeoutError，由 recall 调用方 catch（召回失败不阻断会话启动）。
    // 配置-4：走 network-profile 的 side-call 子表统一解析（env override > 默认 15s）
    const RECALL_TIMEOUT_MS = resolveSideCallTimeouts().recallMs;

    const { text, streamUsage } = await withSideCallDeadline(
      "memory-recall",
      RECALL_TIMEOUT_MS,
      async (mergedSignal) => {
        // B3（D10，C级）：改走漏斗而非直连。收紧参数：记忆召回是轻量初筛，只值得
        // 轻量重试，deadlineAt 与本函数 15s 硬超时同源，退避睡不完就提前收手。
        const { streamWithResilience } = await import("../llm/resilient-stream.ts");
        const stream = streamWithResilience(
          provider as any,
          {
            model,
            system,
            messages: [{ role: "user", content: [{ type: "text", text: user }] }],
            maxTokens,
            // H5：记忆召回是「挑相关记忆→出列表」的轻量任务，关思考。
            thinking: SIDE_CALL_NO_THINK,
          },
          mergedSignal,
          {
            querySource: "memory_recall",
            switchMode: "auto",
            maxRetries: 2,
            retryBackoffBaseMs: 1000,
            retryBackoffMaxMs: 5000,
            streamTimeoutMs: RECALL_TIMEOUT_MS,
            deadlineAt: Date.now() + RECALL_TIMEOUT_MS,
            availability,
          },
        );
        let t = "";
        let usage: any = null;
        for await (const event of stream) {
          // 纵深防御：记忆召回 side-call 检查 signal，防止 provider 层超时失效时挂死
          // H10：抛出携带 abort reason 的错误（mergeTimeoutSignal 超时段 reason="side-call-timeout"），
          // 与主路径 reason 白名单口径一致，不再裸 "Request aborted"。
          if (mergedSignal.aborted) {
            throw new Error(String((mergedSignal as any).reason ?? SIDE_CALL_TIMEOUT_REASON));
          }
          // B3：streamWithResilience 重试耗尽/无法降级时通过 yield {type:"error"} 通知失败
          // （而非直接 throw），改走漏斗后必须显式接住（见 goal/evaluator.ts 同类修复）。
          if (event.type === "error") {
            throw new Error(event.error.message);
          }
          if (event.type === "content_block_delta" && event.delta?.type === "text_delta") {
            t += event.delta.text;
          } else if (event.type === "message_stop" && (event as any).usage) {
            usage = (event as any).usage;
          }
        }
        return { text: t, streamUsage: usage };
      },
      signal,
    );
    // 记录辅助调用用量
    if (streamUsage) {
      recordSideCall({
        label: "memory-recall",
        model,
        inputTokens: streamUsage.inputTokens ?? 0,
        outputTokens: streamUsage.outputTokens ?? 0,
        cacheReadTokens: streamUsage.cacheReadInputTokens ?? 0,
        cacheCreationTokens: streamUsage.cacheCreationInputTokens ?? 0,
        durationMs: 0,
      });
    }
    return text;
  };
}
