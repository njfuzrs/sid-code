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

import { getLogger } from "../debug/logger.ts";

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
  if (!userMessage) {
    // 空消息也记一笔——ds-max 漏触发排查时，若首轮取到空串会在这里留痕，
    // 便于区分"消息为空"和"消息有内容但三层判定都没命中"两种漏触发根因。
    logInvestigationMiss("EMPTY_MESSAGE", userMessage);
    return false;
  }

  // 直接对原始消息检测（Layer 1 + 2）
  if (matchesInvestigationPattern(userMessage)) return true;

  // Layer 3: JSON title 提取后重新检测
  const title = extractJsonTitle(userMessage);
  if (title && matchesInvestigationPattern(title)) return true;

  // 未命中：记录未命中原因，便于排查 detectInvestigationContext 漏触发
  // （评估报告 §8.7 的 P1——ds-max 会话 HypothesisGuideInjected=0 的盲区排查）。
  logInvestigationMiss(classifyInvestigationMiss(userMessage, title), userMessage);
  return false;
}

/**
 * 分类"未命中调查性上下文"的原因，便于离线排查漏触发。
 *
 * 三层判定全部落空后，用 diagnose 的四象限 + title 信息还原"差在哪一侧"：
 * - PATH_NOT_FOUND：有调查动词但没有路径锚点（AND 条件 A 侧缺失，且未命中高信号短语）
 * - INV_CUE_NOT_FOUND：有路径但没有调查动词（AND 条件 B 侧缺失）
 * - HIGH_SIGNAL_NOT_MATCHED：两侧都缺，连高信号短语也没命中（最常见的普通对话）
 * - JSON_TITLE_NO_MATCH：消息里有 JSON title，但 title 内容仍未命中三层判定
 */
function classifyInvestigationMiss(userMessage: string, title: string | null): string {
  const hasPath = PATH_CUES.some((re) => re.test(userMessage));
  const hasVerb = INVESTIGATION_CUES.some((cue) => userMessage.includes(cue));
  if (title) return "JSON_TITLE_NO_MATCH";
  if (hasVerb && !hasPath) return "PATH_NOT_FOUND";
  if (hasPath && !hasVerb) return "INV_CUE_NOT_FOUND";
  return "HIGH_SIGNAL_NOT_MATCHED";
}

/**
 * 未命中原因落 debug 日志。best-effort：仅在开启 --debug 时才有输出，
 * 绝不影响 detectInvestigationContext 的返回值（保持纯函数语义供单测）。
 * 只截取消息前 120 字符，避免超长用户输入灌爆 debug 日志。
 */
function logInvestigationMiss(reason: string, userMessage: string): void {
  try {
    const preview = (userMessage || "").slice(0, 120).replace(/\n/g, " ");
    getLogger().debug(
      "HYPOTHESIS_GUIDE",
      `detectInvestigationContext 未命中 [${reason}]: "${preview}"`,
    );
  } catch {
    /* 日志失败绝不阻断主流程 */
  }
}

/**
 * 诊断用：拆解检测结果到「四象限 + 命中层」。仅供离线验证脚本/复盘用，
 * 不在主循环热路径调用。导出此函数是为了让验证脚本复用同一份词表/正则，
 * 避免脚本自己复制词表导致与 detectInvestigationContext 漂移。
 *
 * @returns
 *   - hasPath / hasVerb：原始消息在 Layer 1 两侧的命中情况（用于四象限分类）
 *   - highSignal：原始消息是否命中 Layer 2 高信号短语
 *   - jsonTitleHit：是否经 Layer 3（JSON title）才命中
 *   - triggered：最终是否触发（= detectInvestigationContext 的返回值）
 *   - quadrant：基于原始消息 Layer 1 两侧的四象限（TRIGGER/PATH_ONLY/INV_ONLY/NEITHER）
 */
