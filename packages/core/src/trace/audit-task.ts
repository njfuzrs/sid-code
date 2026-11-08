/**
 * 「审计核查类任务」的分类判据 —— 防线触发率指标的分母口径。
 *
 * ## 为什么要有这个模块（X3-16，2026-11-08）
 *
 * 防线触发率（`northstar/README.md` 的「更安全」方向）分母**只能**是审计核查类会话：
 * 四环防线本就只该在这类高风险结论任务上触发，拿全部会话当分母会把信号稀释掉。
 *
 * 但分类逻辑原本只长在 `scripts/defense-trigger-rate.ts` 里，而**进 release 曲线**的
 * 是 `scripts/northstar-snapshot.ts` —— 它拿 `index.length`（全部会话）当分母，
 * 同时也拿它当 `n`，于是：
 * - 曲线量的是会话构成（某个周期多跑一批非审计会话，触发率就下降，而防线一行没改）；
 * - `n` 虚报，绕过 `MIN_SAMPLES_FOR_CONCLUSION` 的样本护栏。
 *
 * 修法不是"在 snapshot 里再实现一遍关键词匹配"（那就是两份分类各自漂移的老路），
 * 而是把判据收到这里：**写入侧**（`digest.ts` 的 `aggregateSessionMetrics`）算一次、
 * 落进 session-index 的 `is_audit`；**读取侧**（snapshot / defense-trigger-rate）
 * 都消费同一个字段、复用同一份判据。
 *
 * ## 判据为什么是关键词（而不是分类器）
 *
 * 这是**启发式代理量**，会有误分类。选它是因为：
 * 1. 代价对称 —— 它在指标上造成的偏差是"某类会话没被算进去"，而不是"防线坏了没发现"；
 * 2. 可解释 —— 每条会话为什么进/出分母，看首个 prompt 就能复核（`--list-audit`）；
 * 3. 反过来说，造一个"任务类型分类器中枢"才是这个仓库明确反对的方向
 *    （会得到一个自己定义、自己达标的数字）。
 *
 * 误分类的核查方法见 `scripts/defense-trigger-rate.ts --list-audit`：
 * 列出被判为审计类且零触发的会话，人工抽查首条 prompt 是否真属于审计核查。
 *
 * ## 只认**首个**用户 prompt
 *
 * 后续追问不改变任务性质（"继续"、"好，改吧"这类追问会把关键词判据冲淡）。
 * 调用方负责只把首个 `UserPromptSubmit.data.prompt` 传进来。
 */

/**
 * 审计核查类任务的关键词（命中即算）。
 *
 * 分两类处理：
 * - **全小写且含 ASCII 字母**的（`audit` / `verify` / `check whether` …）按
 *   `prompt.toLowerCase()` 比较 —— 用户可能写 `Audit` / `Verify`；
 * - 其余（中文短语）按原文比较 —— 中文没有大小写，转小写是空操作但会丢掉
 *   「原文里就是这么写的」这个最直观的证据。
 *
 * ⚠️ 加关键词前先想清楚代价：这里是**分母口径**，加宽会让更多会话进分母、
 * 触发率下降（看起来像退步）；收窄则相反（看起来像进步）。两边都不是免费的方向。
 */
export const AUDIT_KEYWORDS = [
  "检查",
  "核查",
  "审计",
  "是否落地",
  "落地实现",
  "是否实现",
  "对照",
  "对比检查",
  "排查",
  "根因",
  "缺口",
  "验收",
  "复核",
  "核实",
  "有没有落地",
  "是否存在",
  "audit",
  "verify",
  "review",
  "check whether",
  "double check",
  "double-check",
] as const;

/** 该关键词是否按小写比较（英文词按小写、中文按原文）。 */
function isCaseInsensitiveKeyword(kw: string): boolean {
  return kw === kw.toLowerCase() && /[a-z]/.test(kw);
}

/**
 * 首个用户 prompt 是否属于「审计核查类任务」。
 *
 * 空串 / 纯空白 → `false`（没有判据，不能把"不知道"算成"是"）。
 */
export function isAuditTaskPrompt(prompt: string): boolean {
  if (!prompt.trim()) return false;
  const lower = prompt.toLowerCase();
  return AUDIT_KEYWORDS.some((kw) =>
    isCaseInsensitiveKeyword(kw) ? lower.includes(kw) : prompt.includes(kw),
  );
}
