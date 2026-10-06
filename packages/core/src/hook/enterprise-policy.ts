/**
 * 企业策略门控
 * 支持 allowManagedHooksOnly（只允许企业管理的 Hook）和 disableAllHooks（禁用所有 Hook）
 */

import type { HookConfig } from "./types.ts";
import { ConfigSource, resolveHookTimeoutMs } from "./types.ts";

export interface EnterprisePolicy {
  disableAllHooks?: boolean;
  /** H27：只放行 Runtime（内部代码注册）与 Managed（企业托管配置）来源。Project 不算——它随 git clone 而来 */
  allowManagedHooksOnly?: boolean;
  allowedHookSources?: ConfigSource[];
  /**
   * 命令黑名单——**误用防呆，不是安全边界**：shell 等价写法（`cu''rl`、`$(echo curl)`）无穷，拦不住有意绕过。
   * 普通字符串按「命令词」匹配（前后是空白 / 分隔符 / 路径斜杠），`/.../` 包裹按正则匹配。
   */
  blockedCommands?: string[];
  /** URL 黑名单（子串匹配，同样是防呆） */
  blockedUrls?: string[];
  /** 单个 hook 允许的最大超时（**秒**，与 hook 的 timeout 同单位）。hook 未写 timeout 时按其实际缺省值判 */
  maxHookTimeout?: number;
}

/**
 * H12：EnterprisePolicy 的全部字段——从企业策略里摘 hook 门控字段的唯一清单。
 * 原先 app 层手写两个字段，另外四个永远到不了门控。新增字段时改这里，测试会比对它与 isHookAllowed 的实现。
 */
export const ENTERPRISE_HOOK_POLICY_KEYS = [
  "disableAllHooks",
  "allowManagedHooksOnly",
  "allowedHookSources",
  "blockedCommands",
  "blockedUrls",
  "maxHookTimeout",
] as const satisfies readonly (keyof EnterprisePolicy)[];

/** 从企业策略（PolicySettings）里摘出 hook 门控字段；一个都没配时返回 undefined（不装门控） */
export function pickHookPolicy(
  policy: Partial<Record<(typeof ENTERPRISE_HOOK_POLICY_KEYS)[number], unknown>> | null | undefined,
): EnterprisePolicy | undefined {
  if (!policy) return undefined;
  const out: Record<string, unknown> = {};
  for (const key of ENTERPRISE_HOOK_POLICY_KEYS) {
    const v = policy[key];
    // false / 空数组 / 0 都不构成限制，不进门控（与原先「两个布尔都 false 就不装门控」同口径）
    if (v === undefined || v === null || v === false || v === 0) continue;
    if (Array.isArray(v) && v.length === 0 && key !== "allowedHookSources") continue;
    out[key] = v;
  }
  return Object.keys(out).length > 0 ? (out as EnterprisePolicy) : undefined;
}

/** 正则转义 */
function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * H12：`blockedCommands` 单条判定。原先是裸 `includes`：`curl` 会误拦 `mycurlwrapper`、`echo hello-curl`。
 * 现在普通字符串要求左右是命令词边界（行首尾 / 空白 / `;&|()<>` / 引号 / 反引号，左侧另允许 `/`
 * 以命中 `/usr/bin/curl`）；`/pattern/` 是显式正则（与 matcher 的旧格式同写法），非法正则视为不命中。
 */
export function commandMatchesBlocked(command: string, blocked: string): boolean {
  if (!blocked) return false;
  if (blocked.length > 2 && blocked.startsWith("/") && blocked.endsWith("/")) {
    try {
      return new RegExp(blocked.slice(1, -1)).test(command);
    } catch {
      return false;
    }
  }
  const re = new RegExp(`(^|[\\s;&|()<>'"\`/])${escapeRegExp(blocked)}($|[\\s;&|()<>'"\`])`);
  return re.test(command);
}

/**
 * H28：内部 runtime hook——type=runtime 只能由内部代码 registerHook 注册（settings / 插件 schema
 * 都配不出这个类型），承载轨迹采集 / 遥测探针 / 会话指标。disableAllHooks 不关它们。
 */
export function isInternalRuntimeHook(entry: { config: HookConfig } | HookConfig): boolean {
  const config = "config" in entry ? entry.config : entry;
  return config.type === "runtime";
}

export class EnterprisePolicyGate {
  private policy: EnterprisePolicy;

  constructor(policy: EnterprisePolicy = {}) {
    this.policy = policy;
  }

  updatePolicy(policy: Partial<EnterprisePolicy>): void {
    this.policy = { ...this.policy, ...policy };
  }

  isHookAllowed(config: HookConfig): boolean {
    // H28：disableAllHooks 的本意是「不许跑任意脚本」，不是关掉内部可观测性（见 isInternalRuntimeHook）
    if (this.policy.disableAllHooks && !isInternalRuntimeHook(config)) return false;

    // H27：原先放行 Project。Project = 仓库内 .sid-code/settings.json，随 git clone 而来、
    // 有 push 权限的人（含外部 PR）都能改——而 hook 是任意代码执行，这正是 allowManagedHooksOnly 要关的口子。
    if (this.policy.allowManagedHooksOnly) {
      if (config.source !== ConfigSource.Runtime && config.source !== ConfigSource.Managed) {
        return false;
      }
    }

    if (this.policy.allowedHookSources && config.source) {
      if (!this.policy.allowedHookSources.includes(config.source)) {
        return false;
      }
    }

    if (config.type === "command" && this.policy.blockedCommands) {
      for (const blocked of this.policy.blockedCommands) {
        if (commandMatchesBlocked(config.command, blocked)) return false;
      }
    }

    if (config.type === "url" && this.policy.blockedUrls) {
      for (const blocked of this.policy.blockedUrls) {
        if (config.url.includes(blocked)) return false;
      }
    }

    // H12：原先 `&& config.timeout` 短路——不写 timeout 的 hook（实际跑 60s）整条绕过上限，是 fail-open；
    // 且直接拿原始数字比，runtime 曾按毫秒解释。现在两边都换算成毫秒，用实际生效的超时判定。
    // runtime 是内部可观测性 hook（H28 同口径），不受这条约束。
    if (
      typeof this.policy.maxHookTimeout === "number" &&
      this.policy.maxHookTimeout > 0 &&
      config.type !== "runtime"
    ) {
      if (resolveHookTimeoutMs(config) > this.policy.maxHookTimeout * 1000) return false;
    }

    return true;
  }

  get isDisabled(): boolean {
    return this.policy.disableAllHooks === true;
  }

  get isManagedOnly(): boolean {
    return this.policy.allowManagedHooksOnly === true;
  }
}
