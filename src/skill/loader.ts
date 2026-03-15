/**
 * Skill 加载器
 * 从 ~/.sid-code/skills/ 和 {project}/.sid-code/skills/ 加载 Skill 定义
 */

import { ExtensionLoader } from "../extension/loader.ts";
import { getLogger } from "../debug/logger.ts";
import type { SkillDefinition } from "./types.ts";

/** 最大 Skill 数量（避免工具列表膨胀） */
const MAX_SKILLS = 20;

export class SkillLoader {
  private extensionLoader: ExtensionLoader;

  constructor(extensionLoader?: ExtensionLoader) {
    this.extensionLoader = extensionLoader ?? new ExtensionLoader();
  }

  /** 加载所有 Skill 定义 */
  async loadAll(projectDir?: string): Promise<SkillDefinition[]> {
    const log = getLogger();
    const files = await this.extensionLoader.scan("skills", projectDir ?? process.cwd());
    const skills: SkillDefinition[] = [];

    for (const file of files) {
      if (skills.length >= MAX_SKILLS) {
        log.warn("SKILL", `已达到最大 Skill 数量 (${MAX_SKILLS})，跳过剩余文件`);
        break;
      }

      const fm = file.frontmatter;

      // 解析 allowed-tools（支持逗号分隔字符串或数组）
      let allowedTools: string[] | undefined;
      const rawTools = fm["allowed-tools"] ?? fm["allowedTools"] ?? fm["tools"];
      if (typeof rawTools === "string") {
        allowedTools = rawTools.split(",").map(s => s.trim()).filter(Boolean);
      } else if (Array.isArray(rawTools)) {
        allowedTools = rawTools.map(String);
      }

      const skill: SkillDefinition = {
        name: (fm.name as string) || file.name,
        description: (fm.description as string) || "",
        allowedTools,
        whenToUse: fm["when-to-use"] as string ?? fm["whenToUse"] as string,
        argumentHint: fm["argument-hint"] as string ?? fm["argumentHint"] as string,
        model: fm.model as string,
        disableModelInvocation: fm["disable-model-invocation"] === true || fm["disableModelInvocation"] === true,
        prompt: file.body,
        source: file.source,
        filePath: file.filePath,
      };

      skills.push(skill);
    }

    if (skills.length > 0) {
      log.info("SKILL", `加载了 ${skills.length} 个 Skill`, {
        names: skills.map(s => s.name),
      });
    }

    return skills;
  }
}
