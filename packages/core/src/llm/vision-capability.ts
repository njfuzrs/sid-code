/**
 * 模型是否接受图片输入（vision）—— 按**模型**判定的单一事实源。
 *
 * ## 为什么不能按 provider 判
 *
 * 此前能力挂在 provider 上：`OpenAIProvider.capabilities().vision` 写死 `false`，
 * `openai-tool-result-content.ts` 见到图片一律降级成「你看不到这些内容」的文字说明。
 * 而同一个 OpenAI 兼容 provider 下，`deepseek-flash`（V4.1-Flash）支持图片、
 * `deepseek-v4-pro` 不支持（deepseek-api.md:1831）——provider 粒度一刀切，
 * 支持图片的模型也看不到图，用户收到的是「当前 provider 不支持图片回传」，真因是我们没发。
 * 实测会话 20261009-135641-0083c051：三次 Read 读图全部被降级。
 *
 * ## 三层判定（与 reasoning_content 回传判据同一形态）
 *
 * 1. `compat.supportsVision`（用户对这条渠道的显式声明，按别名查）—— 最高权威。
 *    企业网关上的私有模型名注册表必然匹配不到，只有用户知道它认不认图。
 * 2. `model-registry.ts` 的 `supportsVision`（按真名匹配内置注册表）。
 * 3. 都没有声明 → `undefined`，由调用方按协议族决定缺省（见下）。
 *
 * ## 缺省为什么两族相反
 *
 * - OpenAI 兼容路径缺省**不发图**：OpenAI 规范的 tool message 只允许 text part
 *   （openapi.yaml `ChatCompletionRequestToolMessageContentPart`），带图发给不认的模型 → 400；
 *   降级成文字说明虽然看不到图，但至少不会让整轮请求失败。
 * - Anthropic 原生路径缺省**发图**：Claude 全系都支持图片输入，这是既有行为，
 *   只有显式声明 `false`（如走 Anthropic 兼容端点的 `deepseek-v4-pro`）才降级。
 */

import { lookupModelCompat } from "./model-compat.ts";
import { lookupRegistry } from "./model-registry.ts";

/**
 * 查模型是否支持图片输入。返回 `undefined` 表示「没有任何一层声明」，
 * 调用方必须按协议族缺省处理，**不能**当 false。
 *
 * @param wireModel 真名（发给服务端的模型名），用于按名匹配注册表
 * @param alias 本地别名（`params.model`），用于查用户 compat 声明
 */
export function resolveVisionSupport(wireModel: string, alias?: string): boolean | undefined {
  const declared = lookupModelCompat(alias)?.supportsVision;
  if (declared !== undefined) return declared;
  // 别名与真名不同时，别名本身也可能就是用户写的真名形态（未配 wireModel 的常态），两个都查。
  const byWire = lookupRegistry(wireModel)?.supportsVision;
  if (byWire !== undefined) return byWire;
  if (alias && alias !== wireModel) return lookupRegistry(alias)?.supportsVision;
  return undefined;
}
