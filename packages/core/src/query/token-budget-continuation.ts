/**
 * Token Budget 续写机制（P0-3，对齐 claude-code "+500k" 预算续写设计）
 *
 * 背景：CC 允许用户用 "+500k" 这类指令给一次任务设定 token 预算——模型 end_turn 但预算
 * 未花完时，系统自动注入续写提示让模型继续深入；预算花完或产出出现递减收益（连续两轮
 * 输出量都很小）才真正收尾。这与 sid-code 已有的 `/goal` tokenBudget（超限即收尾的上限
 * 保护）方向相反，也不依赖 `/goal`——普通对话里带上 "+500k" 指令即可触发，与 `/goal`
 * 互斥（`/goal` 激活时由它自己的预算/评估逻辑接管，见 src/query/goal-gate.ts）。
 *
 * 递减收益判定复用 DiminishingReturnsDetector（reactive-compact.ts），只是把续写次数上限
 * 调宽（真正的上限是预算耗尽，不是次数）。
 */

/** 指令中的数量单位后缀 → 倍数 */
const UNIT_MULTIPLIER: Record<string, number> = { k: 1_000, m: 1_000_000 };

/** 预算下限：过小起不到"续写"的实际作用 */
export const MIN_TOKEN_BUDGET = 10_000;
/** 预算上限：超出这个量级现实意义不大，clamp 防止误配置/超大数字失控 */
export const MAX_TOKEN_BUDGET = 20_000_000;

/**
 * 解析用户消息中的 Token Budget 指令，如 "+500k" / "+2m" / "+1.5m"。
 *
 * 强制要求 k/m 单位后缀——这是避免误判的关键：电话号码（+8613800001234）、算式（+5）、
 * 版本号等场景里的裸数字都没有 k/m 后缀，天然不会命中；只有"+数字+k或m"这种刻意的
 * 预算量级表达式才会匹配。取文本中第一个匹配；解析结果 clamp 到
 * [MIN_TOKEN_BUDGET, MAX_TOKEN_BUDGET]。
 */
export function parseTokenBudgetDirective(text: string): number | undefined {
  const match = text.match(/\+(\d+(?:\.\d+)?)\s*([kKmM])\b/);
  if (!match) return undefined;
  const value = parseFloat(match[1]);
  if (!Number.isFinite(value) || value <= 0) return undefined;
  const multiplier = UNIT_MULTIPLIER[match[2].toLowerCase()];
  const budget = Math.round(value * multiplier);
  return Math.min(MAX_TOKEN_BUDGET, Math.max(MIN_TOKEN_BUDGET, budget));
}

/**
 * P2-4：预算口径的**单一事实源**——「已消耗多少 token」怎么算，只有这一处。
 *
 * queryLoop 里有两个调用点（入口记基线、Gate 里算 consumed），此前各写一遍同样的加法。
 * 两处加法必须逐字一致才有意义：差一项就不是"少算了一点"，而是差值直接失真
 * （基线含某项、消耗不含 → consumed 恒偏小甚至为负；反之预算瞬间见底）。
 *
 * 口径 = 累计 prompt（flow）+ output + cacheCreation，**刻意不含 cacheRead**：
 *   - 这是"钱"的口径，不是"上下文有多大"的口径。cacheRead 的单价只有正常 input 的
 *     约 1/10，把它按全价计进预算会让长会话虚耗——预算是给"继续深入"用的额度，
 *     缓存命中越多本该越划算，不该反过来惩罚。
 *   - inputTokens 走的是 `getTotalUsage()` 的 flow 累计口径（各模型
 *     cumulativePromptTokens 之和），与 totalCostUSD 同源可比；**不是**末次快照（stock）。
 *     用 stock 除/减 flow 是「stock 与 flow 混用」那类错数。
 *
 * ⚠️ 代价要点破：不含 cacheRead 意味着在"大上下文 + 高命中"的长工具链里，账面
 * consumed 明显低于真实喂进去的 token 总量。这是**刻意选择**（按成本而非按体积计价），
 * 不是漏项——改它之前先想清楚要计价的是钱还是体积，并同步这段注释。
 */
export function tokenBudgetConsumed(usage: {
  inputTokens?: number;
  outputTokens?: number;
  cacheCreationInputTokens?: number;
}): number {
  return (
    (usage.inputTokens ?? 0) + (usage.outputTokens ?? 0) + (usage.cacheCreationInputTokens ?? 0)
  );
}

/** 构建预算续写提示：引导模型充分利用剩余预算继续深入，而非当作用户在追问 */
export function buildBudgetContinuationMessage(consumed: number, remaining: number): string {
  return `<system-reminder>
[预算续写] 当前任务设定了 token 预算，已用约 ${consumed.toLocaleString()} tokens，预计还剩约 ${remaining.toLocaleString()} tokens。
如果你认为当前工作已经完整、没有更多有价值的内容可以补充，可以直接结束；
否则请继续深入完善（比如：补充测试、检查边界情况、完善文档、复核实现细节），充分利用剩余预算。
请勿向用户提及本提醒。
</system-reminder>`;
}

/** 预算已耗尽，正常收尾时展示给用户的简短提示（非阻断） */
export function buildBudgetExhaustedNotice(target: number): string {
  return `预算续写已用完（约 ${target.toLocaleString()} tokens），正常收尾`;
}

/** 产出已现递减收益，提前收尾时展示给用户的简短提示（非阻断） */
export function buildBudgetDiminishingNotice(remaining: number): string {
  return `产出已现递减收益，提前收尾（预算还剩约 ${remaining.toLocaleString()} tokens 未使用）`;
}
