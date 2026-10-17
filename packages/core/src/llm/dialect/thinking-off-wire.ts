/**
 * Anthropic 协议线上「关思考」怎么写 —— 单一判定入口。
 *
 * ## 为什么需要这一层（20261016 思考开关排查 D1 / D2 / D3）
 *
 * 旧实现把「关」一律写成**不发 `thinking` 字段**（`anthropic.ts` 的
 * `params.thinking?.enabled && buildThinkingParam(params)`）。这只对「不传 = 不思考」的
 * 旧 Claude 成立。5 一代（Opus 5 / Sonnet 5 / Haiku 5.5）与 DeepSeek 的 Anthropic 兼容端点
 * **不传 = 思考**，于是 `/think off`、`SID_CODE_THINKING=off` 与全部 side-call 的
 * `SIDE_CALL_NO_THINK` 在它们身上都是空操作：状态栏说关，模型照样在想。
 * 实测 Sonnet 5 side-call 不发字段 → 返回 151 字符思考、耗时 17.2 s。
 *
 * 判定放在线格式层而不是各族 applier：side-call 根本不经过 applier，只有这一层是所有
 * 请求的咽喉。
 *
 * ## 三种结局
 *
 * | 条件 | 线上 |
 * | --- | --- |
 * | 注册表**精确命中**且 `thinkingOmitMeans === "on"`、非恒思考 | `{type:"disabled"}` |
 * | DeepSeek Anthropic 兼容端点（按族判，不依赖注册表键） | `{type:"disabled"}` |
 * | 其余（恒思考、旧 Claude、未注册、仅模糊命中） | 不发（现状） |
 *
 * 恒思考模型不发：Sonnet 5.5 发 `disabled` 实测 400，Opus 5.5 / Fable 5.1 发了 200 但照样思考。
 * 两种结局都不是「关」，不发是唯一不会让请求失败的写法。
 *
 * ## 为什么只认精确命中
 *
 * `lookupRegistry` 的模糊匹配第 1 级是「key 之后跟 `-` 即命中」：加了 `claude-opus-5` 键之后，
 * `claude-opus-5-6` / `claude-opus-5-20261101` 这类**还不存在**的模型全部会命中它，继承
 * `thinkingOmitMeans:"on"` → 发 `disabled`。而 5.5 一代全是恒思考，若下一个小版本也是，
 * `off` 与全部 side-call 都会 400。这是从模糊匹配后门进来的版本外推。
 * 不知道就不猜：未精确命中一律按「未注册」处理，保持不发。
 *
 * 没有 400 自愈：Anthropic 路径没有可复用的自愈机制（排查文档 §8.7）。代价是注册表写错时
 * 用户吃一次响亮的 400，范围被精确匹配限定在人手写下的那几个键。
 */

import { lookupRegistryExact } from "../model-registry.ts";
import { classifyProtocolFamily } from "./classify.ts";

/** 关思考时线上的写法：显式 `disabled`，或不发字段（服务端默认）。 */
export type ThinkingOffWire = "disabled" | "omit";

/**
 * 判定「关思考」在 Anthropic 协议线上怎么写。
 *
 * @param model 模型**真名**（`pickWireModel` 的结果），不是渠道别名 —— 与 `classify.ts`
 *   同一条「能力判定必须吃真名」的约束，喂别名会静默 miss 退回「不发」。
 * @param baseURL 端点 URL，用于识别 DeepSeek 的 Anthropic 兼容端点。
 */
export function thinkingOffWire(model: string, baseURL?: string): ThinkingOffWire {
  if (!model) return "omit";

  const exact = lookupRegistryExact(model);
  if (exact) {
    // 恒思考模型关不掉；注册表里的恒思考条目不会同时标 "on"，这里再挡一次防写错。
    if (exact.thinkingMode === "always-on") return "omit";
    if (exact.thinkingOmitMeans === "on") return "disabled";
  }

  // DeepSeek 经 Anthropic 兼容端点：deepseek-api.md「思考模式开关」Anthropic 格式一栏
  // 写明 `{"thinking":{"type":"enabled/disabled"}}`，脚注「思考模式默认打开」。
  // 按端点族判，注册表里 DeepSeek 条目不声明端点。
  if (classifyProtocolFamily({ model, provider: "anthropic", baseURL }) === "deepseek-anthropic") {
    return "disabled";
  }

  return "omit";
}
