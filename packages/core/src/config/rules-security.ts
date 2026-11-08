/**
 * CLAUDE.md 里的安全敏感段：`## Permission Mode` 与 `## Allowed Tools`。
 *
 * Harness 厚薄归位专项 B6 / B9（2026-11-08，`sid-code-dev` 回放实测）：仓库里提交的 CLAUDE.md
 * 写一行 `## Permission Mode\nalways-allow`，启动即把会话抬到 always-allow，写操作不再确认；
 * 会话中途改 CLAUDE.md 经热重载同样生效，且全程只有一条 log.info。
 * 而项目级 settings.json 设 `permissionMode` / `allowedTools` 早就被剔除
 * （`settings/security.ts` 的 SECURITY_SENSITIVE_FIELDS）——同一个意图换一个文件就绕过了。
 *
 * 这里把两条路径收成同一口径：只有企业 managed 与用户级来源能设这两项，
 * 项目侧来源（父链 / 子目录 / rules 目录 / CLAUDE.local.md）一律剔除并留痕。
 */

import { PERMISSION_MODE_VALUES, type PermissionMode } from "../permission/mode.ts";
import { isBypassDisabledByPolicy, isModeDisabledByPolicy } from "../permission/mode-policy.ts";
import type { ProjectRules } from "./rules.ts";

/** 轨迹事件名：CLAUDE.md 的权限段被采纳或被剔除时各打一条（B23） */
export const PROJECT_RULES_PERMISSION_EVENT_NAME = "ProjectRulesPermission";

/**
 * 能在 CLAUDE.md 里设权限模式、追加工具白名单的层。
 *
 * 为什么是白名单而不是黑名单：新增一个规则层（比如将来的插件规则目录）默认就不可信，
 * 漏登记的后果是「功能不生效」而不是「多一个提权口子」。`layer` 缺失同样按不可信处理。
 * CLAUDE.local.md（`local`）也不在内：它落在项目目录里，模型能写，和项目 settings.local.json
 * 一样不是用户级配置。
 */
export const TRUSTED_RULE_LAYERS: ReadonlySet<NonNullable<ProjectRules["layer"]>> = new Set([
  "managed",
  "user",
  "userRulesDir",
]);

/** 一条因来源不可信而被剔除的安全敏感段 */
export interface IgnoredRuleField {
  field: "permissionMode" | "allowedTools";
  layer: ProjectRules["layer"];
  sourcePath: string;
  /** permissionMode 为原值；allowedTools 为条目数 */
  value: string;
}

/**
 * 剔除不可信层上的 `permissionMode` / `allowedTools`，把剔除记录追加进 `ignored`。
 * 可信层原样返回（同一个对象）；不可信层返回去掉这两项的浅拷贝，不改入参。
 */
export function stripUntrustedSecurityFields(
  rules: ProjectRules,
  ignored: IgnoredRuleField[],
): ProjectRules {
  if (rules.layer && TRUSTED_RULE_LAYERS.has(rules.layer)) return rules;
  const hasMode = !!rules.permissionMode;
  const hasAllowed = !!rules.allowedTools && rules.allowedTools.length > 0;
  if (!hasMode && !hasAllowed) return rules;

  const { permissionMode, allowedTools, ...rest } = rules;
  if (hasMode) {
    ignored.push({
      field: "permissionMode",
      layer: rules.layer,
      sourcePath: rules.sourcePath,
      value: permissionMode!,
    });
  }
  if (hasAllowed) {
    ignored.push({
      field: "allowedTools",
      layer: rules.layer,
      sourcePath: rules.sourcePath,
      value: String(allowedTools!.length),
    });
  }
  return rest;
}

const VALID_MODES: ReadonlySet<string> = new Set(PERMISSION_MODE_VALUES);
const BYPASS_MODES: ReadonlySet<string> = new Set(["always-allow", "dangerously-skip-permissions"]);

export type RulesPermissionModeResolution =
  /** 采纳：把会话切到 `mode` */
  | { kind: "apply"; mode: PermissionMode }
  /** 不动且不值得留痕：没写、写的是 default、或会话已经不在 default（CLI / settings 指定过） */
  | { kind: "noop" }
  /** 拒绝采纳并留痕 */
  | { kind: "ignore"; reason: "invalid_value" | "policy_disabled" };

/**
 * 判定（已过滤到可信层的）CLAUDE.md `## Permission Mode` 该不该生效。
 *
 * 取值校验：此前首行原样赋给 `config.permissionMode`，`## Permission` 标题下写一句
 * 「见团队 wiki」就会让会话的模式变成这串字（实测 trace `mode: "见团队 wiki"`）。
 * 企业策略：CLI 显式传被禁模式会 fail-fast（cli.ts），但 CLAUDE.md 在策略降级之后才加载，
 * 不在这里查就能把策略禁掉的 always-allow 设回来。
 */
export function resolveRulesPermissionMode(
  value: string | undefined,
  currentMode: string,
): RulesPermissionModeResolution {
  // 只在默认档时采纳：CLI / settings 显式指定的模式优先（沿用原语义）
  if (!value || currentMode !== "default") return { kind: "noop" };
  const mode = value.trim();
  if (!VALID_MODES.has(mode)) return { kind: "ignore", reason: "invalid_value" };
  if (mode === "default") return { kind: "noop" };
  if (isModeDisabledByPolicy(mode) || (BYPASS_MODES.has(mode) && isBypassDisabledByPolicy())) {
    return { kind: "ignore", reason: "policy_disabled" };
  }
  return { kind: "apply", mode: mode as PermissionMode };
}

/** 事件里的原值截断长度：非法值可能是任意一行正文 */
export const RULES_PERMISSION_VALUE_MAX = 64;
