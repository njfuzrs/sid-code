/**
 * Skill 摘要 listing 收集
 *
 * 从工具列表里收集「应进入 system prompt 常驻 skill 摘要」的条目，供 buildSystemPrompt
 * 注入（generateSkillListingAttachment 按 budget.ts 的预算截断）。
 *
 * 两类来源，都用鸭子类型识别，避免本模块反向依赖具体工具类：
 *   - SkillMetaTool.getListingEntries()  —— 磁盘/内置/插件/MCP skill 一次性汇总
 *     （P0-1 后 skill 只有这一个元工具，工具数不随 skill 增长）
 *   - BundledSkillTool.getListingEntry() —— 编译时内置 skill，仍是各自独立工具
 */

import type { SkillListingEntry } from "./budget.ts";

/** 暴露批量条目的工具（SkillMetaTool） */
interface ListingEntriesProvider {
  getListingEntries?: () => SkillListingEntry[];
}

/** 暴露单条条目的工具（BundledSkillTool） */
interface ListingEntryProvider {
  getListingEntry?: () => SkillListingEntry;
}

/**
 * 收集所有 skill 摘要条目（同名去重，批量来源优先于单条来源）。
 * @returns 无条目时返回 undefined（避免给 ctx.skillEntries 喂空数组）
 */
export function collectSkillListingEntries(
  tools: ReadonlyArray<unknown>,
): SkillListingEntry[] | undefined {
  const entries: SkillListingEntry[] = [];

  for (const t of tools) {
    const batch = (t as ListingEntriesProvider).getListingEntries;
    if (typeof batch === "function") {
      entries.push(...batch.call(t));
      continue;
    }
    const single = (t as ListingEntryProvider).getListingEntry;
    if (typeof single === "function") {
      entries.push(single.call(t));
    }
  }

  // 同名去重，保留首个（元工具条目先于 bundled 进入，故元工具优先）
  const seen = new Set<string>();
  const deduped = entries.filter((e) => {
    const key = e.name.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  return deduped.length > 0 ? deduped : undefined;
}
