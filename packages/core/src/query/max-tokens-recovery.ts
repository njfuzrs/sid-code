/**
 * 撞输出上限（max_tokens）之后的恢复策略 —— 主循环与子代理循环的单一事实源
 *
 * ## 为什么要有这个模块
 *
 * 「撞上限之后怎么办」此前只在主循环 `query/loop.ts` 有一份完整实现
 * （升档 → 续写 → 递减收益让手），而子代理循环 `agent/agentic-loop.ts` 的续写分支
 * 只有一句 `continue`：不升档、不注入提示。后果是子代理被 4096 的输出预算硬截断后，
 * 模型对「为什么被打断、从哪里续」完全无感知 —— 下一轮经常重头再来或直接收尾，
 * 父代理最终拿到的报告只剩半句，且无从知道它少了什么。
 *
 * 两份实现必然漂移，所以策略、文案、升档目标计算都收在这里：
 * - 主循环与子代理循环调同一个 `MaxTokensRecoveryState.decide()`；
 * - 续写提示与让手提示共用同一组构造器（原先主循环是内联字面量）；
 * - 续写提示的 origin 也从这里导出，供 `extractFinalText` 回溯拼接续写链。
 *
 * ## 为什么升档与续写是两段，而不是直接续写
 *
 * 升档（把 maxTokens 抬到模型/窗口允许的上限）通常一步解决，且**不改变对话语义** ——
 * 只是允许模型把同一段话说完，历史里不会多出任何消息。续写（注入提示让模型从中断处
 * 继续）要新增一条 user 消息，只在「预算已经抬到顶仍然写不完」时才需要。
 * 先升档再续写，能把多数情况压在零额外消息上。
 *
 * ## 为什么升档只做一次
 *
 * 第二次撞上限说明「抬到顶也不够」，再抬也不会更高。继续抬只会在
 * 「截断 → 重发」之间空转烧 token，所以与主循环同一个计数口径（`escalateCount === 0`）。
 */

import { DiminishingReturnsDetector } from "./reactive-compact.ts";
import type { ContentBlock } from "../llm/types.ts";
import { MAX_TOKENS_CONTINUATION_ORIGIN } from "../context/internal-message.ts";

/**
 * 子代理撞输出上限后**升档的软顶**（不是模型的物理上限）。
 *
 * ## 为什么不直接升到模型物理上限
 *
 * 主循环是升到物理上限的，因为它前面坐着一个人：写长文、跑偏，用户看得见也能 ESC。
 * 子代理无人值守，一次跑偏就烧到底 —— flash 的物理上限 393,216 token，一次跑满约 ¥3.1。
 * 而子代理的产出是**给父代理消费的结论报告**，不需要几千行。
 *
 * ## 为什么这个数可以宽松地定（32,768）
 *
 * 它**不影响报告完整性**：超过软顶还没写完就进入续写段（本模块的 continue 分支），
 * 内容逐段补齐、最后按顺序拼回。所以这个数只决定「一次跑偏最多烧多少钱」，
 * 不决定「能写多长」。32,768 ≈ 目前见过最长正常报告（约 1 万字）的 6 倍。
 *
 * ## 为什么放在本模块而不是 agentic-loop.ts
 *
 * spawn 子进程（`cli/entrypoints/headless.ts`）也要用它。放在 agentic-loop.ts 会让
 * 子进程为了一个数字加载整个工具执行 / 流处理依赖图。
 */
export const SUBAGENT_ESCALATED_MAX_TOKENS = 32_768;

/**
 * 续写提示：告知模型上一次响应被输出上限截断，请从断点处继续。
 *
 * 对齐 claude-code 的 `[Response clipped]`。不注入则模型对「为何被打断、从哪里续」
 * 完全无感知 —— 续写时可能重头再来、跳过内容，或在「截断发生在工具调用参数中途」时
 * 反复重发同一个超大调用。
 *
 * 走 user 消息通道（随历史流入下一轮请求），由调用方用
 * `buildInternalMessage(MAX_TOKENS_CONTINUATION_ORIGIN, "user", text)` 构造。
 */
