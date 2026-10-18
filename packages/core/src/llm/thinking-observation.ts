/**
 * 思考开关观测口径（遗留清单 R1 / R5 / R6 / R10）—— BilledRequest 上 thinking_* 字段的唯一算法。
 *
 * 修前 BilledRequest 只有 `thinking_wire` / `thinking_in_response` / `thinking_intent`（布尔）三个字段，
 * digest 拿「意图 false」当分母，于是：
 *   - R1：OpenAI 族恒思考（GLM-5.3、compat `thinking_always_on`）的 off 被降级成不下发，线上标
 *     `omitted`，绕过了只拦 enabled/adaptive 的「关不掉」桶，「关不掉」被记成「泄漏」；
 *     无开关族（gpt-5.x / kimi）同理；
 *   - R6：auto 在默认关的模型上解析成 false，混进「意图关」分母。
 * 所以补三个字段：`thinking_setting`（三态，auto 不再伪装成 off）、`thinking_control`（分母只取
 * toggle）、`thinking_shown` + `thinking_wire_thinks`（R10「展示≠实发」）。
 *
 * 取数优先级：调用方写的 `params.thinkingObservation`（主循环，与 BeforeModel 同一个 cap）>
 * provider 出口按**真名**现算（side-call / 子代理 / fork 不经 loop）。现算与主循环吃同一个
 * `resolveEffortCapability`，口径不分叉。
 */

import { resolveEffortCapability, resolveThinkingState, type ThinkingControl } from "./effort.ts";
import type { SendParams } from "./types.ts";

export type ThinkingWireLabel = "enabled" | "adaptive" | "disabled" | "omitted";

/**
 * 线上实发是否意味着「服务端在思考」。展示 == 实发不变量的测试与 digest 共用这一份（R10）。
 *
 * - enabled / adaptive → 是；disabled → 否；
 * - omitted：locked-on 恒是；否则看「不发 = 什么」（`omitMeans`，Anthropic 协议取注册表**精确命中**的
 *   `thinkingOmitMeans`，缺省即旧 Claude 语义 off）；给不出就返回 undefined —— OpenAI 族不发时
 *   服务端默认因模型而异，我们手里没有可靠数据，**不猜**，交 digest 记为「不可判」。
 */
export function wireThinks(
  wire: ThinkingWireLabel,
  control: ThinkingControl | undefined,
  omitMeans: "on" | "off" | undefined,
): boolean | undefined {
  if (wire === "enabled" || wire === "adaptive") return true;
  if (wire === "disabled") return false;
  if (control === "locked-on") return true;
  return omitMeans === undefined ? undefined : omitMeans === "on";
}

/** 调用方没写 `thinkingObservation.setting` 时的推断：只认显式表达，不反推 auto。 */
function inferSetting(params: SendParams): "on" | "off" | "auto" | undefined {
  if (params.thinkingObservation?.setting) return params.thinkingObservation.setting;
  if (params.thinkingIntent) return params.thinkingIntent.thinking ? "on" : "off";
  // side-call 的 SIDE_CALL_NO_THINK；enabled:true 不反推（恒思考模型上可能是被强制的）
  return params.thinking?.enabled === false ? "off" : undefined;
}

/** BilledRequest 上的观测字段（provider 出口直接展开进 recordBilledRequest）。 */
export interface ThinkingObservationFields {
  thinkingSetting?: "on" | "off" | "auto";
  thinkingControl?: ThinkingControl;
  thinkingShown?: boolean;
  thinkingWireThinks?: boolean;
}

/**
 * 算出本次 fetch 的观测字段。纯内存，失败时返回空对象（观测绝不影响请求）。
 *
 * @param wireModel 发往线上的真名（能力判定吃真名，喂别名会静默 miss）
 * @param omitMeans 本协议下「不发 thinking = 什么」；OpenAI 族传 undefined
 */
export function observeThinking(
  params: SendParams,
  opts: {
    wireModel: string;
    provider: string;
    baseURL?: string;
    wire: ThinkingWireLabel;
    omitMeans: "on" | "off" | undefined;
  },
): ThinkingObservationFields {
  try {
    const obs = params.thinkingObservation;
    const setting = inferSetting(params);
    let control = obs?.control;
    let shown = obs?.shown;
    if (control === undefined || (shown === undefined && setting !== undefined)) {
      const cap = resolveEffortCapability({
        model: opts.wireModel,
        provider: opts.provider,
        baseURL: opts.baseURL,
        alias: params.model,
      });
      control ??= cap.thinkingControl;
      if (shown === undefined && setting !== undefined) {
        shown = resolveThinkingState(cap, setting === "auto" ? undefined : setting, null).effective;
      }
    }
    const thinks = wireThinks(opts.wire, control, opts.omitMeans);
    return {
      ...(setting !== undefined && { thinkingSetting: setting }),
      ...(control !== undefined && { thinkingControl: control }),
      ...(shown !== undefined && { thinkingShown: shown }),
      ...(thinks !== undefined && { thinkingWireThinks: thinks }),
    };
  } catch {
    return {};
  }
}
