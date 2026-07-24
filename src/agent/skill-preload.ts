/**
 * 子代理技能预加载（P1-1，对齐 CC §11.8 角色链最佳实践）
 *
 * CC 的核心最佳实践：在子代理 frontmatter 用 `skills:` 预加载专业知识
 * （如 api-developer 预加载 api-conventions + error-handling-patterns）。
 * 本模块负责按名解析 skill 内容，供 enhanceSubAgentPrompt 注入子代理 system prompt。
 *
 * 设计：memoize 一次性 discover 全部 skill，之后按名 O(1) 查表。
 * skill 不存在 → 返回 null（调用方 warn 跳过，不 spawn 失败）。
 */

import { getLogger } from "../debug/logger.ts";
import { memoize } from "../utils/memoize.ts";

/** name(lowercase) → prompt body 的内容表。 */
type SkillContentMap = Map<string, { name: string; content: string }>;

/**
 * 加载并缓存全部 skill 的内容表（memoized，进程内只 discover 一次）。
 * discover 失败降级为空表（不阻断子代理启动）。
 */
const loadSkillContentMap = memoize(async (): Promise<SkillContentMap> => {
  const map: SkillContentMap = new Map();
  try {
    const { SkillManager } = await import("../skill/manager.ts");
    const mgr = new SkillManager();
    await mgr.discover(process.cwd());
    for (const skill of mgr.getAllSkills()) {
      if (skill.name && typeof skill.prompt === "string") {
        map.set(skill.name.toLowerCase(), { name: skill.name, content: skill.prompt });
      }
    }
  } catch (err: any) {
    getLogger().debug("SUBAGENT", `技能预加载 discover 失败（降级为空）: ${err?.message ?? String(err)}`);
  }
  return map;
});

/**
 * 构建子代理预加载技能段（P1-1）。
 *
 * @param skillNames frontmatter 声明的技能名列表
 * @param agentType  子代理类型（仅用于日志）
 * @returns 注入 system prompt 的段落；无有效技能时返回空串。
 */
export async function buildSkillPreloadSection(
  skillNames: string[] | undefined,
  agentType?: string,
): Promise<string> {
  if (!skillNames || skillNames.length === 0) return "";
  const log = getLogger();
  const map = await loadSkillContentMap();

  const sections: string[] = [];
  for (const rawName of skillNames) {
    const name = rawName.trim();
    if (!name) continue;
    const entry = map.get(name.toLowerCase());
    if (!entry) {
      log.warn("SUBAGENT", `子代理 ${agentType ?? ""} 声明的预加载技能 "${name}" 不存在，已跳过`);
      continue;
    }
    sections.push(`### 技能：${entry.name}\n\n${entry.content}`);
  }

  if (sections.length === 0) return "";
  return `## 预加载专业知识（skills）\n\n以下是为你预加载的领域技能内容，作为完成任务时的专业知识参考：\n\n${sections.join("\n\n---\n\n")}`;
}

/** 测试用：清除 memoize 缓存。 */
export function __clearSkillPreloadCache(): void {
  loadSkillContentMap.clear();
}