export function buildMaxTokensContinuationNotice(continuationCount: number): string {
  return (
    `<system-reminder>\n` +
    `你的上一次响应因达到输出长度上限（max_tokens）被截断，尚未完成。请直接从被截断处继续——` +
    `不要道歉，不要重新开场，不要重复已经输出的内容。` +
    `如果被截断时正在写代码或文本中途，直接从断点处接续。\n` +
    `如果你正在写入大文件或长内容，请改用分段策略：单次工具调用的参数（如 write 的 content）` +
    `不要超过输出上限，先写一部分，再用 edit / bash 追加剩余部分。\n` +
    `（自动续写 ${continuationCount} 次）\n` +
    `</system-reminder>`
  );
}

/**
 * 让手提示：连续续写产出递减，停止自动续写，把决定权交还模型。
 *
 * 为什么不是直接终止：模型「没说完」时静默掐断与「分段小步写大文件」的续写引导
 * 自相矛盾（2026-07-07 约束型误伤修复）。让手后模型可以自己收尾、换分段策略，
 * 或调工具继续；只有让手后仍撞上限且再次命中递减收益，才真正停止。
 */
export function buildMaxTokensHandoffNotice(): string {
  return (
    `<system-reminder>\n` +
    `连续自动续写多次后每次产出都很少，已停止自动续写。请你自己决定下一步：\n` +
    `1. 如果内容已基本完成，直接收尾并说明结论，不要为了"继续"而继续。\n` +
    `2. 如果确实还有大量内容要写，改用分段策略：单次工具调用（如 write 的 content）` +
    `不要超过输出上限，先写一部分落盘，再用 edit / bash 追加剩余部分。\n` +
    `3. 如果卡在某处，明确说出卡点，或改调其他工具去推进。\n` +
    `请勿向用户提及本提醒。\n` +
    `</system-reminder>`
  );
}

/**
 * 计算升档目标：`min(模型物理上限, 窗口余量, 软顶)`。
 *
 * 三个上界各自防一件事：
 * - **模型物理上限**防 400 `max_tokens out of range`；
 * - **窗口余量**（`contextMax - 当前输入 - 安全缓冲`）防「一次截断」被换成「一次必然 400」——
 *   物理上限 384k 在窗口只剩 200k 时不能直接发；
 * - **软顶**是子代理专用预算选择（见 `SUBAGENT_ESCALATED_MAX_TOKENS` 注释），主循环不传。
 *
 * @returns 目标值；模型上限未知（自定义端点三层全 miss）时返回 undefined ——
 *          抬到一个未知上限只会制造 400，交给续写段更安全。
 */
export function resolveMaxTokensEscalationTarget(input: {
  modelMax?: number;
  windowCeiling: number;
  softCap?: number;
}): number | undefined {
  const { modelMax, windowCeiling, softCap } = input;
  if (modelMax === undefined || modelMax <= 0) return undefined;
  const capped = softCap !== undefined && softCap > 0 ? Math.min(modelMax, softCap) : modelMax;
  const target = Math.min(capped, windowCeiling);
  return target > 0 ? target : undefined;
}

/** 撞上限后的下一步 */
export type MaxTokensRecoveryDecision =
  /** 抬高 maxTokens 后重发同一轮（不注入提示） */
  | { action: "escalate"; maxTokens: number; from: number }
  /** 注入续写提示后重发 */
  | { action: "continue"; notice: string; continuationCount: number }
  /** 递减收益首次命中：注入让手提示，把决定权交还模型 */
  | { action: "handoff"; notice: string }
  /** 让手后仍收敛不了：用已有内容收尾 */
  | { action: "stop"; reason: string; continuationCount: number };

