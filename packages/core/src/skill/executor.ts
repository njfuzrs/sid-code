/**
 * Skill 执行共享内核（P0-1/P0-2/P0-3/P1-1 汇合点）
 *
 * 背景：skill 有两条调用路径——模型路径（SkillMetaTool.execute）与用户斜杠路径
 * （SkillCommand.execute）。P0-2（生命周期 hooks）、P0-3（权限判定）、P1-1（effort/agent
 * 透传）三项能力两条路径都要接。若各写一份必然漂移，故抽到本模块统一：
 *
 *   authorizeSkill()      —— P0-3：执行前权限判定（deny/ask/allow）
 *   registerSkillLifecycleHooks() —— P0-2：授权通过后注册 frontmatter hooks（先权限后 hooks）
 *   buildDelegateTask()   —— P1-1：把 SkillDefinition 归一成 CustomSubAgentTask（effort/agent 透传）
 *
 * 顺序铁律（对齐 §18 P0-3 实施方案第 4 点）：先权限判定，通过后再注册 hooks + 执行。
 * 避免被 deny 的 skill 已经注册了 hooks 污染后续工具调用。
 */

import { getLogger } from "../debug/logger.ts";
import type { SkillDefinition } from "./types.ts";
import type { HookSystem } from "../hook/system.ts";
import type { Checker, PermissionRule } from "../permission/types.ts";
import { checkSkillPermission, type SkillPermissionRules } from "./permission.ts";
import { registerSkillHooks } from "./hooks.ts";

/** 授权结果 */
export interface SkillAuthResult {
  decision: "allow" | "deny" | "ask";
  /** deny/ask 时的说明 */
  reason?: string;
}

/**
 * P0-3：skill 执行前权限判定。
 *
 * 两级判定合流：
 *   1. skill 自身安全模型（checkSkillPermission）：敏感属性（hooks/allowedTools/shell/agent/
 *      effort/maxTurns/timeoutMins）触发 ask；MCP 来源带敏感属性强制 ask；仅安全属性 allow。
 *   2. 统一权限规则（permissions.allow/deny/ask 里的 `Skill(<name>)` 形态，与工具规则同源）：
 *      deny 命中即拒；allow 命中即放行；ask 命中升级确认。
 *
 * 优先级：统一规则的 deny 最高（安全护栏，allow 永不越过 deny）；其次 skill 安全模型；
 * 二者任一要求 ask 即 ask。fail-open：判定异常时回退 allow（不阻断既有行为），仅告警。
 */
export function authorizeSkill(
  skill: SkillDefinition,
  opts: {
    /** 统一权限规则（来自 config permissions，含 Skill(name) 规则） */
    permissionRules?: PermissionRule;
  } = {},
): SkillAuthResult {
  const log = getLogger();
  try {
    // 从统一权限规则里抽取 skill 相关规则（Skill(<name>) / Skill / skill:<name>）
    const skillRules = extractSkillRules(skill.name, opts.permissionRules);

    const decision = checkSkillPermission(skill, skillRules);
    if (decision === "deny") {
      return { decision: "deny", reason: `Skill "${skill.name}" 被权限规则拒绝` };
    }
    if (decision === "ask") {
      return {
        decision: "ask",
        reason: `Skill "${skill.name}" 含敏感能力（hooks/allowedTools/shell 等）或来自 MCP，需确认`,
      };
    }
    return { decision: "allow" };
  } catch (err) {
    // fail-open：权限判定本身出错不阻断 skill（与既有"未接权限=直接放行"行为一致），仅告警
    log.warn(
      "SKILL",
      `skill 权限判定异常（fail-open 放行）: ${err instanceof Error ? err.message : String(err)}`,
    );
    return { decision: "allow" };
  }
}

/**
 * 从统一权限规则（permissions.allow/deny/ask）里抽取 skill 相关规则，
 * 转成 checkSkillPermission 认识的 { allow, deny } 形态。
 *
 * 识别形态（大小写不敏感的工具名）：
 *   - "Skill(<name>)" / "skill(<name>)" —— 精确 skill 名
 *   - "Skill" / "skill" —— 通配全部 skill（无括号）
 *   - "Skill(*)" —— 显式全通配
 *   - "skill:<name>" —— checkSkillPermission 已支持的前缀写法（透传）
 */
function extractSkillRules(
  skillName: string,
  rules?: PermissionRule,
): SkillPermissionRules {
  if (!rules) return {};
  const out: SkillPermissionRules = { allow: [], deny: [] };

  const collect = (list: string[] | undefined, into: string[]) => {
    if (!list) return;
    for (const raw of list) {
      const rule = raw.trim();
      // Skill(<arg>) 形态
      const m = rule.match(/^([A-Za-z_]+)(?:\(([^)]*)\))?$/);
      if (m) {
        const tool = m[1].toLowerCase();
        if (tool === "skill") {
          const arg = m[2];
          // 无括号 or (*) → 全通配；(name) → 精确名
          if (arg === undefined || arg === "" || arg === "*") {
            into.push("*");
          } else if (arg.toLowerCase() === skillName.toLowerCase()) {
            into.push(skillName);
          }
          continue;
        }
      }
      // skill:<name> 前缀写法（checkSkillPermission matchesRule 直接认）
      if (rule.toLowerCase() === `skill:${skillName.toLowerCase()}`) {
        into.push(`skill:${skillName}`);
      }
    }
  };

  collect(rules.deny, out.deny!);
  collect(rules.allow, out.allow!);
  return out;
}

