/**
 * 压缩后统一收尾（auto / manual 共用）
 *
 * §12 P2-4 复审：此收尾此前只内联在 query/auto-compact.ts 里，手动 `/compact` 完全走不到——
 * 手动压缩后不做文件重注入、不重置 microcompact 状态机、不抑制 cache break 误报、
 * 不记录压缩质量与自适应特征。结果是同一个"压缩"动作在两条路径上语义不一致：
 * 用户手动压缩后模型会"忘掉"刚读过的文件，而自动压缩不会。
 *
 * 现抽成单一事实源，两条路径都调它，只用 trigger 区分 hook 事件类型与日志措辞。
 * 全部步骤 best-effort：任何一步异常都不影响已完成的压缩结果。
 */

import type { Message } from "../../llm/types.ts";
import type { Manager as ContextManager } from "../../context/manager.ts";
import type { HookSystem } from "../../hook/system.ts";
import { getLogger } from "../../debug/index.ts";

/** 压缩触发来源：auto=自动阈值触发，manual=用户 /compact */
export type CompactTrigger = "auto" | "manual";

export interface PostCompactOptions {
  /** 触发来源（决定 PostCompact hook 的 trigger 字段与日志措辞） */
  trigger: CompactTrigger;
  ctxMgr: ContextManager;
  /** 未提供时跳过 PostCompact hook（其余收尾照常执行） */
  hookSystem?: HookSystem;
  /** §2.1 文件重注入依赖；未提供则跳过 */
  fileReadTracker?: import("../../tool/file-read-tracker.ts").FileReadTracker;
  /** §5 microcompact 状态机；未提供则跳过重置 */
  cachedMicrocompactState?: import("./cached-microcompact.ts").CachedMicrocompactState;
  /** §4.1 质量报告落盘目录；未提供则只算覆盖率不落盘 */
  sessionDir?: string;
  /** 压缩前的原始消息（算摘要覆盖率用） */
  originalMessages: Message[];
  /** 生成的摘要正文 */
  summary: string;
  /** 压缩前消息条数 */
  messagesBefore: number;
  /** 压缩前 token 估算 */
  tokensBefore: number;
  /** 是否走了 LLM 摘要（false = 本地截断降级），供自适应策略区分样本 */
  usedLLM: boolean;
}

/**
 * 执行压缩后收尾：
 * 1. §2.1 文件恢复——把最近访问过的文件重注入（压缩已腾出空间，这里守 50K 预算）
 * 2. §5   重置 cached microcompact 状态机（消息历史已重组，旧 tool_use_id 映射全失效）
 * 3. G1   抑制一次 cache break 检测（前缀变了，cache_read 骤降是预期的）
 * 4. §4.1 摘要质量校验（覆盖率）
 * 5. §4.2 记录压缩特征供后续自适应
 * 6. §3.2 PostCompact hook
 */
export async function runPostCompact(opts: PostCompactOptions): Promise<void> {
  const log = getLogger();
  const { trigger, ctxMgr } = opts;

  // 1. §2.1：恢复最近访问文件
  if (opts.fileReadTracker) {
    try {
      const { buildReattachFileMessages } = await import("./reattach-files.ts");
      const fileMsgs = buildReattachFileMessages(opts.fileReadTracker);
      if (fileMsgs.length > 0) {
        ctxMgr.appendReattachMessages(fileMsgs);
        log.info("COMPACT", `Post-compact(${trigger}) 文件恢复注入 ${fileMsgs.length} 条消息`);
      }
    } catch (err: any) {
      log.debug("COMPACT", `Post-compact(${trigger}) 文件恢复跳过: ${err?.message ?? err}`);
    }
  }

  // 2. §5：压缩重组了消息历史，microcompact 的"已删除 tool_use_id"映射全部失效
  if (opts.cachedMicrocompactState) {
    try {
      const { resetCachedMicrocompactState } = await import("./cached-microcompact.ts");
      resetCachedMicrocompactState(opts.cachedMicrocompactState);
      log.debug("COMPACT", "已重置 cached microcompact 状态机");
    } catch { /* 忽略 */ }
  }

  // 3. G1：抑制紧接的一次 cache break 检测，避免误报淹没真实告警
  try {
    const { notifyCompaction } = await import("../../api/cache-detection.ts");
    notifyCompaction("main");
  } catch { /* 忽略 */ }

  // 4. §4.1：质量校验（覆盖率）
  let coverage = 1;
  try {
    const { recordCompactQuality } = await import("./quality-check.ts");
    coverage = recordCompactQuality(opts.originalMessages, opts.summary, opts.sessionDir).coverage;
  } catch { /* 忽略 */ }

  const tokensAfter = ctxMgr.estimateTokens();
  const messagesAfter = ctxMgr.messageCount();
  const tokensBefore = opts.tokensBefore;
  const savedRatio = tokensBefore > 0 ? Math.max(0, (tokensBefore - tokensAfter) / tokensBefore) : 0;

  // 5. §4.2：记录压缩特征供后续自适应
  try {
    const { recordCompactFeature } = await import("./adaptive-strategy.ts");
    recordCompactFeature({ tokensBefore, tokensAfter, savedRatio, usedLLM: opts.usedLLM, coverage });
  } catch { /* 忽略 */ }

  // 6. §3.2：PostCompact hook
  try {
    await opts.hookSystem?.firePostCompactEvent(
      trigger,
      opts.messagesBefore,
      messagesAfter,
      Math.max(0, tokensBefore - tokensAfter),
    );
  } catch (err: any) {
    log.debug("HOOK", `PostCompact hook 执行异常（不影响压缩）: ${err?.message ?? err}`);
  }
}