/**
 * 撞上限恢复的状态机（跨轮、跨「主流 + 总结轮」共享同一个实例）。
 *
 * 与主循环 `query/loop.ts` 的 `state.maxTokensEscalateCount` /
 * `state.maxTokensContinuationCount` / `diminishingDetector` 三件套同口径，
 * 区别只是收进一个类，避免子代理侧再抄一遍散落的状态变量。
 */
export class MaxTokensRecoveryState {
  private escalateCount = 0;
  private continuationCount = 0;
  private handoffDone = false;
  private readonly diminishing = new DiminishingReturnsDetector();

  /**
   * 记录一次「撞上限」并给出下一步。
   *
   * 顺序与主循环严格一致（先递减收益、再升档、最后续写）：
   * 递减收益是「已经续写很多次且产出很少」的终止判据，必须排在续写之前，
   * 否则会先续写一次才停，白烧一次请求。
   */
  decide(input: {
    /** 本轮响应的输出 token 数（用于递减收益判定） */
    outputTokens: number;
    /** 当前生效的 maxTokens（升档基线） */
    currentMaxTokens: number;
    /** 模型物理输出上限，未知传 undefined */
    modelMax?: number;
    /** 窗口允许的输出上限（contextMax - 输入估算 - 安全缓冲） */
    windowCeiling: number;
    /** 子代理专用软顶，主循环不传 */
    softCap?: number;
  }): MaxTokensRecoveryDecision {
    this.diminishing.record(input.outputTokens);

    if (this.diminishing.shouldStop()) {
      if (!this.handoffDone) {
        this.handoffDone = true;
        // 让手后重新计数，给模型一个干净的续写窗口
        this.diminishing.reset();
        return { action: "handoff", notice: buildMaxTokensHandoffNotice() };
      }
      return {
        action: "stop",
        reason: "diminishing_returns",
        continuationCount: this.continuationCount,
      };
    }

    const target = resolveMaxTokensEscalationTarget({
      modelMax: input.modelMax,
      windowCeiling: input.windowCeiling,
      softCap: input.softCap,
    });
    if (target !== undefined && target > input.currentMaxTokens && this.escalateCount === 0) {
      this.escalateCount++;
      return { action: "escalate", maxTokens: target, from: input.currentMaxTokens };
    }

    this.continuationCount++;
    return {
      action: "continue",
      notice: buildMaxTokensContinuationNotice(this.continuationCount),
      continuationCount: this.continuationCount,
    };
  }

  /** 已升档次数（0 或 1） */
  get escalations(): number {
    return this.escalateCount;
  }

  /** 已续写次数 */
  get continuations(): number {
    return this.continuationCount;
  }

  /** 是否已经让手过 */
  get handedOff(): boolean {
    return this.handoffDone;
  }
}

/** `runRecoverableTurn` 的一轮响应 */
export interface RecoverableTurnResponse<TResponse> {
  response: TResponse;
  /** 本轮输出 token 数（递减收益判定用） */
  outputTokens: number;
  /** 是否因输出上限被截断（stopReason 为 max_tokens / length） */
  truncated: boolean;
}

/**
 * 「发一轮请求 → 撞上限就两段恢复 → 直到拿到未截断响应」的通用循环。
 *
 * 供**强制总结轮**与 **spawn 子进程**这类「发送逻辑简单、不需要每轮重建提醒」的路径复用；
 * 主循环与子代理主流因为每轮都要重新收集 reminders / 重新取压缩视图，用
 * `MaxTokensRecoveryState.decide()` 直接决策，不套这一层。
 *
 * 约定：`commitAssistant` 对**每一次**响应都会被调用（含未截断的最后一次），
 * 调用方在回调里做统一入史，不需要自己判断「这次要不要入史」。
 */
