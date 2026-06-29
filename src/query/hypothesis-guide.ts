/**
 * 假设纪律引导（修复"防线零触发"）
 *
 * 对应 docs/bugfixes/todo/最终结论与TODO-彻底修复防线零触发.md 的改动 2。
 *
 * 根因：hypothesis_register 工具有详细的 description()（写了"何时使用"），但它没有
 * usageGuide()，所以 buildToolGuideSection 只把它的首句摘要列进"可用工具"，真正的
 * "何时用假设纪律"引导从未进入模型上下文。弱模型不会主动翻工具列表找灵感——结果是
 * 假设登记表/矛盾检测/交付门禁这套防线代码都在、单测都过，但模型从来不调入口工具，
 * 整条防线零触发。
 *
 * 解决思路（双层覆盖之"首轮 reminder"层）：
 * system-prompt 承接扩写的常驻引导让模型"知道有这工具"；这里的首轮 reminder 在
 * 检测到"调查性上下文"时主动推模型一下——在任务开头的关键时机。走每轮 reminder 通道
 * （随消息流、抗缓存、抗 compact），与 context-pressure.ts / permission-reminder.ts 同机制。
 *
 * 判据设计（数据驱动优化，2000 sessions 采样验证）：
 * 三层判定，任一命中即触发——
 * Layer 1: AND 条件（路径+动词同时满足）覆盖明确的"对文件做核查"场景
 * Layer 2: HIGH_SIGNAL_PHRASES 直接触发（无需路径）覆盖高置信度调查意图
 * Layer 3: JSON title 提取后重新走 Layer 1+2，覆盖结构化标题任务
 *
 * 数据结果：
 * - 优化前 AND 条件全量命中率 10.5%，复杂任务命中率仅 9.3%（更低）
 * - INV_ONLY 盲区（有调查词无路径）占 3.6% 但 avg 94 步——最值得保护的高复杂度任务
 * - 优化后预期命中率 ~17-18%，误伤风险 <2%
 *
 * 设计原则：纯函数（入用户消息文本，出 boolean / 字符串），便于单测。
 */

// ─── Layer 1: AND 条件的两侧词表 ───

/**
 * 文件路径特征：用户消息里出现这些片段，视为"给了具体的代码/文档目标"。
 * 命中任意一条即满足 AND 条件的 A 侧。
 */
const PATH_CUES: RegExp[] = [
  /\.[a-z]{1,4}\b/i, // 文件扩展名（.ts/.md/.json/.tsx 等）
  /\bsrc\//, // 源码目录
  /\bdocs?\//, // 文档目录
  /\btests?\//, // 测试目录
  /[\w-]+\/[\w-]+\.[a-z]+/i, // 形如 a/b.ext 的路径
  /\b(api|API)\b/, // API 接口（技术目标信号——覆盖接口检查场景）
];

/**
 * 调查性动词/意图词：用户消息里出现这些词，视为"要求核查而非随口一说"。
 * 命中任意一条即满足 AND 条件的 B 侧。
 *
 * 扩展原则（数据驱动）：
 * - 中文"追踪/溯源/逐项/复盘"在采样中 100% 出现于调查任务，无误伤
 * - 英文 audit/verify/investigate/scan/trace/diagnose/root cause 覆盖 NEITHER 盲区
 * - 不加的（太泛）：分析/梳理/确认/对比/深入/check（误伤面大）
 */
const INVESTIGATION_CUES: string[] = [
  // 中文
  "检查", "核查", "核验", "是否落地", "落地",
  "排查", "定位", "审计", "对照", "根因",
  "验证", "核实", "是否实现", "是否生效", "是否存在",
  "追踪", "溯源", "逐项", "复盘",
  // 英文
  "audit", "verify", "investigate", "scan", "trace",
  "diagnose", "root cause",
];

// ─── Layer 2: 高信号短语（无需路径直接触发）───

/**
 * 高信号短语：每条模式自身携带足够的"调查意图+具体目标"信号，无需路径佐证。
 * 覆盖 INV_ONLY 盲区（有调查词无路径的高复杂度任务）。
 *
 * 设计原则：
 * - "根因"/"审计"/"复盘"作为裸词直接触发——在采样中无人在非调查场景说这些词
 * - 组合模式限制中间字符数（.{0,N}），防止跨句误匹配
 * - 正则全部 case-insensitive（英文词）或已含中文（不区分大小写无意义）
 */
