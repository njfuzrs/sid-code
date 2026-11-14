/**
 * 「关思考」在**关不掉思考**的模型上应下发的强度档 —— 单一判定入口。
 *
 * ## 为什么需要它（2026-11-13 恒思考模型 `/think off` 排查）
 *
 * sid-code 表达「我想省」只有一种说法：`thinking.enabled = false`（`/think off` 与全部
 * side-call 的 `SIDE_CALL_NO_THINK`）。对**能关**思考的模型它被翻译成
 * `thinking:{type:"disabled"}`；对**关不掉**的模型，各层此前只做到「别发会 400 的值」——
 *
 * - side-call 什么都不发（`openai.ts` 的 `alwaysThinking` 分支），服务端按默认档跑，
 *   GLM-5.3 的默认档是 `max`：用户敲 `/think off` 想省，结果**比不敲更贵**；
 * - 主循环有些族干脆当没听见（Kimi K3 / Grok / o-series 没有思考开关字段）；
 * - Anthropic 恒思考族「关也按低 effort 下发」只写在注释里，代码里从没实现过。
 *
 * 没有任何一层回答「那该发什么」。两只官方文档给的是同一个答案：
 * **开着思考，把强度压到最低档**（GLM 迁移建议 `off → low`；Anthropic 恒思考 400 的
 * 报错文本直接写「Use thinking.type.adaptive and output_config.effort」）。
 *
 * ## 规则进代码，模型事实进数据
 *
 * 本文件**不出现任何模型名**：能不能关、有哪几档由注册表声明
 * （`thinkingMode` / `reasoningEffortValues`），这里只写一条通用规则。
 * 新增恒思考模型 = 加一条数据，不改代码（防耦合门禁见
 * `packages/core/tests/llm/thinking-off-floor.test.ts` 的源码静态扫描）。
 *
 * ## 返回 undefined 的四种情形（都维持现状，不猜）
 *
 * - 模型**能**关思考（`thinkingMode` 不是 `always-on`）：关就该发 `disabled`，不兜底；
 * - 数据不知道它关不关（注册表查不到）：猜错的两个方向代价不对称，宁可不动；
 * - **没有档位表**（`reasoningEffortValues` 缺失）：不知道最低档是哪个，不编；
 * - compat 声明 `supports_reasoning_effort: false`：这条渠道不认强度字段。
 *
 * 「可选但没数据」的第三种最容易漏：`reasoningEffortValues` 是**手写**的。
 * 新增恒思考模型时只补 `thinkingMode` 会静默退回「什么都不发」，与本次要修的现象一模一样。
 */

import type { ModelCompat } from "../model-compat.ts";
import { lookupCatalog } from "../model-params-catalog.ts";
import { isThinkingAlwaysOn } from "./always-thinking.ts";
import type { DialectEffortLevel } from "./types.ts";

/**
 * 统一档位标度（升序）。
 *
 * 与 `effort.ts` 的 `EFFORT_LEVELS`、`model-capability-filter.ts` 的私有 `EFFORT_SCALE`
 * 同序，但**不 import** 它们：线格式层不能反向依赖能力层（`effort.ts` 依赖 `dialect/`），
 * 而那一份是模块私有常量。三处同序由测试锁住。
 *
 * 按标度而不是按数组下标取「最低档」：注册表里的 `reasoningEffortValues` 是手写的，
 * 书写顺序没有语义。GLM-5.3 登记成 `["low","high","max"]`，Kimi K3 登记成
 * `["low","high","max"]` 但将来可能写成 `["max","low"]` —— 按下标取会发 `max`，
 * 正好与「想省」相反。
 */
const EFFORT_SCALE: readonly DialectEffortLevel[] = ["low", "medium", "high", "xhigh", "max"];

/**
 * 判定「关思考」在关不掉思考的模型上应下发的强度档。
 *
 * @param model 模型**真名**（`pickWireModel` 的结果），不是渠道别名 —— 与
 *   `isThinkingAlwaysOn` / `classifyProtocolFamily` 同口径，喂别名会静默 miss。
 * @param compat 用户对该渠道/别名的显式声明。**优先级最高**：`supportsReasoningEffort:
 *   false` 时不兜底，「这条路由不吃 effort」是运行时事实，不是模型属性。
 * @returns 最低档；`undefined` = 不兜底，调用方维持原有下发。
 */
export function thinkingOffEffortFloor(
  model: string,
  compat?: ModelCompat,
): DialectEffortLevel | undefined {
  if (compat?.supportsReasoningEffort === false) return undefined;
  if (!(compat?.thinkingAlwaysOn ?? isThinkingAlwaysOn(model))) return undefined;
  const values = lookupCatalog(model)?.reasoningEffortValues;
  return EFFORT_SCALE.find((level) => values?.includes(level));
}