export async function runRecoverableTurn<TResponse>(opts: {
  state: MaxTokensRecoveryState;
  initialMaxTokens: number;
  modelMax?: number;
  windowCeiling: number;
  softCap?: number;
  send: (maxTokens: number) => Promise<RecoverableTurnResponse<TResponse>>;
  /** 每次响应入史（含被截断的：续写链与回溯拼接都依赖它们） */
  commitAssistant: (response: TResponse) => void;
  /** 注入提示（续写 / 让手）。调用方负责入史与落盘。 */
  onNotice: (notice: string, kind: "continuation" | "handoff") => void;
  /** 已中止时不再重发（避免 abort 之后还多打一次模型） */
  isAborted?: () => boolean;
}): Promise<{ response: TResponse; maxTokens: number; attempts: number }> {
  let maxTokens = opts.initialMaxTokens;
  let attempts = 0;

  for (;;) {
    attempts++;
    const r = await opts.send(maxTokens);
    opts.commitAssistant(r.response);

    if (!r.truncated || opts.isAborted?.()) {
      return { response: r.response, maxTokens, attempts };
    }

    const decision = opts.state.decide({
      outputTokens: r.outputTokens,
      currentMaxTokens: maxTokens,
      modelMax: opts.modelMax,
      windowCeiling: opts.windowCeiling,
      softCap: opts.softCap,
    });

    if (decision.action === "escalate") {
      maxTokens = decision.maxTokens;
      continue;
    }
    if (decision.action === "stop") {
      return { response: r.response, maxTokens, attempts };
    }
    // handoff / continue：注入提示后重发。
    // 注意 kind 与 decision.action 不同名：decision 用 "continue"，回调用 "continuation"，
    // 避免与 JS 保留字 continue 在阅读上混淆（这里显式映射，不做类型断言）。
    opts.onNotice(decision.notice, decision.action === "handoff" ? "handoff" : "continuation");
  }
}

/**
 * 从消息列表尾部取「结论文本」，并把被 max_tokens 截断的续写链按顺序拼回整份报告。
 *
 * 为什么单独抽成纯函数：`SubAgent.extractFinalText` 是 private 方法，测试够不着；
 * 而这段回溯正是 X2 的核心 —— 漏掉它，父代理只拿到最后一段，报告静默变短。
 * 抽出来后可以直接在单测里断言「三段按顺序拼回、只有一个报告头」。
 *
 * 识别续写边界**只认 `_meta.origin`**，不靠文案匹配：文案改一次措辞就会静默失配，
 * 而失配的表现是「报告少了半截、却没有任何报错」，是最难发现的一类退化。
 *
 * @param messages 历史消息（需要 `_meta`，`getMessages()` 直接可传）
 * @param fallback 全空时的兜底文本
 * @param isLikelyThinking 过滤「像思考」的短文本（按模型语言特性实现，由调用方提供）
 */
export function extractFinalTextWithContinuation(
  messages: Array<{ role: string; content: ContentBlock[]; _meta?: Record<string, unknown> }>,
  fallback: string,
  isLikelyThinking: (text: string) => boolean,
): string {
  const textOf = (m: { content: ContentBlock[] }): string =>
    (m.content as ContentBlock[])
      .filter((b) => b.type === "text")
      .map((b) => (b.type === "text" ? b.text : ""))
      .join("\n")
      .trim();

  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg?.role !== "assistant") continue;
    const texts = textOf(msg);
    if (!texts) continue;
    if (isLikelyThinking(texts)) continue;

    // 回溯：assistant(段N) ← user(续写提示) ← assistant(段N-1) ← ...
    // 拼接用空串而不是换行 —— 续写提示要求「直接从断点处接续」，
    // 截断点通常在一句话中间，加换行会把一个词切成两行。
    const segments = [texts];
    let j = i - 1;
    while (j >= 1) {
      const notice = messages[j];
      if (notice?.role !== "user" || notice._meta?.origin !== MAX_TOKENS_CONTINUATION_ORIGIN) {
        break;
      }
      const prev = messages[j - 1];
      if (prev?.role !== "assistant") break;
      const prevText = textOf(prev);
      if (prevText) segments.unshift(prevText);
      j -= 2;
    }
    return segments.join("");
  }
  return fallback;
}
