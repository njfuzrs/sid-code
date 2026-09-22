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

/**
 * 压缩触发来源。
 *
 * P1-13/14：此前只有 auto / manual 两种，因为收尾被绑在 `autoCompact` 这个**函数**上。
 * 实际还有两条路径真的压了上下文却拿不到收尾：`reactiveCompact`（prompt-too-long 恢复）
 * 与 `contextCollapse`（分段摘要）。收尾应该绑在「压缩真的发生了」这个**事件**上。
 *
 * hook 契约只认 manual / auto（`firePostCompactEvent`），所以非 manual 的一律以 auto 上报，
 * 只在日志里区分——不改 hook 的对外 schema。
 */
export type CompactTrigger = "auto" | "manual" | "reactive" | "collapse";

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
  /**
   * 压缩前的原始消息（算摘要覆盖率用）。
   * P1-13/14：与 `summary` 成对，缺任一则跳过质量校验（见 `summary` 注释）。
   */
  originalMessages?: Message[];
  /**
   * 生成的摘要正文。
   *
   * P1-13/14：reactive / collapse 路径**没有**「一段原文 → 一份摘要」这种可比对的配对
   * （snip 产出的是裁剪清单，collapse 产出的是多段分段摘要且切分范围不回传），
   * 所以这两条路径不传它，质量校验与自适应特征记录一并跳过。
   *
   * 刻意不传空串糊过去：`checkCompactQuality("")` 会算出覆盖率 0，把「没有可测的摘要」
   * 伪装成「摘要质量塌陷」，污染 compact-quality.jsonl 与 recommendParams 的均值——
   * 这正是 P1-12 那类「分母错了，阈值再对也是假数」。
   */
  summary?: string;
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
    } catch {
      /* 忽略 */
    }
  }

  // 3. G1：抑制紧接的一次 cache break 检测，避免误报淹没真实告警
  try {
    const { notifyCompaction } = await import("../../api/cache-detection.ts");
    notifyCompaction("main");
  } catch {
    /* 忽略 */
  }

  // 3.5 内容级 tracing（缺陷清单 P1-5 设计点 4）：压缩把历史消息换成了摘要，
  // 此前「已发过全文」的内容 hash 与压缩后的上下文再无对应关系。不清的话，压缩后
  // 重建的 system prompt 若与旧值同 hash，全文就永远不会再发一次，span 上只剩一个
  // 指向已失效事件的 hash——排查时看到 hash 却找不到内容，比没有内容更费时间。
  //
  // 放在 runPostCompact 而非 auto-compact 的三个出口：这里是 auto 与手动 /compact
  // **共同**的收尾单一事实源（第 2 步重置 microcompact 映射同理）。挂在三个出口上
  // 会漏掉手动路径，而「只有手动压缩之后 hash 不失效」这种缺陷极难被想到去查。
  try {
    const { clearContentTracingState } = await import("../../telemetry/content-tracing.ts");
    clearContentTracingState();
  } catch {
    /* 忽略 */
  }

  // 4. §4.1：质量校验（覆盖率）。
  // P1-13/14：只有拿到「进了摘要的那段原文 + 对应摘要」这对配对时才测。
  // 缺配对时不测也不记（见 opts.summary 注释：伪造一个 0 比没有数更误导）。
  const measurable = opts.originalMessages !== undefined && opts.summary !== undefined;
  let coverage: number | undefined;
  if (measurable) {
    try {
      const { recordCompactQuality } = await import("./quality-check.ts");
      coverage = recordCompactQuality(
        opts.originalMessages!,
        opts.summary!,
        opts.sessionDir,
      ).coverage;
    } catch {
      /* 忽略 */
    }
  }

  const tokensAfter = ctxMgr.estimateTokens();
  const messagesAfter = ctxMgr.messageCount();
  const tokensBefore = opts.tokensBefore;
  const savedRatio =
    tokensBefore > 0 ? Math.max(0, (tokensBefore - tokensAfter) / tokensBefore) : 0;

  // 5. §4.2：记录压缩特征供后续自适应。
  // coverage 是 recommendParams 的输入（均值 <0.5 会抬 preserveRecent），所以没测到覆盖率的
  // 样本一律不入库——补一个假的 1 会把均值抬高，正好抵消真实的低覆盖率告警。
  if (coverage !== undefined) {
    try {
      const { recordCompactFeature } = await import("./adaptive-strategy.ts");
      recordCompactFeature({
        tokensBefore,
        tokensAfter,
        savedRatio,
        usedLLM: opts.usedLLM,
        coverage,
      });
    } catch {
      /* 忽略 */
    }
  }

  // 6. §3.2：PostCompact hook
  try {
    await opts.hookSystem?.firePostCompactEvent(
      // hook 对外只有 manual / auto 两个值（PostCompactInput.trigger）。
      // reactive / collapse 归到 auto：它们同样是「系统自己决定压的」，
      // 而给 hook 加新枚举值是对外 schema 变更，不该由这条缺陷修复顺手带出去。
      trigger === "manual" ? "manual" : "auto",
      opts.messagesBefore,
      messagesAfter,
      Math.max(0, tokensBefore - tokensAfter),
    );
  } catch (err: any) {
    log.debug("HOOK", `PostCompact hook 执行异常（不影响压缩）: ${err?.message ?? err}`);
  }
}