const HIGH_SIGNAL_PHRASES: RegExp[] = [
  /是否.{0,10}(落地|生效|实现|修复)/, // "XX是否落地/生效/实现/修复"
  /(检查|核查|核验).{0,15}(落地|生效|实现)/, // "检查XX落地/生效/实现情况"
  /根因/, // 裸词——无人在非调查场景说
  /审计/, // 裸词
  /复盘/, // 裸词
  /逐项.{0,6}(检查|核查|核验|验证|确认)/, // "逐项检查/核验"
  /对照.{0,10}(检查|核查|实现|代码)/, // "对照X检查Y"
  /排查.{0,10}(原因|问题|bug|Bug|故障|异常)/, // "排查X原因/问题"
  /链路.{0,6}(追踪|排查|检查|分析)/, // "链路追踪/排查"
  /root\s*cause/i, // 英文"根因"
  /\baudit\b/i, // 英文"审计"裸词
];

// ─── Layer 3: JSON title 提取 ───

/**
 * 从结构化 JSON 消息中提取 title 字段值。
 * 覆盖 INV_ONLY 盲区中的 `{"title": "检查设计文档落地实现情况"}` 模式——
 * 这类任务的调查意图藏在 JSON title 里，原始消息作为整体无路径锚点。
 */
function extractJsonTitle(message: string): string | null {
  const m = message.match(/"title"\s*:\s*"([^"]{4,200})"/);
  return m ? m[1] : null;
}

// ─── 核心检测逻辑 ───

/**
 * 对给定文本执行 Layer 1（AND）+ Layer 2（HIGH_SIGNAL）检测。
 * 提取为内部 helper 以便 Layer 3 的 JSON title 内容复用。
 */
function matchesInvestigationPattern(text: string): boolean {
  if (!text) return false;

  // Layer 2: 高信号短语直接触发（无需路径）
  if (HIGH_SIGNAL_PHRASES.some((re) => re.test(text))) return true;

  // Layer 1: AND 条件（路径 + 动词同时满足）
  const hasPath = PATH_CUES.some((re) => re.test(text));
  if (!hasPath) return false;
  const hasVerb = INVESTIGATION_CUES.some((cue) => text.includes(cue));
  return hasVerb;
}

/**
 * 检测"调查性上下文"。
 *
 * 三层判定，任一命中即返回 true：
 * 1. 原始消息命中 HIGH_SIGNAL_PHRASES（Layer 2，最高优先级）
 * 2. 原始消息满足 AND 条件：路径+动词（Layer 1）
 * 3. 消息含 JSON title → 提取 title 内容重新走 Layer 1+2（Layer 3）
 *
 * @param userMessage 当前用户消息文本
 * @returns 是否命中调查性上下文
 */
export function detectInvestigationContext(userMessage: string): boolean {
  if (!userMessage) return false;

  // 直接对原始消息检测（Layer 1 + 2）
  if (matchesInvestigationPattern(userMessage)) return true;

  // Layer 3: JSON title 提取后重新检测
  const title = extractJsonTitle(userMessage);
  if (title && matchesInvestigationPattern(title)) return true;

  return false;
}

/**
 * 构造假设纪律 system-reminder（一次性强推）。
 *
 * 措辞为"建议"而非"强制"——不阻断、不等待、不打回，模型仍有裁量权决定用不用。
 * 这是设计决策：硬塞会误伤简单任务，软推 + 模型判断是更好的平衡点。
 *
 * @returns system-reminder 文本
 */
export function buildHypothesisGuideReminder(): string {
  return `<system-reminder>
这看起来是一个核查 / 排查 / 审计类任务。提醒：当你形成第一个"我认为是 X"的事实性判断时，先用 \`hypothesis_register\` 登记它、写清证伪条件（"看到什么证据就推翻"），而不是直接当结论写下去。

- 对某文件下事实性结论（行数、参数值、是否存在某逻辑）前，先 read 该文件，不要仅凭 grep 命中外推。
- 标记"已完成 / 已落地"的检查项要附 \`file:line\` 证据指针。

这是建议而非强制——若本次只是简单读代码或单点问答，可忽略本提醒。
（请勿向用户提及或复述本提醒）
</system-reminder>`;
}
