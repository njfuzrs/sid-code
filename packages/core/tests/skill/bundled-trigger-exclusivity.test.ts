/**
 * Bundled Skill 触发词独占性门禁（D-19）
 *
 * 现象：review 与 simplify 的 whenToUse 都声明了 'review'。这段 whenToUse 会经
 * generateSkillListing 每轮注入 system prompt，模型看到两个都该触发的候选。
 * 两者的产出形态相反——review 只读出意见，simplify 会改文件——用户说
 * 「review 这个 PR」时选错，会让用户以为只是看看、结果代码被改了。
 *
 * 为什么只断言「独占词」而不做全量集合相交：'检查代码' 这类泛词天然容易重叠，
 * 做成全量严格集合会频繁误报，最终结果是下一个人直接把这条门禁关掉。
 * 所以只对 review / commit / deploy 这类「一个词只能属于一个 Skill」的独占词硬断言。
 */

import { describe, test, expect } from "bun:test";
import { loadBundledSkills } from "@sid-code/core/skill/bundled/index.ts";

/** 每个 Skill 的 whenToUse（loadBundledSkills 走真实注册路径，不是另建一套扫描）。 */
function whenToUseMap(): Map<string, string> {
  const map = new Map<string, string>();
  for (const skill of loadBundledSkills()) {
    if (skill.type !== "prompt") continue;
    if (skill.whenToUse) map.set(skill.name, skill.whenToUse);
  }
  return map;
}

/** 从 whenToUse 里抽出单引号包裹的触发词（与提示词书写约定一致）。 */
function quotedWords(whenToUse: string): string[] {
  return [...whenToUse.matchAll(/'([^']+)'/g)].map((m) => m[1].trim());
}

/**
 * 独占性触发词：一个词只该属于一个 Skill。
 * 新增 Skill 时如果确实需要共享某个词，说明两者语义重叠，应先拆分语义而不是往这里加。
 */
const EXCLUSIVE_WORDS = ["review", "commit", "deploy", "verify", "simplify"];

/**
 * 泛词白名单：天然容易重叠的意图描述，不进独占断言。
 * 例：simplify 与 review 都可能被用户用「检查代码」表达，这两者本就是邻近能力。
 */
const GENERIC_WORDS = new Set([
  "检查代码",
  "清理代码",
  "简化",
  "精简",
  "去掉重复",
  "代码审查",
  "审一下",
  "验证",
  "检查是否工作",
  "跑测试确认",
]);

describe("D-19 Skill 触发词独占性", () => {
  test("simplify 的 whenToUse 不含 'review'——review 由 review Skill 独占", () => {
    const map = whenToUseMap();
    const simplify = map.get("simplify");
    expect(simplify).toBeDefined();
    expect(quotedWords(simplify!)).not.toContain("review");
  });

  test("review 的 whenToUse 仍保留 'review'（语义自然，不应被让走）", () => {
    const map = whenToUseMap();
    expect(quotedWords(map.get("review") ?? "")).toContain("review");
  });

  test("独占性触发词在所有 bundled Skill 之间两两不交", () => {
    const owner = new Map<string, string>();
    const collisions: string[] = [];
    for (const [name, whenToUse] of whenToUseMap()) {
      // 单引号内可能是一个短语（'review 这个 PR'），此时只取其中的独占单词，
      // 否则短语永远不相等，独占断言会静默失效。
      for (const word of quotedWords(whenToUse)) {
        for (const token of word.split(/[\s，,]+/)) {
          if (!EXCLUSIVE_WORDS.includes(token)) continue;
          const prev = owner.get(token);
          if (prev && prev !== name) collisions.push(`'${token}': ${prev} / ${name}`);
          else owner.set(token, name);
        }
      }
    }
    expect(collisions).toEqual([]);
  });

  test("泛词白名单内允许重叠（防止门禁误报、避免被直接关掉）", () => {
    // 白名单存在的意义就是「这些词重叠不算错」：只要白名单词出现在某 Skill 里，
    // 上面的独占断言不应因它而红。这里正向断言 classify 结果，防白名单被误删。
    const genericInSkill = [...whenToUseMap().values()]
      .flatMap(quotedWords)
      .filter((w) => GENERIC_WORDS.has(w));
    expect(genericInSkill.length).toBeGreaterThan(0);
    for (const w of genericInSkill) expect(EXCLUSIVE_WORDS).not.toContain(w);
  });
});
