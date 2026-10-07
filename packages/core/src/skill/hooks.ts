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
import { reportRuntimeHookDiagnostics } from "../hook/diagnostic-sink.ts";
import { ConfigSource, HookEventName, LEGACY_EVENT_MAP } from "../hook/types.ts";
import type { SkillHooksConfig } from "./types.ts";

/** 校验事件名是否合法（PascalCase 或旧 snake_case） */
export function isValidHookEvent(name: string): boolean {
  const values = Object.values(HookEventName) as string[];
  return values.includes(name) || name in LEGACY_EVENT_MAP;
}

let scopeSeq = 0;

/**
 * P1-6：生成一次 skill 调用的 hook 作用域 id。
 * 「调用完就卸」的路径（模型元工具、fork）注册时带上它、卸载时按它删，
 * 避免按名字删把 inline 路径注册的同名长期 hooks 一起清空。
 */
export function newSkillHookScope(): string {
  scopeSeq += 1;
  return `call-${Date.now().toString(36)}-${scopeSeq}`;
}

/**
 * 注册 Skill 声明的生命周期钩子
 *
 * HC3：形状解析统一走 hook/config-normalize.ts。原先这里自己转换，只认嵌套形状里的 command，
 * timeout / env / if / url / prompt 全部丢失。skill 目录变量（${SKILL_DIR} / ${CLAUDE_SKILL_DIR} /
 * ${CLAUDE_PLUGIN_ROOT}，后者是 CC 权威写法，skill 复用插件变量名）不再往命令串里替换，
 * 改由 runner 导出为同名环境变量，shell 自己展开（与 H14 同理：路径不进 shell 串）。
 *
 * @param scope 调用作用域 id（见 newSkillHookScope）；省略 = 会话作用域（inline 长期存活）
 * @returns 成功注册的 hook 数量
 */
export function registerSkillHooks(
  hookSystem: HookSystem,
  skillName: string,
  hooksConfig: SkillHooksConfig | undefined,
  skillRoot: string | undefined,
  scope?: string,
): number {
  if (!hooksConfig) return 0;
  const log = getLogger();
  const before = hookSystem.getAllHooks().length;

  // skill hook 是会话级 runtime 来源（不过 settings 信任门、随 skill 调用注册/卸载），
  // 但 handler 类型照常是 command 等用户类型——H28 的「内部 hook」只认 type=runtime，不受影响。
  const diagnostics = hookSystem.addNormalizedHooks(
    hooksConfig,
    ConfigSource.Runtime,
    {
      pathPrefix: `skill:${skillName}.hooks`,
      skillRoot,
      defaultName: `skill:${skillName}`,
      extraEnv: { SID_CODE_SKILL_NAME: skillName },
      allowOnce: true,
    },
    { skillName, hookScope: scope },
  );
  for (const d of diagnostics) {
    log.warn("SKILL", `Skill ${skillName} 的 hook 已跳过 ${d.path}: ${d.message}`);
  }
  // 运行期注册，启动横幅已过：走运行期出口让用户在终端里看得到（logger 只在 --debug 日志里）
  reportRuntimeHookDiagnostics(`Skill ${skillName}`, diagnostics);

  const count = hookSystem.getAllHooks().length - before;
  if (count > 0) {
    log.info("SKILL", `Skill ${skillName} 注册了 ${count} 个会话级 hook`);
  }
  return count;
}

/** 卸载 Skill 声明的生命周期钩子（传 scope 只卸该次调用注册的那一批） */
export function unregisterSkillHooks(
  hookSystem: HookSystem,
  skillName: string,
  scope?: string,
): number {
  return hookSystem.removeSkillHooks(skillName, scope);
}
