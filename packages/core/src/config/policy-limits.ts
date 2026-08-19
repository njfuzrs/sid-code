/**
 * Policy Limits 功能开关
 * 企业策略可禁用特定功能（MCP、子代理、自定义命令等）
 * 提供统一的 isPolicyAllowed(feature) 检查函数
 *
 * ## 哪些 feature 真的接了线（改动前必读）
 *
 * 这个枚举列了 10 个 feature，但**只有 4 个由本模块真正把关**。
 * 剩下 6 个不是"忘了接"，各有实测出来的理由——照着枚举挨个补 `isPolicyAllowed`
 * 会制造重复门禁或恒零指标：
 *
 * | feature | 状态 |
 * |---|---|
 * | `mcp` / `sub_agent` / `custom_commands` / `extensions` | ✅ 本模块把关，见各自 gate 点 |
 * | `hooks` | ⛔ **已由 `hook/enterprise-policy.ts` 把关**（`disableAllHooks` / `allowManagedHooksOnly`，在 `registry.ts` 派发时过滤）。这里再加一道 = 两个开关管同一件事，管理员开了一个却只生效一半，比没有更难排查 |
 * | `bypass_permissions` / `auto_mode` | ⛔ **已由 `permission/mode-policy.ts` 把关**（`disabledModes` / `disableBypassPermissionsMode`），且那边有 fail-fast + 降级两层，比这里的裸布尔强 |
 * | `sandbox_bypass` | ⛔ **语义是反的**：沙箱默认**关**（`permission/sandbox.ts` 的 `enabled: false`），"绕过沙箱"是默认状态而非可调用的功能。真正有意义的是反向的"强制开启沙箱"，`allowed: boolean` 表达不了 |
 * | `file_upload` | ⛔ **无对应功能**。全仓没有用户文件上传；唯一沾边的是轨迹上传（那是遥测，不该挂这个名）与图片读取（语义不符） |
 * | `network_access` | ⛔ **无单一咽喉**。egress 散在 web 工具、MCP 远程传输、遥测上传、以及 LLM 请求本身（光 core 就 ~39 处 `fetch(`）。只关掉 web 工具却叫 `network_access`，是个兜不住的安全承诺 |
 */

import { getLogger } from "../debug/logger.ts";
import { recordDefenseTrigger } from "../telemetry/metrics/defense-metrics.ts";

/** 可控制的功能列表 */
export type PolicyFeature =
  | "mcp" // MCP 服务器
  | "sub_agent" // 子代理
  | "custom_commands" // 自定义斜杠命令
  | "hooks" // Hook 系统
  | "bypass_permissions" // always-allow 模式
  | "auto_mode" // 自动模式（dontAsk）
  | "extensions" // 扩展/技能
  | "file_upload" // 文件上传
  | "network_access" // 网络访问
  | "sandbox_bypass"; // 绕过沙箱

/** 功能开关状态 */
export interface PolicyLimitsState {
  limits: Record<string, { allowed: boolean; reason?: string }>;
}

/** 全局策略限制实例（单例） */
let globalPolicyLimits: PolicyLimitsState = { limits: {} };

/** 设置全局策略限制（从 PolicyManager 加载后调用） */
export function setPolicyLimits(
  limits: Record<string, { allowed: boolean; reason?: string }>,
): void {
  globalPolicyLimits = { limits };
  const log = getLogger();
  const disabled = Object.entries(limits)
    .filter(([, v]) => !v.allowed)
    .map(([k]) => k);
  if (disabled.length > 0) {
    log.info("POLICY_LIMITS", `已禁用功能: ${disabled.join(", ")}`);
  }
}

/**
 * 检查功能是否被策略允许。
 *
 * ⚠️ **这是个会产生副作用的"查询"**：被拒绝时会记一条 metric。
 * 之所以能这么做，是因为本函数只在**真正的 gate 点**被调用（每个 feature 一处，
 * 见文件头那张表），不是每次操作都跑的热路径谓词。
 * 若日后有人把它塞进循环里高频调用，请连同这里的 metric 一起重新考虑——
 * 那时它记的就不再是"防线拦了几次"，而是"这个函数被调了几次"。
 */
export function isPolicyAllowed(feature: PolicyFeature | string): boolean {
  const limit = globalPolicyLimits.limits[feature];
  if (!limit) return true; // 未配置 = 允许
  if (!limit.allowed) {
    recordDefenseTrigger("policy_limits", "blocked", {
      feature: String(feature),
      ...(limit.reason ? { reason: limit.reason } : {}),
    });
  }
  return limit.allowed;
}

/** 获取功能被禁用的原因 */
export function getPolicyDenialReason(feature: PolicyFeature | string): string | undefined {
  const limit = globalPolicyLimits.limits[feature];
  if (!limit || limit.allowed) return undefined;
  return limit.reason || `功能 "${feature}" 已被企业策略禁用`;
}

/** 获取所有被禁用的功能 */
export function getDisabledFeatures(): string[] {
  return Object.entries(globalPolicyLimits.limits)
    .filter(([, v]) => !v.allowed)
    .map(([k]) => k);
}

/** 重置策略限制（测试用） */
export function resetPolicyLimits(): void {
  globalPolicyLimits = { limits: {} };
}
