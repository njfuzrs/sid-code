/**
 * Skill 生命周期钩子集成（Task 7）
 *
 * Skill 可在 frontmatter 中声明 hooks，这些 hooks 在 Skill 被调用时注册为
 * 会话级钩子（source=runtime），持续到会话结束或 Skill 卸载。
 * 支持 once: true 的一次性钩子。
 *
 * frontmatter 示例：
 *   hooks:
 *     PostToolUse:
 *       - matcher: "write"
 *         hooks:
 *           - command: "npx eslint --fix ${SKILL_DIR}/x"
 *             once: false
 */

import { getLogger } from "../debug/logger.ts";
import type { HookSystem } from "../hook/system.ts";
import {
  HookEventName,
  LEGACY_EVENT_MAP,
  type CommandHookConfig,
} from "../hook/types.ts";
import type { SkillHooksConfig } from "./types.ts";

/** 校验事件名是否合法（PascalCase 或旧 snake_case） */
export function isValidHookEvent(name: string): boolean {
  const values = Object.values(HookEventName) as string[];
  return values.includes(name) || name in LEGACY_EVENT_MAP;
}

function resolveEvent(name: string): HookEventName | null {
  const values = Object.values(HookEventName) as string[];
  if (values.includes(name)) return name as HookEventName;
  return (LEGACY_EVENT_MAP as Record<string, HookEventName>)[name] ?? null;
}

/**
 * 注册 Skill 声明的生命周期钩子
 * @returns 成功注册的 hook 数量
 */
export function registerSkillHooks(
  hookSystem: HookSystem,
  skillName: string,
  hooksConfig: SkillHooksConfig | undefined,
  skillRoot: string | undefined,
): number {
  if (!hooksConfig) return 0;
  const log = getLogger();
  let count = 0;

  for (const [eventName, definitions] of Object.entries(hooksConfig)) {
    const resolved = resolveEvent(eventName);
    if (!resolved) {
      log.warn("SKILL", `Skill ${skillName} 声明了未知的 hook 事件: ${eventName}`);
      continue;
    }
    if (!Array.isArray(definitions)) continue;

    for (const def of definitions) {
      if (!def || !Array.isArray(def.hooks)) continue;
      for (const hook of def.hooks) {
        if (!hook?.command) continue;

        // 替换命令中的 skill 目录变量。三种写法都认：
        //   ${SKILL_DIR}          —— sid 原生
        //   ${CLAUDE_SKILL_DIR}   —— 与 prompt-processor 的 CC 兼容写法一致
        //   ${CLAUDE_PLUGIN_ROOT} —— CC 权威写法（utils/hooks.ts:845，skill hook 复用插件变量名，
        //                            使 skill 迁移成 plugin 时命令无需改动）
        // 用函数形式 replace，避免 skillRoot 里的 `$&`/`$1` 被当替换模式解释。
        let command = hook.command;
        if (skillRoot) {
          command = command.replace(
            /\$\{(?:SKILL_DIR|CLAUDE_SKILL_DIR|CLAUDE_PLUGIN_ROOT)\}/g,
            () => skillRoot,
          );
        }

        const config: CommandHookConfig = {
          type: "command",
          name: `skill:${skillName}`,
          command,
          // 对齐 CC（utils/hooks.ts:908）：skill hook 的子进程可通过环境变量拿到 skill 根目录，
          // 无需在命令里硬编码路径。CLAUDE_PLUGIN_ROOT 是 CC 权威名（skill 与 plugin 同名），
          // 另给 sid 原生前缀别名，便于 sid 侧脚本自解释。
          env: skillRoot
            ? {
                CLAUDE_PLUGIN_ROOT: skillRoot,
                CLAUDE_SKILL_DIR: skillRoot,
                SID_CODE_SKILL_DIR: skillRoot,
                SID_CODE_SKILL_NAME: skillName,
              }
            : { SID_CODE_SKILL_NAME: skillName },
        };

        try {
          hookSystem.registerSessionHook(config, resolved, {
            matcher: def.matcher,
            skillName,
            once: hook.once ?? false,
          });
          count++;
          log.debug(
            "SKILL",
            `注册 Skill hook: ${skillName} → ${eventName}:${def.matcher ?? "*"}`,
          );
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          log.warn("SKILL", `注册 Skill hook 失败 (${skillName}): ${msg}`);
        }
      }
    }
  }

  if (count > 0) {
    log.info("SKILL", `Skill ${skillName} 注册了 ${count} 个会话级 hook`);
  }
  return count;
}

/** 卸载 Skill 声明的所有生命周期钩子 */
export function unregisterSkillHooks(
  hookSystem: HookSystem,
  skillName: string,
): number {
  return hookSystem.removeSkillHooks(skillName);
}
