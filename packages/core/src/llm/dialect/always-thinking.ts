/**
 * 「恒思考模型」名单 —— 服务端**不接受**关闭思考的模型。
 *
 * ## 为什么需要这一层（2026-08-17 GLM-5.3 会话实证）
 *
 * `DialectFlags.supportsThinkingToggle` 是**族级**常量：GLM 族声明 `true`，因为
 * GLM-4.5 / 5.1 / 5.2 都能用 `thinking:{type:"disabled"}` 关思考。但 **GLM-5.3 恒思考**，
 * 对它下发 `disabled` 会被服务端直接 400：
 *
 * ```
 * 400 {"error":{"message":"该模型始终思考，不支持关闭思考；请使用 low、high 或 max。"}}
 * ```
 *
 * 而全部 side-call（压缩 / 目标评估 / 工具分类 / 记忆召回，共 14 个调用点）都无条件
 * 套用 `SIDE_CALL_NO_THINK = { enabled: false }`，于是**每一次 side-call 都必然 400**，
 * 且分类为 `TerminalError("invalid_request")` → **零重试**，直接"主 Provider 失败且无
 * 可用 fallback"。实测一次会话里 11 次真实请求全灭。
 *
 * ## 为什么是「名单」而不是「版本外推」
 *
 * 不写 `>= 5.3 即恒思考` 这类版本比较：本仓已记录过版本外推的教训（外推出来的数值
 * 没有任何事实依据，而且错了不会报错、只会静默发错请求）。名单里每一条都对应一次
 * **实测到的 400**，加新条目的门槛就是"你见过它报这个错"。
 *
 * ## 为什么不放进 `model-registry.ts`
 *
 * 协议能力判定链**根本不查注册表**（`classify.ts:85` 的 `/^glm/i` 正则兜底），
 * 未注册模型照样能拿到正确的族。往注册表加条目治不了这个 bug，
 * 而且 GLM-5.3 的注册属于另一份文档（模型元数据体系）的范围。
 *
 * ## 用户出口
 *
 * 企业网关常把模型改名（`origin-glm-5.3`、`glm53-prod`），这里的 `^glm-5\.3` 匹配不到。
 * 那种情况下用 `settings.json` 的 `modelCompat.<渠道>.thinking_always_on: true` 显式声明
 * —— 与 compat 的一贯语义一致：**用户显式声明 > 按名推导**。
 */

/**
 * 恒思考模型的名称模式。
 *
 * ⚠ 每条都必须对应一次**实测到的服务端拒绝**，不要按"应该也是"添加。
 * 锚 `^` 与 `classify.ts` 的族判定正则同口径（都吃真名、都从头匹配）；
 * 带网关前缀的改名模型走 compat 显式声明，不在这里放宽锚点 ——
 * 放宽会让 `xxx-glm-5.3-nonthinking` 这类名字被误命中。
 */
const ALWAYS_THINKING_PATTERNS: readonly RegExp[] = [
  // GLM-5.3：2026-08-17 会话 `20260817-135824-fcf863e1` 实测 11 次 400。
  // `\b` 让 `glm-5.3` / `glm-5.3-flash` 命中，而 `glm-5.30` 不命中。
  /^glm-5\.3\b/i,
];

/**
 * 该模型是否**不允许**关闭思考。
 *
 * @param model 模型**真名**（不是渠道别名）—— 与 `classifyProtocolFamily` 同口径。
 *   喂别名会静默 miss，与 `wire-model.ts:27`「能力判定必须吃真名」是同一条约束。
 */
export function isThinkingAlwaysOn(model: string): boolean {
  if (!model) return false;
  return ALWAYS_THINKING_PATTERNS.some((re) => re.test(model));
}
