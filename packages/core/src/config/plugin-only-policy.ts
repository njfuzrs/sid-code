/**
 * 定制化来源锁定策略（strictPluginOnlyCustomization）
 *
 * 企业管控的一种：把某些「定制化面」锁定为只接受管理员可信来源，屏蔽用户级
 *（~/.sid-code/*）与项目级（.sid-code/*）的自带内容。典型用途是防止团队成员在
 * 项目里塞入未审计的 skill/agent/hook 而被自动加载执行。
 *
 * 语义（对齐 CC utils/settings/pluginOnlyPolicy.ts）：
 * - `strictPluginOnlyCustomization: true` → 锁定全部面；
 * - 数组形式 → 只锁列出的面（如 ["skills", "hooks"]）；
 * - 缺省/undefined → 不锁（默认行为）。
 *
 * 哪些来源不受锁定影响（admin-trusted）：
 * - managed / policySettings：本就是管理员下发；
 * - plugin：由 marketplace 白名单单独管控；
 * - builtin / bundled：随二进制发布，非用户编写。
 *
 * 单例模式（对齐 policy-limits.ts / mode-policy.ts）：cli 启动加载 policy 后注入，
 * 之后各处只读查询，无需层层透传 PolicyManager。
 */

import { getLogger } from "../debug/logger.ts";

/** 可被锁定的定制化面 */
export type CustomizationSurface = "commands" | "skills" | "agents" | "hooks" | "mcp-servers";

const ALL_SURFACES: readonly CustomizationSurface[] = [
  "commands",
  "skills",
  "agents",
  "hooks",
  "mcp-servers",
];

/**
 * 不受 strictPluginOnlyCustomization 约束的来源。
 * 与 SkillDefinition.source / loadedFrom 及扩展来源标记的取值保持一致。
 */
const ADMIN_TRUSTED_SOURCES: ReadonlySet<string> = new Set([
  "managed",
  "policySettings",
  "plugin",
  "builtin",
  "built-in",
  "bundled",
]);

/** 当前锁定的面（空集 = 不锁） */
let lockedSurfaces = new Set<CustomizationSurface>();

/**
 * 注入锁定策略（cli 启动读 managed settings 后调用）。
 * @param policy true=锁全部；数组=只锁列出的；undefined=不锁
 */
export function setPluginOnlyPolicy(policy: boolean | CustomizationSurface[] | undefined): void {
  if (policy === true) {
    lockedSurfaces = new Set(ALL_SURFACES);
  } else if (Array.isArray(policy)) {
    // 过滤未知面名，避免拼写错误静默锁死/漏锁
    const known = policy.filter((s): s is CustomizationSurface =>
      (ALL_SURFACES as readonly string[]).includes(s),
    );
    const unknown = policy.filter((s) => !(ALL_SURFACES as readonly string[]).includes(s));
    if (unknown.length > 0) {
      getLogger().warn(
        "POLICY",
        `strictPluginOnlyCustomization 含未知定制化面（已忽略）: ${unknown.join(", ")}`,
      );
    }
    lockedSurfaces = new Set(known);
  } else {
    lockedSurfaces = new Set();
  }

  if (lockedSurfaces.size > 0) {
    getLogger().info(
      "POLICY",
      `企业策略锁定定制化来源（仅 managed/plugin/builtin 生效）: ${[...lockedSurfaces].join(", ")}`,
    );
  }
}

/** 某个定制化面是否被锁定为「仅管理员可信来源」。 */
export function isRestrictedToPluginOnly(surface: CustomizationSurface): boolean {
  return lockedSurfaces.has(surface);
}

/**
 * 在指定面被锁定的前提下，判断某来源是否仍可加载。
 * 面未被锁定时一律放行。
 */
export function isSourceAllowedUnderLock(
  surface: CustomizationSurface,
  source: string | undefined,
): boolean {
  if (!isRestrictedToPluginOnly(surface)) return true;
  return source != null && ADMIN_TRUSTED_SOURCES.has(source);
}

/** 测试用：重置状态。 */
export function __resetPluginOnlyPolicy(): void {
  lockedSurfaces = new Set();
}