export function diagnoseInvestigationContext(userMessage: string): {
  hasPath: boolean;
  hasVerb: boolean;
  highSignal: boolean;
  jsonTitleHit: boolean;
  triggered: boolean;
  quadrant: "TRIGGER" | "PATH_ONLY" | "INV_ONLY" | "NEITHER";
} {
  const text = userMessage || "";
  const hasPath = PATH_CUES.some((re) => re.test(text));
  const hasVerb = INVESTIGATION_CUES.some((cue) => text.includes(cue));
  const highSignal = HIGH_SIGNAL_PHRASES.some((re) => re.test(text));
  const triggered = detectInvestigationContext(text);
  // Layer 3：原始消息未命中 Layer 1/2，但 JSON title 命中
  const jsonTitleHit = triggered && !matchesInvestigationPattern(text);

  let quadrant: "TRIGGER" | "PATH_ONLY" | "INV_ONLY" | "NEITHER";
  if (hasPath && hasVerb) quadrant = "TRIGGER";
  else if (hasPath) quadrant = "PATH_ONLY";
  else if (hasVerb) quadrant = "INV_ONLY";
  else quadrant = "NEITHER";

  return { hasPath, hasVerb, highSignal, jsonTitleHit, triggered, quadrant };
}

// ─────────────── 缺口3：事件驱动的注入时机（判断刚形成时，而非任务开头） ───────────────
//
// 原 `buildHypothesisGuideReminder`（turn-1 的完整引导）已删除，其内容一分为二：
//   - "该用这套机制"这一句 → buildMinimalGuideReminder（turn-1 兜底，极简）;
//   - "先 read 再下结论"/"附 file:line 证据指针"两条配套习惯 → buildJudgmentGuideReminder
//     （紧贴判断形成的时机，那里它们才用得上）。
// 删掉而非保留一个无人调用的导出：本文档 §五的成本纪律要求砍掉不产生新信息的步骤，
// 死代码留在这里只会让下一个读者以为 turn-1 还在投放完整引导。

/**
 * 缺口3：判断性表述的特征词。
 *
 * 根因（本文档 §2.4）：引导注入绑死在 `turnCount === 1`——**任务开头**。而模型在第 1 轮
 * 通常还没形成任何判断（它刚拿到任务、还没读代码），提示到达时无对应物可登记；等到第
 * 10-30 轮真正形成"我认为是 X 导致的"判断时，那条提示早已被几十轮工具输出冲远，且不在
 * 缓存友好的位置重复出现。
 *
 * 这些词的共同点是**对事实下断言**且带因果/结论语气。刻意不收"可能/也许/大概"这类
 * 不确定表述——那些正是健康的、不需要被提醒的说法。
 */
const JUDGMENT_CUES: RegExp[] = [
  // 中文因果/结论断言
  /根因(是|在于|为)/,
  /原因(是|在于|为)/,
  /问题(出在|在于|是)/,
  /(这|该|此)(就)?是(因为|由于)/,
  /导致(了)?(这|该|此)/,
  /(说明|意味着|证明)了?/,
  /(可以|基本)?(确认|确定)(了)?[，,：:]/,
  /结论(是|为)[：:]/,
  /(所以|因此|故)(可以)?(判断|认定|确认)/,
  // 英文
  /\broot cause is\b/i,
  /\bthe (reason|cause) is\b/i,
  /\bthis (is|means) (because|caused by)\b/i,
  /\bthis (proves|confirms|indicates)\b/i,
  /\bI (can )?confirm\b/i,
];

/**
 * 缺口3：判定模型的一段输出里是否**刚形成了一个未登记的事实性判断**。
 *
 * 判据刻意保守——只看"有没有下断言"，不做语义理解。误报的代价是多注入一次软提醒
 * （可忽略），漏报的代价是整条防线对这个判断失效，两者不对称，故宁可略宽。
 *
 * @param assistantText 本轮 assistant 的文本输出（含 thinking 摘要外的正文即可）
 */
export function detectUnregisteredJudgment(assistantText: string): boolean {
  const text = assistantText || "";
  // 太短的输出（如"好的"/"我来看看"）不可能承载判断，直接跳过，省正则开销。
  if (text.length < 40) return false;
  return JUDGMENT_CUES.some((re) => re.test(text));
}

/**
 * 缺口3：构造"刚形成判断"时的引导提醒（事件驱动版）。
 *
 * 与 `buildHypothesisGuideReminder`（任务开头的泛化引导）的区别在于**时机决定措辞**：
 * 这条是在模型刚写下一个断言之后立刻到达的，所以可以直接指着那个判断说话
 * （"你刚才那句结论"），而不必像开头版那样泛泛地讲"当你形成判断时"。
 * 时机对了，同样的话才有着力点——这正是本缺口要修的东西。
 *
 * 措辞同样是建议而非强制：判断可能本来就有充分证据（那就不必登记），
 * 也可能只是在复述用户给的既有事实。硬塞会误伤这两类正常情况。
 */
