/**
 * 「恒思考模型」判定 —— 服务端**不接受**关闭思考的模型。
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
 * ## 为什么改由注册表声明（2026-11-13）
 *
 * 此前这里是一份正则名单（`/^glm-5\.3\b/i`），当时的理由是「协议能力判定链不查注册表」。
 * 那份名单有三个问题：
 *
 * 1. **新增一个恒思考模型就要改一次代码**，而且改的是一处所有协议族共用的判定 —
 *    「恒思考」是模型事实，本该是数据；
 * 2. **与注册表分叉**：同一个模型的「有哪几档」写注册表、「能不能关」写代码，
 *    两处各说一半，新增模型时漏一处就是静默错；
 * 3. **网关改名命中不了**（`origin-glm-5.3`），只能靠 compat 兜。
 *
 * 现在注册表条目声明 `thinkingMode: "always-on"`，`lookupCatalog` 的模糊查找能命中带
 * 网关前缀 / 日期快照的名字（`origin-glm-5.3` / `glm-5.3-0815`），启动时不需要用户配置。
 * 新增恒思考模型 = 加一条数据。
 *
 * ## 为什么这里可以用模糊查找（而「发 disabled」不能）
 *
 * 两个方向判错的代价不对称：
 *
 * - 误判为「关不掉」→ 按最低档思考，请求成功，只是没省到；`effort` 字段若不被接受
 *   还有 `learnFromError` 的剥字段重试兜底；
 * - 误判为「能关」→ 服务端收到 `disabled` → **400 且零重试**，整轮对话失败。
 *
 * 所以这里偏向代价小的那一边。⚠ 但「关」该不该**发 `disabled`** 仍只认精确命中
 * （`thinking-off-wire.ts`）：那是往线上多发字段的方向，判错就是 400，规则反过来。
 *
 * ## 用户出口
 *
 * `settings.json` 的 `modelCompat.<渠道>.thinking_always_on` 仍可覆盖本判定
 * （两侧都用 `compat?.thinkingAlwaysOn ?? isThinkingAlwaysOn(model)` 口径）：
 * **用户显式声明 > 按名推导**。
 */

import { lookupCatalog } from "../model-params-catalog.ts";

/**
 * 该模型是否**不允许**关闭思考。
 *
 * @param model 模型**真名**（不是渠道别名）—— 与 `classifyProtocolFamily` 同口径。
 *   喂别名会静默 miss，与 `wire-model.ts:27`「能力判定必须吃真名」是同一条约束。
 *   ⚠ 注意这是「真名」而非「查注册表的键」：模糊查找负责把 `origin-glm-5.3` 对到
 *   `glm-5.3` 那条数据，调用方不需要自己剥前缀。
 */
export function isThinkingAlwaysOn(model: string): boolean {
  if (!model) return false;
  return lookupCatalog(model)?.thinkingMode === "always-on";
}