/**
 * P0-3：把 authorizeSkill 的 ask 决策落到实际的用户确认。
 *
 * @param checker 权限检查器（主会话注入；子代理路径用 dontAsk 语义的 subChecker，ask→deny）
 * @param confirm 直接确认回调（用户斜杠路径可用主会话弹窗）
 * @returns true=放行，false=用户拒绝/无通道拒绝
 */
export async function resolveSkillAsk(
  skill: SkillDefinition,
  reason: string,
  opts: {
    checker?: Checker | null;
    confirm?: (desc: string) => Promise<boolean>;
  },
): Promise<boolean> {
  const log = getLogger();
  const desc = `执行 Skill "${skill.name}"？${reason}`;

  // 优先用直接确认回调（用户斜杠路径）
  if (opts.confirm) {
    try {
      return await opts.confirm(desc);
    } catch (err) {
      log.warn("SKILL", `skill 确认回调异常，保守拒绝: ${err instanceof Error ? err.message : String(err)}`);
      return false;
    }
  }

  // 其次走 checker 的 ask 通道
  if (opts.checker) {
    try {
      const decision = await opts.checker.check({
        toolName: `Skill(${skill.name})`,
        input: {},
        description: desc,
      });
      // 子代理 subChecker 语义：ask→deny，needsConfirmation 视为拒绝
      return decision.allowed === true;
    } catch (err) {
      log.warn("SKILL", `skill 权限 checker 异常，保守拒绝: ${err instanceof Error ? err.message : String(err)}`);
      return false;
    }
  }

  // 无任何确认通道：保守拒绝（ask 不能静默放行）
  log.warn("SKILL", `skill "${skill.name}" 需确认但无确认通道，拒绝执行`);
  return false;
}

/**
 * P0-2：授权通过后注册 skill 声明的生命周期 hooks。
 *
 * 安全：MCP 来源 skill（loadedFrom="mcp"）禁止注册 hooks（远程来源不可信，能执行任意 shell）。
 * @returns 成功注册的 hook 数量（0 表示无 hooks / 被拒 / 无 hookSystem）
 */
export function registerSkillLifecycleHooks(
  skill: SkillDefinition,
  hookSystem: HookSystem | undefined,
): number {
  if (!hookSystem) return 0;
  if (!skill.hooks || Object.keys(skill.hooks).length === 0) return 0;

  // 安全铁律：MCP 来源禁止注册 hooks
  if (skill.loadedFrom === "mcp") {
    getLogger().warn(
      "SKILL",
      `MCP 来源 skill "${skill.name}" 声明了 hooks，出于安全已拒绝注册`,
    );
    return 0;
  }

  return registerSkillHooks(hookSystem, skill.name, skill.hooks, skill.skillRoot);
}

/**
 * P1-1：归一化 skill 的 effort 字段。
 *
 * loader 解析出的 effort 是任意字符串（frontmatter 原样）。这里收敛到 CustomSubAgentTask
 * 认识的 5 档（low/medium/high/xhigh/max）；非法值 fail-open 返回 undefined（子代理默认不思考）。
 */
export function normalizeSkillEffort(
  raw: string | undefined,
): "low" | "medium" | "high" | "xhigh" | "max" | undefined {
  if (!raw) return undefined;
  const v = raw.trim().toLowerCase();
  if (v === "low" || v === "medium" || v === "high" || v === "xhigh" || v === "max") {
    return v;
  }
  getLogger().warn("SKILL", `skill effort 值非法（忽略）: ${raw}`);
  return undefined;
}

/**
 * P1-1：解析 skill.agent（fork 时用哪个 agent 类型）。
 *
 * 校验该 agent 类型存在于 registry；不存在则告警回退 undefined（调用方用 skill:<name>）。
 * fail-open：解析异常不 spawn 失败。
 */
export async function resolveSkillAgentType(
  agent: string | undefined,
  skillName: string,
): Promise<string | undefined> {
  if (!agent || !agent.trim()) return undefined;
  const type = agent.trim();
  try {
    const { resolveAgent, getActiveAgentTypes } = await import("../agent/agent-definition.ts");
    if (resolveAgent(type)) return type;
    getLogger().warn(
      "SKILL",
      `skill "${skillName}" 声明的 agent 类型 "${type}" 不存在（可用: ${getActiveAgentTypes().join(", ")}），回退 skill:${skillName}`,
    );
    return undefined;
  } catch (err) {
    getLogger().warn(
      "SKILL",
      `解析 skill agent 类型失败（回退）: ${err instanceof Error ? err.message : String(err)}`,
    );
    return undefined;
  }
}
