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
 * 触发判据用 AND（路径特征 + 调查性动词同时满足），宁漏勿误伤：
 * 误伤简单任务的体验损害（变慢）大于偶尔漏过一个该触发的任务（最坏少一层校验，
 * 模型自身能力仍在）。已知盲区：无路径锚点的纯自然语言核查任务不会命中，由 system-prompt
 * 常驻引导兜底，详见方案 Q2。
 *
 * 设计原则：纯函数（入用户消息文本，出 boolean / 字符串），便于单测。
 */

/**
 * 文件路径特征：用户消息里出现这些片段，视为"给了具体的代码/文档目标"。
 * 命中任意一条即满足第一个条件。
 */
const PATH_CUES: RegExp[] = [
  /\.[a-z]{1,4}\b/i, // 文件扩展名（.ts/.md/.json/.tsx 等）
  /\bsrc\//, // 源码目录
  /\bdocs?\//, // 文档目录
  /\btests?\//, // 测试目录
  /[\w-]+\/[\w-]+\.[a-z]+/i, // 形如 a/b.ext 的路径
];

/**
 * 调查性动词/意图词：用户消息里出现这些词，视为"要求核查而非随口一说"。
 * 命中任意一条即满足第二个条件。
 */
const INVESTIGATION_CUES: string[] = [
  "检查",
  "核查",
  "核验",
  "是否落地",
  "落地",
  "排查",
  "定位",
  "审计",
  "对照",
  "根因",
  "验证",
  "核实",
  "是否实现",
  "是否生效",
  "是否存在",
];

/**
 * 检测"调查性上下文"——AND 条件：文件路径特征 + 调查性动词同时满足才返回 true。
 *
 * 为什么用 AND（见方案 Q2）：
 * - 单独给路径（"帮我看 src/app.ts"）→ 不触发（可能只是想读代码）
 * - 单独说动词（"检查一下有没有 bug"）→ 不触发（没给具体目标，可能随口）
 * - 路径 + 动词同时出现（"检查 docs/方案.md 在代码里是否落地"）→ 触发
 *
 * @param userMessage 当前用户消息文本
 * @returns 是否命中调查性上下文
 */
export function detectInvestigationContext(userMessage: string): boolean {
  if (!userMessage) return false;
  const hasPath = PATH_CUES.some((re) => re.test(userMessage));
  if (!hasPath) return false;
  const hasVerb = INVESTIGATION_CUES.some((cue) => userMessage.includes(cue));
  return hasVerb;
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