/**
 * 缺口3 修复项2：turn-1 兜底引导的**降级版**（极简 1-2 行）。
 *
 * 为什么保留 turn-1 通道却要降级：实测 13 次注入全在 turn=1，而首次 register 发生在
 * turn 2-12——完整引导在"模型还没形成任何判断"时到达，等它真形成判断时早被上下文冲淡。
 * 但完全删掉 turn-1 也不对：事件驱动判据只认"已经写出断言"，覆盖不到"一上来就知道
 * 该用这套机制"的情形。
 *
 * 折中是**把篇幅让给时机**：turn-1 只留一句"有这个工具、任务性质像是要用"，完整引导
 * （连同"为什么要登记""怎么写证伪条件"）交给紧贴判断的那一次注入。
 * 这也直接服务于文档 §五的成本纪律——同样的信息量，不在低效时机重复投放。
 */
export function buildMinimalGuideReminder(): string {
  return `<system-reminder>
提示（请勿向用户提及本提醒）：这像是核查 / 排查 / 审计类任务。当你形成第一个"我认为是 X"的事实性判断时，先用 \`hypothesis_register\` 登记它并写清证伪条件，再往下推进。若只是简单读代码或单点问答，忽略即可。
</system-reminder>`;
}

/**
 * 缺口3 修复项1 的第二个信号：从"查"转入"改"。
 *
 * 文档列的信号按可靠性排序，这是第二条：连续 read/grep 之后首次出现 edit/write，
 * 说明模型已经下了结论（不然不会动手改）。它覆盖判断性表述正则抓不到的情形——
 * 模型完全可以一句解释都不写就直接开始改代码，那时判断同样已经形成、同样未登记。
 *
 * @param toolNames 本轮的工具调用名
 * @param sawReadOnlyProbe 本会话此前是否有过 read/grep 类探查（由调用方累积）
 */
export function detectInvestigateToEditTransition(
  toolNames: readonly string[],
  sawReadOnlyProbe: boolean,
): boolean {
  if (!sawReadOnlyProbe) return false;
  return toolNames.some((n) => EDIT_TOOL_NAMES.has(n.toLowerCase()));
}

/** 只读探查类工具（"查"阶段的标志）。 */
const PROBE_TOOL_NAMES = new Set(["read", "grep", "glob", "ls"]);
/** 写入类工具（转入"改"阶段的标志）。 */
const EDIT_TOOL_NAMES = new Set(["edit", "write", "multi_edit", "notebook_edit", "apply_patch"]);

/** 本轮工具里是否含只读探查（供调用方累积 sawReadOnlyProbe）。 */
export function hasReadOnlyProbe(toolNames: readonly string[]): boolean {
  return toolNames.some((n) => PROBE_TOOL_NAMES.has(n.toLowerCase()));
}

export function buildJudgmentGuideReminder(): string {
  return `<system-reminder>
提示（请勿向用户提及本提醒）：你刚才的输出里出现了对事实下结论的表述（"根因是…"/"这说明…"/"可以确认…"这类）。

如果那是一个**你还没有实测验证过**的判断，现在是登记它的最好时机：用 \`hypothesis_register\` 写下这个判断 + 它的证伪条件（"看到什么证据就推翻它"）。登记之后，harness 会在后续每轮工具结果里自动帮你盯着反证，交付前也会拦一道；不登记的判断，这三道机制看不到，等于全靠你自己记得怀疑它。

两条配套习惯（原 turn-1 引导里的要点，挪到这个真正用得上的时机）：
- 对某文件下事实性结论（行数、参数值、是否存在某逻辑）前，先 read 该文件，不要仅凭 grep 命中外推。
- 标记"已完成 / 已落地"的检查项要附 \`file:line\` 证据指针。

这是建议而非强制。如果那个判断已有充分证据（读过代码/跑过测试/看过日志），或只是在复述用户已给的事实，忽略本提醒即可。
</system-reminder>`;
}
