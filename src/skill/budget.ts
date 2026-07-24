/**
 * Skill 摘要预算控制（Task 2：两层索引发现机制）
 *
 * 对齐 Claude Code：system prompt 中只放 Skill 摘要列表（约占 1% 上下文窗口），
 * 模型通过唯一的 skill 工具按名称调用，而不是每个 Skill 注册一个独立工具。
 *
 * 预算分配策略：
 *   1. 若全部完整描述能放进预算 → 全部展示完整描述
 *   2. 否则 bundled Skill 享有特权（完整描述不被截断），
 *      剩余预算按非 bundled 数量均分，每条至多 MAX_LISTING_DESC_CHARS
 *   3. 若均分后每条不足 MIN_DESC_LENGTH → 非 bundled 只显示名称
 */

/** Skill 摘要预算占上下文窗口的比例（1%） */
export const SKILL_BUDGET_CONTEXT_PERCENT = 0.01;
/** 每 token 约 4 字符 */
const CHARS_PER_TOKEN = 4;

/**
 * 估算单个 Skill 注入 system prompt 的大致 token 数（供 /skills 面板展示，对齐 cc 的 `~N tok`）。
 *
 * 口径与真实注入一致：每个 Skill 在 system prompt 里占一行
 * `- {name}: {whenToUse||description}`（见 formatCommandsWithinBudget 的 fullLine），
 * 按该行字符数 ÷ CHARS_PER_TOKEN 估算。不是精确 tokenizer，只作数量级参考。
 */
export function estimateSkillListingTokens(entry: SkillListingEntry): number {
  const desc = (entry.whenToUse || entry.description || "").trim();
  const line = `- ${entry.name}: ${desc}`;
  return Math.ceil(line.length / CHARS_PER_TOKEN);
}
/** 默认字符预算（200k 窗口 × 4 × 1%） */
export const DEFAULT_CHAR_BUDGET = 8_000;
/** 每条描述字符上限 */
const MAX_LISTING_DESC_CHARS = 250;
/** 最短描述长度（低于此值则只显示名称） */
const MIN_DESC_LENGTH = 30;

/** 参与摘要列表的 Skill 条目（最小依赖，便于独立测试） */
export interface SkillListingEntry {
  name: string;
  description: string;
  whenToUse?: string;
  /** 是否为 bundled（编译时内置）—— bundled 享有不被截断的特权 */
  isBundled?: boolean;
}

/** 计算字符预算 */
export function computeCharBudget(contextWindowTokens?: number): number {
  if (!contextWindowTokens || contextWindowTokens <= 0) {
    return DEFAULT_CHAR_BUDGET;
  }
  return Math.floor(
    contextWindowTokens * CHARS_PER_TOKEN * SKILL_BUDGET_CONTEXT_PERCENT,
  );
}

/**
 * 在预算内格式化 Skill 摘要列表
 * @returns 形如 `- name: desc` 的多行字符串
 */
export function formatCommandsWithinBudget(
  commands: SkillListingEntry[],
  contextWindowTokens?: number,
): string {
  if (commands.length === 0) return "";

  const budget = computeCharBudget(contextWindowTokens);

  const truncate = (s: string, max: number) =>
    s.length > max ? s.slice(0, max) : s;

  const descOf = (cmd: SkillListingEntry) =>
    truncate((cmd.whenToUse || cmd.description || "").trim(), MAX_LISTING_DESC_CHARS);

  const fullLine = (cmd: SkillListingEntry) => `- ${cmd.name}: ${descOf(cmd)}`;
  const nameLine = (cmd: SkillListingEntry) => `- ${cmd.name}`;

  // 1. 尝试全部完整描述
  const fullTotal = commands.reduce(
    (sum, c) => sum + fullLine(c).length + 1, // +1 换行
    0,
  );
  if (fullTotal <= budget) {
    return commands.map(fullLine).join("\n");
  }

  // 2. bundled 保留完整，计算剩余预算
  const bundled = commands.filter((c) => c.isBundled);
  const rest = commands.filter((c) => !c.isBundled);

  const bundledChars = bundled.reduce(
    (sum, c) => sum + fullLine(c).length + 1,
    0,
  );
  const remainingBudget = budget - bundledChars;

  // 没有非 bundled，或预算已被 bundled 占满 → 只输出 bundled 完整描述
  if (rest.length === 0 || remainingBudget <= 0) {
    return commands.map((c) => (c.isBundled ? fullLine(c) : nameLine(c))).join("\n");
  }

  // 3. 非 bundled 的每条描述预算
  const maxDescLen = Math.floor(remainingBudget / rest.length);
  if (maxDescLen < MIN_DESC_LENGTH) {
    // 预算太紧：非 bundled 只显示名称
    return commands
      .map((c) => (c.isBundled ? fullLine(c) : nameLine(c)))
      .join("\n");
  }

  // 4. 截断非 bundled 描述
  return commands
    .map((c) => {
      if (c.isBundled) return fullLine(c);
      const desc = truncate((c.whenToUse || c.description || "").trim(), maxDescLen);
      return `- ${c.name}: ${desc}`;
    })
    .join("\n");
}

/**
 * 生成 Skill 摘要列表的 system-reminder 文本
 * @returns 注入 system prompt 的内容；无 Skill 时返回 null
 */
export function generateSkillListing(
  commands: SkillListingEntry[],
  contextWindowTokens?: number,
): string | null {
  if (commands.length === 0) return null;
  const listing = formatCommandsWithinBudget(commands, contextWindowTokens);
  if (!listing) return null;
  return `<system-reminder>
以下 Skills 可通过 skill 工具调用（按名称指定 skill 参数即可）：

${listing}
</system-reminder>`;
}
