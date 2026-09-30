/**
 * Skill 摘要预算控制（Task 2：两层索引发现机制）
 *
 * 对齐 Claude Code：system prompt 中只放 Skill 摘要列表（约占 1% 上下文窗口），
 * 模型通过唯一的 skill 工具按名称调用，而不是每个 Skill 注册一个独立工具。
 *
 * 预算分配策略：
 *   1. 若全部完整描述能放进预算 → 全部展示完整描述
 *   2. 否则 bundled Skill 享有特权（完整描述不被截断），但特权合计封顶在预算的
 *      BUNDLED_BUDGET_SHARE 以内；剩余预算按普通条目**整行**均分，每条描述至多 MAX_LISTING_DESC_CHARS
 *   3. 若均分后每条描述不足 MIN_DESC_LENGTH → 普通条目只显示名称
 */

import { emitSkillDegradation } from "./telemetry.ts";

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
 *
 * 审计第 15 条：原审计文档称"仅被测试引用"，实测该判断有误——本函数被
 * `src/ui/components/SkillsDialog.tsx` 的 /skills 面板用于展示每个 skill 的 token
 * 占用（2 处生产调用）。非死代码，勿删。
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
  /**
   * 是否为 bundled（编译时内置、只活在二进制里）—— 享有封顶内不被截断的特权。
   * ⚠️ 磁盘上有完整 SKILL.md 的 builtin skill **不算**：降级后模型可自己 Read 自救（P1-1）。
   */
  isBundled?: boolean;
}

/** 计算字符预算 */
export function computeCharBudget(contextWindowTokens?: number): number {
  if (!contextWindowTokens || contextWindowTokens <= 0) {
    return DEFAULT_CHAR_BUDGET;
  }
  return Math.floor(contextWindowTokens * CHARS_PER_TOKEN * SKILL_BUDGET_CONTEXT_PERCENT);
}

/**
 * 特权条目（isBundled）合计最多占预算的比例（P1-1）。
 *
 * 为什么要封顶：此前 bundled 特权**没有上限**——bundled 自己吃穿预算时仍全量输出完整描述，
 * 实测 2000 token 窗口下输出 2539 字符而预算只有 80（超 31 倍）。特权的理由是「降级成名字后
 * 模型无法自救」，它只能保护**预算内**的那部分；超出封顶的特权条目与普通条目一起参与均分降级。
 */
const BUNDLED_BUDGET_SHARE = 0.5;

/**
 * 在预算内格式化 Skill 摘要列表
 *
 * 预算核算口径（P1-1）：一律按**整行**（`- name: desc` + 换行）计，不是只算 desc。
 * 此前均分出来的是「描述上限」，拼行时又加上 `- name: ` 前缀，于是每行都超出
 * 4 + name.length 字符——预算的定义是上界，按描述算等于拿描述上界冒充行上界。
 *
 * 唯一不保证 ≤ 预算的情形是「全部降成只剩名字仍放不下」：名字是可调用的最低信息量，
 * 再往下只能丢条目，那会让模型连存在都不知道，比超预算更糟。
 *
 * @returns 形如 `- name: desc` 的多行字符串
 */
export function formatCommandsWithinBudget(
  commands: SkillListingEntry[],
  contextWindowTokens?: number,
): string {
  if (commands.length === 0) return "";

  const budget = computeCharBudget(contextWindowTokens);

  const truncate = (s: string, max: number) => (s.length > max ? s.slice(0, max) : s);
  const rawDesc = (cmd: SkillListingEntry) => (cmd.whenToUse || cmd.description || "").trim();
  const descOf = (cmd: SkillListingEntry) => truncate(rawDesc(cmd), MAX_LISTING_DESC_CHARS);

  const prefixOf = (cmd: SkillListingEntry) => `- ${cmd.name}: `;
  const fullLine = (cmd: SkillListingEntry) => `${prefixOf(cmd)}${descOf(cmd)}`;
  const nameLine = (cmd: SkillListingEntry) => `- ${cmd.name}`;
  /** 行成本 = 行长 + 换行 */
  const cost = (line: string) => line.length + 1;

  // 1. 尝试全部完整描述
  const fullTotal = commands.reduce((sum, c) => sum + cost(fullLine(c)), 0);
  if (fullTotal <= budget) {
    return commands.map(fullLine).join("\n");
  }

  // 2. 特权条目在封顶内保留完整描述（按原顺序先到先得），超出封顶的降为普通条目
  const privilegeCap = Math.floor(budget * BUNDLED_BUDGET_SHARE);
  const privileged = new Set<SkillListingEntry>();
  let privilegedChars = 0;
  for (const c of commands) {
    if (!c.isBundled) continue;
    const lineCost = cost(fullLine(c));
    if (privilegedChars + lineCost > privilegeCap) continue;
    privileged.add(c);
    privilegedChars += lineCost;
  }
  const rest = commands.filter((c) => !privileged.has(c));
  const remainingBudget = budget - privilegedChars;

  // 3. 普通条目均分的是「扣掉各自前缀与换行之后」的描述预算，保证整行合计不超 remainingBudget
  const prefixTotal = rest.reduce((sum, c) => sum + prefixOf(c).length + 1, 0);
  const maxDescLen = Math.floor((remainingBudget - prefixTotal) / rest.length);

  if (maxDescLen < MIN_DESC_LENGTH) {
    // 预算太紧：普通条目只显示名称
    emitSkillDegradation("listing_names_only", {
      budget,
      total: commands.length,
      privileged: privileged.size,
      names_only: rest.length,
    });
    return commands.map((c) => (privileged.has(c) ? fullLine(c) : nameLine(c))).join("\n");
  }

  // 4. 截断普通条目描述
  const truncatedCount = rest.filter((c) => rawDesc(c).length > maxDescLen).length;
  if (truncatedCount > 0) {
    emitSkillDegradation("listing_truncated", {
      budget,
      total: commands.length,
      privileged: privileged.size,
      truncated: truncatedCount,
      max_desc_len: maxDescLen,
    });
  }
  return commands
    .map((c) => {
      if (privileged.has(c)) return fullLine(c);
      return `${prefixOf(c)}${truncate(descOf(c), maxDescLen)}`;
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
