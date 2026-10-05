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
 * - plugin：在本模块的 `evaluatePluginOrigin()` 里单独判定（见文件末尾「插件来源」一节）：
 *   锁定生效时只放行企业市场装的插件，本地目录 / --plugin-dir 一律拒绝。
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

// ============================================================
// 插件来源（strictKnownMarketplaces，P5）
// ============================================================
//
// 缺口：上面的 ADMIN_TRUSTED_SOURCES 把 `plugin` 当作无条件可信，原注释写着「由
// marketplace 白名单单独管控」，但那条白名单从未实现 —— 于是任何人把一个目录
// `/plugin install` 进来（或 `--plugin-dir`），它的 skills / hooks / MCP 就绕过了
// strictPluginOnlyCustomization。插件是锁定状态下**唯一**还开着的口子，必须在这里收住。
//
// 判定（只看插件从哪来，不看插件里有什么 —— 内容审核是管理员上架时做的）：
//
// | 插件来源 | 未锁定 | 锁定且无白名单 | strictKnownMarketplaces = [...] |
// | --- | --- | --- | --- |
// | builtin（随二进制） | 放行 | 放行 | 放行 |
// | 企业市场（index URL = U） | 放行 | U == 本机 backend.url 推出的市场才放行 | U ∈ 白名单才放行 |
// | 本地目录 / --plugin-dir | 放行 | **拒绝** | **拒绝** |
//
// 「锁定」= strictPluginOnlyCustomization 锁了任意一个面，或下发了 strictKnownMarketplaces。
// 白名单为空数组 = 除内置外一律拒绝（fail-closed，与「省略 = 不限制」严格区分）。
// 锁定但没下白名单时，默认信任的是本机 backend.url 那个市场：backend.url 项目级
// settings 改不了（SECURITY_SENSITIVE_FIELDS），它就是「公司的」那一个。

/** 白名单里的一项。与服务端 PolicySettingsIn.strictKnownMarketplaces 同形。 */
export interface KnownMarketplace {
  source: "url";
  /** 市场 index 的完整地址（如 https://host/traj/api/v1/ctl/marketplace/index），已规范化 */
  url: string;
}

/** undefined = 未下发（不限制）；数组 = 白名单（可为空） */
let knownMarketplaces: string[] | undefined;

/** 规范化 index URL：只认 https 或 loopback http，去掉 query / hash / 尾斜杠。不合法返回 null。 */
export function normalizeMarketplaceUrl(raw: string): string | null {
  let u: URL;
  try {
    u = new URL(raw.trim());
  } catch {
    return null;
  }
  const host = u.hostname.toLowerCase();
  const loopback = host === "127.0.0.1" || host === "localhost" || host === "[::1]";
  if (u.protocol !== "https:" && !(u.protocol === "http:" && loopback)) return null;
  if (u.username || u.password) return null;
  u.search = "";
  u.hash = "";
  return u.toString().replace(/\/+$/, "");
}

/**
 * 注入市场白名单（applyLoadedPolicy 调用）。不合法的条目丢掉并告警 ——
 * **不会**因此把整份白名单当成未下发：管理员写错一个地址，结果应该是「那个市场装不了」，
 * 而不是「锁定整个失效」。
 */
export function setKnownMarketplacesPolicy(list: unknown): void {
  if (!Array.isArray(list)) {
    knownMarketplaces = undefined;
    return;
  }
  const kept: string[] = [];
  const dropped: string[] = [];
  for (const item of list) {
    const rec = item && typeof item === "object" ? (item as Record<string, unknown>) : null;
    const url =
      rec && rec.source === "url" && typeof rec.url === "string"
        ? normalizeMarketplaceUrl(rec.url)
        : null;
    if (url) {
      if (!kept.includes(url)) kept.push(url);
    } else {
      dropped.push(JSON.stringify(item));
    }
  }
  if (dropped.length > 0) {
    getLogger().warn(
      "POLICY",
      `strictKnownMarketplaces 含无效条目（已忽略，只认 {source:"url", url:https://...}）: ${dropped.join(", ")}`,
    );
  }
  knownMarketplaces = kept;
  getLogger().info(
    "POLICY",
    `企业策略限定插件市场: ${kept.length > 0 ? kept.join(", ") : "（空：除内置外禁用全部插件）"}`,
  );
}

/** 当前白名单（undefined = 未下发）。给 /plugin market 展示用。 */
export function getKnownMarketplaces(): readonly string[] | undefined {
  return knownMarketplaces;
}

/** 插件来源是否处于锁定状态（任一面被锁，或下发了白名单）。 */
export function isPluginOriginLocked(): boolean {
  return lockedSurfaces.size > 0 || knownMarketplaces !== undefined;
}

export type PluginOrigin =
  | { kind: "builtin" }
  | { kind: "local" }
  | { kind: "inline" }
  | { kind: "market"; indexUrl: string };

export type PluginOriginDecision = { allowed: true } | { allowed: false; reason: string };

/**
 * 判定一个插件来源在当前策略下能不能加载 / 安装。
 * @param defaultMarketUrl 本机 backend.url 推出的市场 index 地址（未配置传 undefined）
 */
export function evaluatePluginOrigin(
  origin: PluginOrigin,
  defaultMarketUrl?: string,
): PluginOriginDecision {
  if (origin.kind === "builtin") return { allowed: true };
  if (!isPluginOriginLocked()) return { allowed: true };

  if (origin.kind !== "market") {
    return {
      allowed: false,
      reason: `企业策略只允许从企业插件市场安装插件，${origin.kind === "inline" ? "--plugin-dir" : "本地目录"}来源已被拒绝`,
    };
  }
  const url = normalizeMarketplaceUrl(origin.indexUrl);
  if (!url) return { allowed: false, reason: `市场地址不合法: ${origin.indexUrl}` };
  if (knownMarketplaces !== undefined) {
    return knownMarketplaces.includes(url)
      ? { allowed: true }
      : { allowed: false, reason: `市场 ${url} 不在企业策略 strictKnownMarketplaces 白名单内` };
  }
  const fallback = defaultMarketUrl ? normalizeMarketplaceUrl(defaultMarketUrl) : null;
  return fallback === url
    ? { allowed: true }
    : { allowed: false, reason: `市场 ${url} 不是本机 backend.url 对应的企业市场` };
}

/** 测试用：重置状态。 */
export function __resetPluginOnlyPolicy(): void {
  lockedSurfaces = new Set();
  knownMarketplaces = undefined;
}
