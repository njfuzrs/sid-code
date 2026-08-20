/**
 * OpenAI Provider 实现
 * 使用 fetch + SSE 流式解析
 *
 * 消息格式转换规则（sid-code 内部格式 → OpenAI API 格式）：
 * - assistant 消息中的 tool_use 块 → 顶层 tool_calls 字段
 * - user 消息中的 tool_result 块 → 独立的 role:"tool" 消息
 * - 纯文本消息 → content 为字符串
 */

import type { Provider, ProviderCapabilities } from "./provider.ts";
import type {
  SendParams,
  StreamEvent,
  Message,
  Usage,
  AccumulatedResponse,
  ContentBlock,
  ToolDefinition,
} from "./types.ts";
import { getLogger } from "../debug/logger.ts";
import {
  emitStreamPhase,
  emitTimeoutFired,
  updateStreamStats,
  emitStreamStall,
  armIneffectiveCheck,
  emitHttpConnected,
  cacheDimsFor,
} from "../trace/stream-observer.ts";
import { guardOutgoingMessages } from "./protocol-sentinel.ts";
import { createStreamLifecycle, LIFECYCLE_PRESETS } from "./stream-lifecycle.ts";
import type { StreamTelemetrySignal } from "./types.ts";
import { filterParamsForModel } from "./model-capability-filter.ts";
import { pickWireModel } from "./wire-model.ts";
import { lookupCatalog } from "./model-params-catalog.ts";
import { lookupModelCompat } from "./model-compat.ts";
import {
  classifyProtocolFamily,
  getDialectWire,
  getToolSchemaDialect,
  isChatCompletionsFamily,
  isThinkingAlwaysOn,
  sanitizeToolSchema,
} from "./dialect/catalog.ts";
import {
  learnFromError,
  shouldRetryWithoutEffort,
  recordEffortRejected,
} from "./model-capabilities.ts";
// 状态码提取（非流式自愈的结构判据用）——兼容 status / statusCode / response.status 多种形态
import { extractHTTPStatus } from "../api/error-utils.ts";
import { splitSystemByDynamicBoundary } from "../api/cache-strategy.ts";
import { updateRateLimitStatus } from "../api/rate-limit.ts";
import { recordRequestId } from "../api/request-id.ts";
import { estimateTextTokens } from "../context/token.ts";
import { sanitizeStrings } from "./sanitize-unicode.ts";
import { getKeepAliveFetchOptions } from "./keepalive.ts";
import { serializeToolResultContentForOpenAI } from "./openai-tool-result-content.ts";
import { SseChunkDumper, currentSseDumpContext } from "./sse-chunk-dumper.ts";
// PR9：parseSSE 的字节级判据（idle timer / contentElapsed）统一扣除休眠。
import {
  createSleepAwareDeadline,
  startSleepObserver,
  getSleepLedger,
} from "@sid-code/shared/utils/sleep-detect.ts";
import {
  resolveHeaderTimeoutMs,
  resolveProviderStreamTimeouts,
} from "../config/network-profile.ts";
import { buildResponsesRequest } from "./openai-responses-request.ts";
import {
  parseResponsesStream,
  parseResponsesBody,
  isResponsesContentProgress,
  type ResponsesNonStreamingBody,
} from "./openai-responses.ts";
import { extractInternalEnTags } from "../config/prompt-lang.ts";
import { extractOpenAICacheHit, extractOpenAIReasoningTokens } from "./openai-usage.ts";

/**
 * 从纯文本中提取内联 <think>...</think> 标签为独立的 thinking 内容。
 * 部分 OpenAI 兼容模型（GPT-5.4、QwQ 等）以内联标签而非结构化字段返回思考过程。
 * 若不提取，标签会作为普通文本泄漏到 TUI。
 *
 * 返回 { thinking, text }：thinking 为提取的思考内容（可能为空），
 * text 为剥离 think 标签后的剩余正文（可能为空）。
 */
function extractInlineThinkTags(content: string): { thinking: string; text: string } {
  // 匹配 <think>...</think>（支持多行，贪婪匹配单个最外层块）
  // 通常 think 标签出现在文本开头，且只有一个块
  const thinkRegex = /^[\s]*<think>([\s\S]*?)<\/think>/;
  const match = content.match(thinkRegex);
  if (!match) {
    return { thinking: "", text: content };
  }
  const thinking = match[1]?.trim() ?? "";
  const text = content.slice(match[0].length).trim();
  return { thinking, text };
}

/**
 * usage 提取器已抽到 `openai-usage.ts`（单一事实源），此处 re-export 保持既有导入面。
 *
 * 抽走的原因：`openai-responses.ts` 也要用同一套提取器，而本文件已 import 它，
 * 反向 import 会成环 —— 于是 Responses 路径长期自己只映射 input/output 两个字段，
 * 缓存命中与 reasoning 全族漏采（详见 `openai-usage.ts` 头注释）。
 */
export { extractOpenAICacheHit, extractOpenAIReasoningTokens } from "./openai-usage.ts";

/** 工具调用追踪状态（用于 SSE 流中多工具并行解析） */
interface ToolCallState {
  id: string;
  name: string;
  arguments: string;
  contentIndex: number; // 对应的 content block 索引
}

/**
 * 响应头超时（纵深防御，针对 fdb47f30 index 23 hang 根因）。
 *
 * 背景：`await fetch(...)` 只挂了外层 signal，自身无连接/响应头超时；SSE 的 idle
 * 超时（IDLE_TIMEOUT_MS）只在拿到 `response.body` 进入 parseSSE 后才生效。若请求挂在
 * "请求体已发出、等响应头"阶段，idle 超时不覆盖此处，只能依赖 fallback 的 5min 整体
 * 超时——而后者经 `unref()` + `AbortSignal.any` 传播，存在被运行时缝隙吞掉的风险
 * （fdb47f30 实测卡死远超 5min 仍未自愈）。
 *
 * 故此处加一道**本地、不依赖外层 signal 传播**的超时：fetch 自身用一个独立的
 * AbortController，到点直接 abort 这个 controller —— 即使外层 signal 永远不 fire，
 * 本地超时也能把 hang 转成可重试的 timeout 错误，让 fallback 走重试/降级。
 *
 * DeepSeek 大上下文首字节慢 → 给 120s；其他模型 → 60s。仍小于 fallback 的 5min 整体
 * 超时，确保响应头阶段的 hang 优先由这道更近的防线拦截。
 */
/**
 * 暴露 header timeout 阈值（首字节超时）。委托统一配置 network-profile.ts，
 * 保证 provider 的 fetch 级 header 超时 与 loop.ts 看门狗的 header 兜底阈值一致
 * ——否则 fetch 会在看门狗阈值之前先把连接杀掉，放宽看门狗形同虚设。
 * 不再按模型分档（deepseek/default）：统一的宽松默认值对所有模型都成立。
 * 支持 SID_CODE_RESPONSE_HEADER_TIMEOUT_MS 环境变量覆盖。
 * 保留 model 参数仅为兼容既有调用点签名，内部不再使用。
 */
export function getHeaderTimeoutMs(_model?: string): number {
  return resolveHeaderTimeoutMs();
}

export class OpenAIProvider implements Provider {
  private apiKey: string;
  private baseURL: string;
  private _model: string;

  constructor(apiKey: string, model: string, baseURL?: string) {
    this.apiKey = apiKey;
    this.baseURL = baseURL || "https://api.openai.com/v1";
    this._model = model;
  }

  name(): string {
    return "openai";
  }

  capabilities(): ProviderCapabilities {
    return {
      streaming: true,
      tools: true,
      thinking: false, // OpenAI 的 o1/o3 有内置推理，但接口不同
      // §3.4：诚实能力。模型（GPT-4o）确实支持图片，但 sid-code 内部 ContentBlock
      // 目前无 image 变体、convertMessages 也无 image → image_url content part 的转换，
      // 即没有任何上游路径能把图片喂进来。在补齐多模态管线前如实声明 false，避免能力虚标。
      vision: false,
      promptCaching: false,
      parallelToolCalls: true,
    };
  }

  /**
   * 判断模型是否为 OpenAI o-series 推理模型（o1/o3/o4...）。
   * o-series 协议差异：
   *   - system 消息须用 `developer` role（§3.1）
   *   - 须用 `max_completion_tokens`，`max_tokens` 已废弃且不兼容（§3.2）
   * 仅对官方端点的 o-series 生效；第三方兼容端点（deepseek/ollama 等）模型名不命中，保持旧行为。
   */
  private isReasoningModel(model: string): boolean {
    return /^o[0-9]/.test(model);
  }

  /**
   * 指定模型在多轮工具调用时是否要求回传 reasoning_content（方案⓪真因修复）。
   *
   * 判据取自 model-registry 的 requiresReasoningContentForToolCalls 能力标志：
   *   - DeepSeek V4 thinking 系 → true（tool-call 轮必回传，否则 400 + 思维链断裂）
   *   - 旧 deepseek-reasoner → false（回传会触发旧协议 400）
   *   - 未知模型 / 无 reasoning 概念 → false（保守：仅无 tool_calls 时回传，维持旧行为）
   *
   * ⚠️ 必须按**本次请求实际发往的模型**判定，而非构造时固化的 this._model：
   * fallback 链切换模型后（fallback.ts 构造 `{ ...params, model: fallbackModel }`，
   * 但 provider 仍用主模型名构造），this._model 与 params.model 会分裂。若用 this._model，
   * 主/备模型的回传规则不同（V4 必回传 vs 旧 reasoner 禁回传）时会错发/漏发 → 400 或思维链断裂。
   */
  private requiresReasoningContentForToolCalls(model: string, alias?: string): boolean {
    // 用户 compat 声明优先：注册表按模型名前缀/家族匹配，私有网关上的私有模型名
    // （如 gw-internal-r1）必然 miss → 落到默认 false。而这个字段两个方向都会错且
    // **自愈救不回来**（回传缺失 → 400 + 思维链断裂；旧协议多回传 → 也 400），
    // 故必须给用户一个显式出口。按渠道（别名）查，与 model 吃真名互补。
    const declared = lookupModelCompat(alias)?.requiresReasoningContentForToolCalls;
    if (declared !== undefined) return declared;
    return lookupCatalog(model)?.requiresReasoningContentForToolCalls === true;
  }

  /**
   * 把工具定义转成 Chat Completions 的嵌套 `function` 格式，并按族方言清理 schema。
   *
   * 流式与非流式两条路径共用（此前两处各手写一遍同样的 `.map()`——本仓「同一转换写两遍」
   * 有多次漂移前科，`markLastUserMessageCacheBreakpoint` 就是同一原因收敛的）。
   *
   * ## 为什么这条线只剥元信息键、不打 strict
   *
   * `registry.ts:79` 给 40 个内置工具打了 `strict: true`，但**本文件全文零 `strict` 命中**
   * ——这条线从来不下发它。要接线需同时决定 DeepSeek 的 `/beta` base_url 切换
   * （strict 在 DeepSeek 上是 beta 端点专属），那是改渠道行为，且 DeepSeek 官方仓有
   * strict 吐畸形 JSON 的未闭 issue。**开关是独立一件事，不混在本次改动里**——
   * 混了就同时改了「schema 形状」与「发不发 strict」两个变量，出问题分不清是谁。
   *
   * 故这里传 `strict: false`：只剥 `$schema` 这类 zod 无条件注入、五家都不认的元信息键
   * （实测 40 份 schema 合计 ~570 token/轮，且常驻 prompt cache 工具区前缀）。
   * 依据见 `dialect/tool-schema.md`。
   */
  private static convertTools(model: string, tools?: ToolDefinition[]) {
    if (!tools) return undefined;
    const dialect = getToolSchemaDialect(classifyProtocolFamily({ model }));
    return tools.map((t) => ({
      type: "function",
      function: {
        name: t.name,
        description: t.description,
        parameters: sanitizeToolSchema(t.input_schema, dialect, { strict: false }).schema,
      },
    }));
  }

  /**
   * 把内部 toolChoice 翻译为 OpenAI `tool_choice` 字段格式（§4.2）。
   *   "auto"/"none"/"required" → 同名字符串
   *   { name } → { type: "function", function: { name } }
   * 返回 undefined 表示不下发（沿用服务端默认）。
   */
  private static toToolChoice(
    tc: SendParams["toolChoice"],
  ): string | { type: "function"; function: { name: string } } | undefined {
    if (tc == null) return undefined;
    if (typeof tc === "string") return tc;
    return { type: "function", function: { name: tc.name } };
  }

  /**
   * 把 OpenAI finish_reason 映射为 sid-code 内部 stop_reason（§4.4）。
   * 规范枚举 5+1 值：stop / length / tool_calls / content_filter / function_call
   *   + insufficient_system_resource（DeepSeek 特有，deepseek-api.md:2094）。
   *   - tool_calls / function_call → tool_use
   *   - length → max_tokens
   *   - content_filter → content_filter（不再误并入 end_turn，掩盖内容审查）
   *   - insufficient_system_resource → insufficient_system_resource（保留原值，
   *     供上层 queryLoop 识别为可重试异常触发 fallback 重试链）
   *   - stop / 其它 → end_turn
   */
  private static mapFinishReason(finishReason: string | null | undefined): string {
    switch (finishReason) {
      case "tool_calls":
      case "function_call":
        return "tool_use";
      case "length":
        return "max_tokens";
      case "content_filter":
        return "content_filter";
      case "insufficient_system_resource":
        return "insufficient_system_resource";
      default:
        return "end_turn";
    }
  }

  /**
   * 解析响应头超时阈值（ms）。DeepSeek 首字节慢 → 更长；其他模型更短。
   * 支持 SID_CODE_RESPONSE_HEADER_TIMEOUT_MS 环境变量覆盖（运维调参 / 测试注入），
   * 非法值（非正整数）忽略，回退到按模型区分的默认值。
   */
  private static resolveHeaderTimeoutMs(model: string): number {
    return getHeaderTimeoutMs(model);
  }

  /**
   * PARSE-4：估算请求的 prompt token 数（仅在端点未返回 usage 时兜底）。
   * 把 system + 全部消息内容（文本 / tool_use 入参 JSON / tool_result）拼起来字符级估算。
   */
  private static estimatePromptTokens(params: SendParams): number {
    let text = "";
    if (typeof params.system === "string") text += params.system + "\n";
    for (const msg of params.messages) {
      for (const block of msg.content) {
        if (block.type === "text") text += block.text + "\n";
        else if (block.type === "tool_use") text += JSON.stringify(block.input) + "\n";
        else if (block.type === "tool_result") text += block.content + "\n";
        else if (block.type === "thinking") text += block.thinking + "\n";
      }
    }
    // 工具定义也占输入：每个工具按 schema 序列化长度估算
    if (params.tools) {
      for (const t of params.tools) {
        text += t.name + t.description + JSON.stringify(t.input_schema) + "\n";
      }
    }
    return estimateTextTokens(text);
  }

  /**
   * 统一注入 system 消息：o-series 用 `developer` role，其余用 `system`（§3.1）。
   * 仅在历史首条尚不是 system/developer 时注入，避免重复（§4.1）。
   *
   * 缓存命中率修复：OpenAI/DeepSeek 均为"从 token 0 开始的整体前缀匹配"，
   * 不支持 Anthropic 那样的 content block 级 cache_control 分段。若把
   * system 字符串（含 DYNAMIC_BOUNDARY 之后的日期/git status 等动态内容）
   * 整段塞进 messages[0]，动态内容的任何变化都会让前缀在这条消息内部断裂，
   * 导致其后全部历史消息（即使字节未变）本轮全部无法复用缓存。
   * 因此静态区留在 messages[0]，动态区搬到消息序列末尾，新增一条独立消息
   * 承载（而非改写已有末尾消息——convertMessages 结尾可能是 assistant 或
   * role:"tool"，未必是 user），沿用项目里 <system-reminder> 的注入风格。
   */
  private prependSystemMessage(messages: any[], system: string, model: string): void {
    const first = messages[0];
    if (first && (first.role === "system" || first.role === "developer")) {
      return; // 已有，避免双 system（§4.1）
    }
    const role = this.isReasoningModel(model) ? "developer" : "system";
    const { staticContent, dynamicContent } = splitSystemByDynamicBoundary(system);
    messages.unshift({ role, content: staticContent });

    if (dynamicContent) {
      messages.push({
        role: "user",
        content: `<system-reminder>\n${dynamicContent}\n</system-reminder>`,
      });
    }
  }

  /**
   * 统一设置输出 token 上限字段：o-series 用 `max_completion_tokens`，
   * 其余用旧 `max_tokens`（§3.2）。直接写入 requestBody。
   */
  private applyMaxTokens(requestBody: any, maxTokens: number, model: string): void {
    if (this.isReasoningModel(model)) {
      requestBody.max_completion_tokens = maxTokens;
    } else {
      requestBody.max_tokens = maxTokens;
    }
  }

  /**
   * 透传思考/推理相关字段到请求体顶层（§2.1 / §2.2 / §2.6）。
   * 流式与非流式路径共用，避免降级时行为不一致。
   *
   * 按协议族分叉下发（判据取自 model-registry 的 protocolKind，缺省走模型名正则兜底）：
   * - **DeepSeek**（OpenAI 兼容端点，deepseek-api.md）：
   *   `thinking:{type:enabled/disabled}` 思考开关 + `reasoning_effort`(high/max) 强度，均顶层字段。
   *   注意 OpenAI **SDK** 用法是放进 extra_body，但 SDK 只是把它展开到 HTTP body 顶层；
   *   sid-code 直发 fetch，故直接写顶层即可。
   * - **GLM**（智谱，OpenAI 兼容端点，glm-api.md:144-147,189）：与 DeepSeek 同构——
   *   `thinking:{type}` 思考开关（GLM-4.5+）+ `reasoning_effort`（仅 GLM-5.2 生效，含 max）。
   * - **Grok**（xAI，OpenAI 兼容端点，grok-api.md:30,157,277）：无思考开关，仅 `reasoning_effort`
   *   （none/low/medium/high，无 max；effort.ts 已把 max 钳为 high）。
   * - **OpenAI o-series**：无思考开关，仅 `reasoning_effort`（low/medium/high）。
   * - **未知协议族**（`protocolKind` 缺失且模型名不匹配上面任何一族）：只下发
   *   `reasoning_effort`，**不**下发 `thinking`。见下方 isUnknownFamily 的详细说明。
   * - `user_id`——KVCache/调度/内容安全隔离，通用字段，任意端点按需下发（他端忽略不报错）。
   */
  private applyDeepSeekThinking(requestBody: any, params: SendParams, model: string): void {
    // 用户 compat 声明（按渠道/别名查，故用 params.model 而非上面的真名 model）——
    // 权威度高于下面一切按名推导，但只覆盖它声明了的位，其余位照走原判定。
    const compat = lookupModelCompat(params.model ?? this._model);

    // 族判定：**唯一**入口在 dialect/classify.ts（重构前这套正则在本文件里有两份副本，
    // 且与 effort.ts 那份判的族数不一致 —— 新增一族时漏改一处就静默走兜底分支）。
    //
    // ⚠ **刻意不传 `baseURL`**，尽管 classify 支持它。理由：本文件是 OpenAI 协议 provider，
    // 走到这里的请求**定义上**就在 OpenAI 兼容 Chat Completions 线上。而 `baseURL` 在
    // classify 里唯一的作用是把未注册的 DeepSeek 模型分到 `deepseek-anthropic`
    // （判据是路径含 `/anthropic`）—— 那一族有独立请求构造器，根本不该由本文件处理。
    //
    // 传了会引入一个**真实的行为回归**：企业网关的路径里带 `/anthropic` 时（实测存在这类
    // 路由前缀），未注册的 DeepSeek 模型会被判成 `deepseek-anthropic` → 被下面的
    // `isChatCompletionsFamily` 早退挡掉 → thinking 开关与 reasoning_effort 全不下发，
    // 且 `applyToolChoice` 那边会因此**开始下发 `tool_choice`**（V4 思考模式实测 400）。
    // 重构前这里的判据是 `kind === undefined && /deepseek/i.test(model)`，不看 baseURL。
    const kind = classifyProtocolFamily({ model });
    const wire = getDialectWire(kind);

    /**
     * 本函数只处理 **Chat Completions 线**（顶层字段透传）。
     *
     * `anthropic-native` / `deepseek-anthropic` / `openai-responses` 各有独立请求构造器
     * （`anthropic.ts` / `openai-responses-request.ts`），根本不经过这里 —— 早退而不是
     * 让它们落进下面的字段装配。
     *
     * 这条早退替换了重构前的 `isUnknownFamily` 排除式
     * （`kind === undefined && !isDeepSeek && !isGLM && !isGrok && !isOSeries`）：
     * 那种写法**每加一族都要在排除项里补一个 `!isXxx`**，漏补的后果是新族被误当未知族，
     * 拿到未知族的线格式。现在改为白名单谓词（`isChatCompletionsFamily`），
     * 新增族默认**不**进这条线，要进得显式登记。
     *
     * 历史（2026-08-08 前）：这道排除还兼任一个补丁 —— `sendMessageNonStreamingInner`
     * 当时不做 Responses 分派，GPT-5.x 走「流式失败降级到非流式」时会落进本函数，
     * 把 Responses 专属的 `xhigh`/`max` 档位当普通 `reasoning_effort` 发到
     * Chat Completions 线上。**该补丁只挡住了 effort 字段，没解决协议错配本身**
     * （还导致缓存口径分裂：命中键 Chat 在 prompt_tokens_details、Responses 在
     * input_tokens_details）。现在非流式已同样做 `shouldUseResponsesAPI` 分派（P0-5）。
     */
    if (!isChatCompletionsFamily(kind)) {
      // user_id 仍要下发：它与推理能力无关（通用隔离字段），不该被协议族早退连带关掉。
      if (params.userId) requestBody.user_id = params.userId;
      return;
    }

    const thinkingDisabled = params.thinking?.enabled === false;

    // ── compat 声明的三道闸门（放在字段装配之前，对每一族同样生效） ──
    //
    // 为什么统一拦而不是逐族加条件：逐族加就是每族一处手写守卫，新增一族的人必然漏 ——
    // 本仓「手写字段列表漏字段」有多次前科。统一闸门让「默认就成立」。
    //
    // ⚠ effort 被 compat 关掉时**不能** early-return 整个函数：下面还有 user_id 下发。
    const effortBlocked = compat?.supportsReasoningEffort === false;
    const thinkingToggleBlocked = compat?.supportsThinkingToggle === false;
    // 用户声明不支持 max 时**钳到 high**。effort.ts 侧已钳过一道（applyCompatOverrides），
    // 这里再兜一道：非主循环路径（side-call / headless）不一定跑过那层 cap 解析，
    // 而这里是**所有** Chat Completions 请求的唯一咽喉。两道同口径、幂等，不会打架。
    //
    // ⚠ 注意这与下面 `wire.allowsMaxEffort` 的处置**刻意不同**：用户声明 → 降档到 high
    // （他要的是「别发 max」，不是「别发 effort」）；族线格式不认 max → **整个字段不发**。
    // 后者是既有行为，不趁本次重构改，理由见下面 maxRejected 处的说明。
    const wireEffort =
      compat?.supportsMaxEffort === false &&
      (params.reasoningEffort === "max" || params.reasoningEffort === "xhigh")
        ? "high"
        : params.reasoningEffort;
    const effectiveEffort = effortBlocked ? undefined : wireEffort;

    // ── 思考开关 ──
    // 仅 `type-enum` 形态的族（DeepSeek / GLM）下发 `thinking:{type}`。
    // 其余族（Grok / o-series / 未知族）刻意不发：thinking 结构各家不同
    // （Anthropic 是 `{budget_tokens}`），瞎猜结构的 400 风险远高于一个标量字段，
    // 且无法从错误文本反推正确结构 —— 自愈救不回来。
    if (wire.thinkingToggle === "type-enum" && params.thinking && !thinkingToggleBlocked) {
      // ── 恒思考模型：请求关思考时降级为「不下发」，而不是发一个必被拒的 disabled ──
      //
      // 2026-08-17 实证（会话 `20260817-135824-fcf863e1`）：GLM-5.3 恒思考，
      // 收到 `thinking:{type:"disabled"}` 直接 400「该模型始终思考，不支持关闭思考」，
      // 且该错误被分类为 TerminalError("invalid_request") → **零重试**直接判主 Provider 失败。
      // 而全部 side-call（压缩/目标评估/工具分类/记忆召回，14 个调用点）都无条件套用
      // `SIDE_CALL_NO_THINK = { enabled: false }` → **每一次 side-call 都必然失败**。
      //
      // 降级语义照搬同文件 `applyToolChoice` 对 GLM `auto-only` 的处置：
      // **不下发 = 服务端默认**（这里即"思考开启"），而不是冒一个确定被拒的值。
      // side-call 关思考的原始意图（省 token + 不撞 side-call 硬超时）在恒思考模型上
      // 本就无法达成，正确处置是**接受它会思考**——而不是让整条调用链失败。
      //
      // ⚠ 只降级 `enabled === false` 这一支：`enabled === true` 照常下发
      // （主循环路径实测 `thinking:{type:"enabled"}` 返回 200）。
      const alwaysThinking = compat?.thinkingAlwaysOn ?? isThinkingAlwaysOn(model);
      if (params.thinking.enabled === false && alwaysThinking) {
        getLogger().warn(
          "LLM:OPENAI",
          `模型「${params.model ?? this._model}」恒思考（不支持关闭思考），` +
            `已将 thinking:{type:"disabled"} 降级为不下发（等价服务端默认=思考开启）`,
        );
      } else {
        requestBody.thinking = { type: params.thinking.enabled ? "enabled" : "disabled" };
      }
    }

    // ── 思考强度 ──
    //
    // 两个族差异位，都照搬重构前各族分支的原样语义（本次是纯搬迁，不改行为）：
    //
    // ① `allowsMaxEffort: false`（Grok / o-series）→ 档位为 max 时**整个字段不发**，
    //    而不是降到 high。这看着不如降档合理（用户选 max 结果一个 effort 都没发出去），
    //    但它是既有行为，且 `effort.ts` 侧的 applier 已把 max 钳成 high —— 主循环路径
    //    根本走不到这里的 max。真能走到的是 side-call / headless 那些不跑 cap 解析的路径，
    //    改成降档等于在**没有回归证据的路径上**改线上行为。要改另开 PR，别混进重构。
    //
    // ② `effortGatedByThinking`（DeepSeek / GLM）→ 思考显式关闭时不发（与
    //    `thinking:{type:"disabled"}` 冲突）。Grok 亦沿用旧代码里的 `!thinkingDisabled`
    //    守卫（虽然它无思考开关，该守卫实际很少生效）；o-series 旧代码**没有**这道守卫,
    //    故其 `effortGatedByThinking` 为 false —— 这处不对称是原样保留的，不是笔误。
    // ⚠ 只判 `=== "max"`，**不含 xhigh** —— 旧代码两处写的都是 `effectiveEffort !== "max"`。
    // 顺手把 xhigh 一起拦看着更「对」（Grok/o-series 都不认 xhigh），但那是改行为：
    // 实践中 effort.ts 已把 xhigh 钳掉，走到这里的 xhigh 只可能来自不跑 cap 解析的路径，
    // 而那正是没有回归证据的地方。原样保留。
    const maxRejected = !wire.allowsMaxEffort && effectiveEffort === "max";
    const thinkingGated = wire.effortGatedByThinking && thinkingDisabled;
    if (wire.sendsReasoningEffort && effectiveEffort && !maxRejected && !thinkingGated) {
      requestBody.reasoning_effort = effectiveEffort;
    }

    // user_id：通用隔离字段，按需下发（DeepSeek 专有语义，其它端点忽略不报错）。
    if (params.userId) {
      requestBody.user_id = params.userId;
    }
  }

  /**
   * 透传工具调用策略（§4.2 / §2.4）。流式与非流式共用。
   *
   * §2.4：DeepSeek V4 思考模式**不接受** `tool_choice` 参数（实测会 400，
   * OMP 官方配置亦标注 `supportsToolChoice: false`）。因此当模型为 DeepSeek
   * 且思考未显式关闭时，跳过 `tool_choice` 下发并记日志告警，而非冒 400 风险。
   * §GLM：`tool_choice` 默认且仅支持 `auto`（glm-api.md:147,276）——required/none/指定函数
   * 会被拒绝，统一降级为 auto（即不下发）。
   * `parallel_tool_calls` 未见冲突报告，保持下发。
   */
  private applyToolChoice(requestBody: any, params: SendParams, model: string): void {
    // compat 按渠道（别名）查，与下面按真名做的族推导互补：声明存在时它说了算。
    const compat = lookupModelCompat(params.model ?? this._model);
    // 族判定走**唯一**入口（重构前这里是本文件内的第二份分类副本，只判 deepseek/glm 两族）。
    // 与 `applyDeepSeekThinking` 同样**不传 baseURL** —— 理由见那里的详细说明
    // （传了会让带 `/anthropic` 路由前缀的网关上的未注册 DeepSeek 模型开始下发
    // `tool_choice`，而 V4 思考模式实测会 400）。两处必须同口径，否则同一次请求里
    // thinking 按一族算、tool_choice 按另一族算。
    const kind = classifyProtocolFamily({ model });
    const wire = getDialectWire(kind);
    // DeepSeek 思考模式不接受 tool_choice（§2.4）。compat 显式声明 supportsToolChoice: true
    // 时不再按族推导拦 —— 这正是 compat 存在的意义：网关可能已经替我们过滤掉了该字段，
    // 或用户跑的是修过这个问题的私有版本，只有他知道。
    const thinkingActive =
      wire.toolChoice === "reject-when-thinking" &&
      params.thinking?.enabled !== false &&
      compat?.supportsToolChoice !== true;
    const autoOnlyFamily = wire.toolChoice === "auto-only";
    const toolChoice = OpenAIProvider.toToolChoice(params.toolChoice);

    if (toolChoice !== undefined) {
      // compat 声明整个不接受 tool_choice → 不下发（保留模型自主调用）。
      // 放在最前面：它是最强的声明，优先于下面所有按族推导的降级。
      if (compat?.supportsToolChoice === false) {
        getLogger().warn(
          "LLM:OPENAI",
          `模型「${params.model ?? this._model}」的 compat 声明 supports_tool_choice=false，已跳过下发（请求的 toolChoice=${JSON.stringify(params.toolChoice)}）`,
        );
      } else if (compat?.toolChoiceAutoOnly === true && toolChoice !== "auto") {
        // 仅支持 auto（GLM 形态）→ 降级为不下发（等价服务端默认 auto），而非冒 400。
        getLogger().warn(
          "LLM:OPENAI",
          `模型「${params.model ?? this._model}」的 compat 声明 tool_choice_auto_only=true，已将 ${JSON.stringify(params.toolChoice)} 降级为 auto（不下发）`,
        );
      } else if (thinkingActive) {
        // DeepSeek 思考模式下 tool_choice 会触发 400，跳过下发（保留模型自主调用）。
        // 日志带上族名：重构后本分支不再只有 DeepSeek 会进（任何 dialect 声明
        // `reject-when-thinking` 的族都会），写死「DeepSeek」会误导排查的人。
        getLogger().warn(
          "LLM:OPENAI",
          `协议族「${kind}」思考模式不支持 tool_choice，已跳过下发（请求的 toolChoice=${JSON.stringify(params.toolChoice)}）`,
        );
      } else if (autoOnlyFamily && toolChoice !== "auto" && compat?.toolChoiceAutoOnly !== false) {
        // §GLM：tool_choice 默认且仅支持 auto，不支持 none/required/指定函数（见 dialect/glm.md）。
        // 下发 required/指定函数会被 GLM 拒绝，降级为 auto（不下发即等价服务端默认 auto）而非冒错。
        // compat 显式声明 tool_choice_auto_only=false 时跳过本降级（如 GLM-5.2+ 已放开、
        // 或网关代为转换）—— 显式声明优先于按族推导，这是 compat 的全部意义。
        getLogger().warn(
          "LLM:OPENAI",
          `协议族「${kind}」仅支持 tool_choice=auto，已将 ${JSON.stringify(params.toolChoice)} 降级为 auto（不下发）`,
        );
      } else {
        requestBody.tool_choice = toolChoice;
      }
    }
    if (params.parallelToolCalls !== undefined) {
      requestBody.parallel_tool_calls = params.parallelToolCalls;
    }
  }

  /**
   * 将 sid-code 内部消息格式转换为 OpenAI API 格式
   *
   * 关键差异：
   * 1. OpenAI 的 tool_use 不在 content 数组里，而是 assistant 消息顶层的 tool_calls 字段
   * 2. OpenAI 的 tool_result 不在 user 消息的 content 里，而是独立的 role:"tool" 消息
   * 3. OpenAI 的 content 字段对于纯文本消息应该是字符串，不是数组
   */
  private convertMessages(messages: Message[], effectiveModel?: string, alias?: string): any[] {
    const model = effectiveModel || this._model;
    const result: any[] = [];

    // 方案 C 最后兜底：预扫所有 assistant 的 tool_use id 集合。
    // 上游防线（restoreSession 安全切片 + 发送前 backfill 切游离 + guard 哨兵）全部失效的
    // 极端情况下，仍可能有游离 tool_result（其 id 非空，故躲过下方 §2.3 空 id fail-fast）
    // 穿透到这里。若原样转成 role:"tool" 且无前置 tool_calls 持有该 id → OpenAI 400。
    // 这里收集合法 id，生成 role:"tool" 时校验：不在集合中则丢弃 + 告警（而非透传致 400）。
    const knownToolUseIds = new Set<string>();
    for (const msg of messages) {
      if (msg.role === "assistant" && Array.isArray(msg.content)) {
        for (const block of msg.content) {
          if (block.type === "tool_use" && block.id) knownToolUseIds.add(block.id);
        }
      }
    }

    for (const msg of messages) {
      if (msg.role === "assistant") {
        // 提取文本和工具调用
        const textParts: string[] = [];
        const toolCalls: any[] = [];
        // 思考块文本兜底：reasoning 模型（DeepSeek 等）可能整轮回复都走 reasoning_content，
        // content 为空 → 历史里只剩 thinking 块。下一轮回放时若 text/tool_calls 皆空，
        // OpenAI 会判 `content or tool_calls must be set` → 400。收集思考文本作兜底。
        const thinkingParts: string[] = [];

        for (const block of msg.content) {
          if (block.type === "text") {
            textParts.push(block.text);
          } else if (block.type === "thinking") {
            if (block.thinking) thinkingParts.push(block.thinking);
          } else if (block.type === "redacted_thinking") {
            // Anthropic 安全审查脱敏后的思考块。OpenAI 协议**无对应字段**，
            // `data` 是不可读的密文，塞进 content 只会污染上下文 → 只能丢弃。
            // 但必须**可观测**：此前它落进"未识别"静默消失，推理链断裂无迹可寻。
            // 典型来路：Anthropic 侧历史 + 跨 provider fallback。
            getLogger().warn(
              "LLM:PROTOCOL",
              `[${this.name()}] convertMessages 丢弃 redacted_thinking 块（OpenAI 协议无对应字段，` +
                `data 为密文无法降级为文本）。跨 provider 回放 Anthropic 历史时会出现，推理链在此断裂。`,
            );
          } else if (block.type === "tool_use") {
            // §2.3 fail-fast：空 id 的 tool_use 无法与后续 tool message 配对，
            // 原样转发必然触发 OpenAI 400。在转换层提前抛错，比让服务端 400 更易定位。
            if (!block.id) {
              throw new Error(
                `OpenAI convertMessages: tool_use 缺少 id（name=${block.name}），无法构造合法 tool_calls`,
              );
            }
            toolCalls.push({
              id: block.id,
              type: "function",
              function: {
                name: block.name,
                // §2.2：input 为 undefined 时 JSON.stringify 返回 JS undefined（非字符串），
                // 序列化进 body 会丢字段 → arguments 缺失 → 400。空参数应为 "{}"。
                arguments: JSON.stringify(block.input ?? {}),
              },
            });
          } else {
            // default 兜底告警：让"丢弃"可观测。手写分派链的通用病是跟不上 ContentBlock
            // 类型演进——新增块类型若忘了在此加分支，此前会静默消失，只能靠事后审计发现。
            getLogger().warn(
              "LLM:PROTOCOL",
              `[${this.name()}] convertMessages 遇到未识别的 assistant content block（` +
                `type=${(block as { type?: string }).type}），已丢弃。请在此补齐分派分支。`,
            );
          }
        }

        const joinedText = textParts.join("");
        // content 取值优先级：真实文本 > 思考文本兜底 > null。
        // 仅当无文本且无工具调用时才用思考兜底——保证 assistant 消息至少有
        // content 或 tool_calls 之一非空，满足 OpenAI/DeepSeek 协议（避免 400）。
        let contentValue: string | null = joinedText || null;
        if (!joinedText && toolCalls.length === 0 && thinkingParts.length > 0) {
          contentValue = thinkingParts.join("");
        }

        const assistantMsg: any = {
          role: "assistant",
          content: contentValue,
        };

        if (toolCalls.length > 0) {
          assistantMsg.tool_calls = toolCalls;
        }

        // DeepSeek: 回传 reasoning_content（思考链）。按模型协议能力分叉——
        //
        // 真因修复（方案⓪，deepseek-reasoning-leak-as-text-任务中断.md）：
        //   DeepSeek V4（V3.2 起）thinking 模式下，**tool-call 轮的 reasoning_content
        //   必须原样回传**给 API，模型才能接续上一轮的思考（deepseek-api.md:1012/1055/1057
        //   + 官方样例 1160-1174 行一律 messages.append(带 reasoning_content 的整条消息)）。
        //   否则思维链被切断 → 思考量雪崩 → 漂移进 content 当正文 / 600s hang。
        //
        //   旧 `deepseek-reasoner`（R1 系，2026/07/24 弃用前）：输入携带 reasoning_content
        //   会触发旧协议 400（即旧注释"实测 13 次命中"的来源，DeepSeek 在 V3.2 反转了规则）。
        //   这类模型 requiresReasoningContentForToolCalls=false → 仅无 tool_calls 时回传。
        //
        //   分叉判据取自 model-registry 的 requiresReasoningContentForToolCalls 能力标志
        //   （而非散落的模型名 if），避免协议演进时漂移。
        if (msg._meta?.reasoning_content) {
          const carryOnToolCalls = this.requiresReasoningContentForToolCalls(model, alias);
          if (toolCalls.length === 0 || carryOnToolCalls) {
            assistantMsg.reasoning_content = msg._meta.reasoning_content;
          }
        }

        result.push(assistantMsg);
      } else if (msg.role === "user") {
        // 分离 tool_result 和普通内容
        const textParts: string[] = [];
        const toolResults: { tool_call_id: string; content: string }[] = [];

        for (const block of msg.content) {
          if (block.type === "text") {
            textParts.push(block.text);
          } else if (block.type === "tool_result") {
            // §2.3 fail-fast：空 tool_call_id 的 tool message 无法与任何 tool_call 配对 → 400。
            if (!block.tool_use_id) {
              throw new Error(
                `OpenAI convertMessages: tool_result 缺少 tool_use_id，无法构造合法 role:tool 消息`,
              );
            }
            // 方案 C 最后兜底：游离 tool_result（id 非空但无前置 assistant.tool_calls 持有该 id）
            // 若透传成 role:"tool" 必然 400。上游防线全失效时在此丢弃 + 告警，避免 400。
            if (!knownToolUseIds.has(block.tool_use_id)) {
              getLogger().warn(
                "LLM:PROTOCOL",
                `[${this.name()}] convertMessages 兜底丢弃游离 tool_result（tool_use_id=${block.tool_use_id} 无前置 tool_calls）。` +
                  `正常情况下应被发送前 backfill 关卡切除——走到这里说明上游防线漏网，需排查产生端。`,
              );
              continue;
            }
            toolResults.push({
              tool_call_id: block.tool_use_id,
              // §2.1：规范要求 tool message content 为非空 string。工具返回空串
              //（如 bash 无输出、grep 无匹配）时部分严格网关会判非法 → 400，兜底占位。
              content: serializeToolResultContentForOpenAI(block, this.name()),
            });
          }
        }

        // tool_result 拆分为独立的 role:"tool" 消息
        for (const tr of toolResults) {
          result.push({
            role: "tool",
            tool_call_id: tr.tool_call_id,
            content: tr.content,
          });
        }

        // 纯文本部分作为 user 消息（如果有的话）
        if (textParts.length > 0) {
          result.push({
            role: "user",
            content: textParts.join("\n"),
          });
        }
      }
    }

    return result;
  }

  async *sendMessageStream(params: SendParams, signal?: AbortSignal): AsyncIterable<StreamEvent> {
    // 能力自愈外层：首次因「我们多发了一个模型不认的能力字段」而 400 时，剥掉该字段重试一次。
    // 让「用户只配 name/endpoint/apiKey」的未知模型也能一次成功，而不是把 400 抛给用户。
    // 详见 healCapabilityAndRetry 与 model-capabilities.ts 的自愈说明。
    yield* this.withCapabilityHealing(params, signal);
  }

  /**
   * 能力自愈包装 —— 「永不报错」的执行层。
   *
   * 未知模型的能力靠乐观假设（见 effort.ts resolveFromCapabilityCache），假设错了会 400。
   * 这里捕获那类 400，从错误文本学到真值（写入能力缓存），剥掉冒犯字段重试一次。
   * 用户看到的是一次正常完成的请求；下次起缓存已准，不再多这一跳。
   *
   * 只自愈**我们自己多发的能力字段**（当前：reasoning_effort / reasoning.effort）。
   * 其余错误（鉴权、限流、上下文超限、模型不存在）原样透出——那些不是能力误判，
   * 盲目重试只会掩盖真问题。
   *
   * 判据是「措辞匹配 **或** 结构匹配」，两条缺一不可：
   * - `learnFromError().dropEffort` 认措辞，顺带把服务端自报的档位学进缓存（有值才学）。
   * - `shouldRetryWithoutEffort()` 只认 HTTP 4xx，不看措辞——这是兜底。
   * 因为我们现在会对未知族**主动多发** `reasoning_effort`，若只靠措辞匹配，
   * 漏判就等于让用户看到一个修复前不存在的 400（实测 11 种真实措辞漏 5 种）。
   */
  private async *withCapabilityHealing(
    params: SendParams,
    signal?: AbortSignal,
  ): AsyncIterable<StreamEvent> {
    // 能力自愈缓存按**真名**记账：400 是端点针对真实模型报的，学到的「不支持 effort」
    // 属于那个真模型，不属于某条本地别名。用别名当 key 会让同一真模型的两个渠道各自
    // 重新踩一遍 400（学不到彼此的经验），也会污染 lookupCapability 的前缀/家族匹配。
    const model = pickWireModel(params, this._model);
    let healed = false;

    for (const attempt of [0, 1]) {
      let capabilityError: string | null = null;
      // 本轮是否出过错。第二轮的错误是直接 yield 出去的（不再自愈），
      // capabilityError 仍为 null——不单独记一个标志就会把「重试也失败」当成成功记账。
      let sawError = false;

      for await (const ev of this.sendMessageStreamInner(params, signal)) {
        if (ev.type === "error") sawError = true;
        // 只在「首次尝试 + 尚未产出任何内容 + 我们确实发了 effort」的错误上考虑自愈；
        // 已经开始输出就不能重发（会重复内容）。
        if (attempt === 0 && ev.type === "error" && params.reasoningEffort !== undefined) {
          const msg = ev.error?.message ?? "";
          // learnFromError 有副作用（把学到的档位写进缓存），无论是否重试都值得先跑一次。
          const advice = learnFromError(model, msg);
          const structural = shouldRetryWithoutEffort({
            statusCode: ev.error?.statusCode,
            errorMessage: msg,
          });
          if (advice.dropEffort || structural) {
            capabilityError = msg;
            break;
          }
        }
        yield ev;
      }

      if (capabilityError === null) {
        // 第二轮（已剥掉 effort）且本轮**没有任何错误** → 重试确实成功，记账让下次不再多这一跳。
        // 必须校 sawError：若剥掉仍失败，真因不是这个字段，记账会把一个支持 effort 的模型冤枉成不支持。
        if (attempt === 1 && !sawError) recordEffortRejected(model);
        return; // 正常完成或不可自愈的错误（已 yield 出去）
      }

      // 剥掉 effort 字段重试。params 是调用方对象，不可原地改 → 浅拷贝。
      getLogger().debug("LLM:OPENAI", `能力自愈：${model} 拒绝 reasoning_effort，剥离该字段重试`, {
        error: capabilityError.slice(0, 160),
      });
      params = { ...params, reasoningEffort: undefined };
      healed = true;
    }

    if (healed) {
      getLogger().debug("LLM:OPENAI", `能力自愈完成：${model}`);
    }
  }

  private async *sendMessageStreamInner(
    params: SendParams,
    signal?: AbortSignal,
  ): AsyncIterable<StreamEvent> {
    // D1-1：发送前协议完整性关卡（只读校验 + 告警 + 落盘，不修数据，尊重 ADR-039）
    guardOutgoingMessages(params.messages, { providerName: this.name() });

    // 真名（wire model）：既进请求体，也是**协议分派与参数过滤**的判据。
    // 这里尤其不能用本地别名——shouldUseResponsesAPI / isReasoningModel /
    // filterParamsForModel / lookupCatalog 全是按模型名做正则与前缀匹配，
    // 别名一旦不是「真名 + 后缀」形状（如 gw-gpt-5.3），就会走错协议或漏过参数过滤。
    const effectiveModel = pickWireModel(params, this._model);
    // 别名（attribution model）：**结构化可观测性**字段用它，与 anthropic.ts 的
    // this._model 口径一致。两条渠道指向同一真名，telemetry 若打真名就会被聚合成一条，
    // 分渠道的延迟/停顿/失败率统计直接失效——而分渠道正是配 model_id 的目的。
    // 注意 AUDIT:API 的报错字符串刻意保留真名：排查 400 "model not found" 时，
    // 需要看到实际发出去的那个名字，那是诊断信息而非归因维度。
    const attrModel = params.model || this._model;

    // A3：Responses API 分派——GPT-5.x 系列走新协议
    if (this.shouldUseResponsesAPI(effectiveModel)) {
      yield* this.sendViaResponsesAPI(params, effectiveModel, signal);
      return;
    }

    // 转换消息格式（传入 effectiveModel 供 reasoning_content 回传分叉判据使用；
    // 另传别名供 compat 声明查表——两者不能合并，见 requiresReasoningContentForToolCalls）
    const messages = this.convertMessages(params.messages, effectiveModel, params.model);

    // 转换工具定义（schema 按族方言清理，见 convertTools 注释）
    const tools = OpenAIProvider.convertTools(effectiveModel, params.tools);

    const requestBody: any = {
      model: effectiveModel,
      messages,
      stream: true,
      stream_options: { include_usage: true },
    };

    // §3.2：o-series 用 max_completion_tokens，其余用 max_tokens
    this.applyMaxTokens(requestBody, params.maxTokens, effectiveModel);
    // §2.1/§2.2/§2.6：DeepSeek 思考开关 / reasoning_effort / user_id 透传
    this.applyDeepSeekThinking(requestBody, params, effectiveModel);

    if (params.system) {
      // §3.1：o-series 用 developer role，其余 system；并避免重复注入(§4.1)
      this.prependSystemMessage(requestBody.messages, params.system, effectiveModel);
    }

    if (tools && tools.length > 0) {
      requestBody.tools = tools;
      // §4.2/§2.4：工具调用策略透传（DeepSeek 思考模式跳过 tool_choice）
      this.applyToolChoice(requestBody, params, effectiveModel);
    }

    // § P1: model-capability-filter 参数过滤（基于 catalog 声明的协议能力兜底纠偏）。
    // ⚠️ 必须在 applyMaxTokens / applyDeepSeekThinking / prependSystemMessage **之后**执行：
    // filter 处理的字段（max_tokens→max_completion_tokens、system→developer、reasoning_effort
    // 钳制、剔除 temperature/top_p）依赖这些字段先被写入 requestBody。若在赋值前执行则全是
    // no-op（历史 bug）。典型受益：Grok 推理模型声明 maxTokensField=max_completion_tokens 但
    // 不匹配 /^o[0-9]/，applyMaxTokens 会误写 max_tokens，靠此 filter 纠正为 max_completion_tokens。
    filterParamsForModel(effectiveModel, requestBody);

    try {
      const log = getLogger();
      const requestStartTime = Date.now();
      let firstTokenTime: number | null = null;

      log.debug("LLM:OPENAI", `发送请求到 ${this.baseURL}/chat/completions`, {
        model: requestBody.model,
        messageCount: requestBody.messages.length,
        toolCount: requestBody.tools?.length ?? 0,
        maxTokens: requestBody.max_completion_tokens ?? requestBody.max_tokens,
      });

      // ── 响应头超时（纵深防御，见文件顶部 RESPONSE_HEADER_TIMEOUT_MS 注释）──
      // 用一个独立的本地 AbortController 给 fetch 设"等响应头"超时。到点直接 abort
      // 本地 controller —— 不依赖外层 signal 的 unref/AbortSignal.any 传播是否完美。
      // 与外层 signal 用 AbortSignal.any 组合：任一触发都中断 fetch。
      // 阈值可经 SID_CODE_RESPONSE_HEADER_TIMEOUT_MS 覆盖（运维调参 / 测试注入）。
      const headerTimeoutMs = OpenAIProvider.resolveHeaderTimeoutMs(this._model);
      const headerTimeoutCtl = new AbortController();
      let headerTimedOut = false;
      // 缺口 2 进阶：header 超时 fire 后武装未生效检查；拿到响应头/失败时 disarm。
      let disarmHeaderIneffective: (() => void) | null = null;
      // 获取当前 turn index 用于可观测性事件
      const obsIndex = currentSseDumpContext().turnIndex;
      let headerTimeoutId: ReturnType<typeof setTimeout> | null = setTimeout(() => {
        headerTimedOut = true;
        log.warn(
          "LLM:OPENAI",
          `响应头超时 ${headerTimeoutMs / 1000}s 未收到响应头，主动中断 fetch（model=${this._model}）`,
        );
        // 缺口 2：记录响应头超时触发
        emitTimeoutFired(obsIndex, "header_timeout", {
          threshold_ms: headerTimeoutMs,
          model: attrModel,
        });
        // 缺口 2 进阶：武装未生效检查（abort 后若 fetch 未在 5s 内 settle → TimeoutIneffective）
        disarmHeaderIneffective = armIneffectiveCheck(
          obsIndex,
          "header_timeout",
          "fetch_not_settled_after_5s",
        );
        headerTimeoutCtl.abort();
      }, headerTimeoutMs);
      // 注意：不调 unref()。fdb47f30 的教训正是 fallback 的整体超时定时器 unref 后
      // 在 hang 场景疑似未按时 fire；响应头超时是关键防线，宁可让它保持进程活跃。
      // ── fetch 绝对硬顶：**默认不装**（P0-3，2026-08-18 改向）──
      //
      // 原注释的理由是"响应头已到、SSE 进半开、reader 永不 settle 时 header timeout
      // 已被 clearTimeout 释放，需要一个绝对上限打破 hang"。这个 hang 确实存在，
      // 但**用绝对计时器去打破它是错的工具**：
      //   ① 半开时正是「零字节到达」，那是 parseSSE 字节级 idle 闸门（本文件
      //      IDLE_TIMEOUT_MS，档①）的领地，且它的归因是 `idle_timeout`
      //      —— 说得出是哪一层、哪个阈值、收了多少 chunk；
      //   ② 任何未知挂起根因的兜底是 `maxTurnDurationMs`（档③，query/loop.ts 有生产调用方）。
      // 而 `AbortSignal.timeout` 的语义是**整个 fetch 生命周期的绝对上限**，
      // 它不关心 body 是否还在正常产出 —— 实测（tests/llm/fetch-absolute-timeout-cuts-progressing-stream.test.ts）
      // 一条每 200ms 稳定产出 chunk 的健康流照样被它掐断，且抛出的
      // DOMException("TimeoutError") 由 runtime 发出、**不带可归因 reason**、
      // **不经 emitTimeoutFired**（轨迹里查不到是它开的枪）。
      //
      // 所以默认 undefined = 不装这个 signal，仅在用户显式配置
      // （SID_CODE_FETCH_ABSOLUTE_TIMEOUT_MS / settings.json 的 network.fetchAbsoluteTimeoutMs）
      // 时启用。配置入口保留而非删代码：与 loop-detection / maxSessionDurationMs 的
      // 既有范式一致（翻默认值、留旋钮）。一旦开启，归因必须是对的 —— 所以
      // classifyError 仍把 TimeoutError 归成 RetryableError("timeout")（见 llm/errors.ts）。
      //
      // 一次解析，fetch 硬顶与下方 lifecycle overall 复用。
      const streamTimeouts = resolveProviderStreamTimeouts({ providerKind: "openai" });
      const FETCH_ABSOLUTE_TIMEOUT_MS = streamTimeouts.fetchAbsoluteTimeoutMs;
      const fetchSignals: AbortSignal[] = [headerTimeoutCtl.signal];
      if (signal) fetchSignals.unshift(signal);
      if (FETCH_ABSOLUTE_TIMEOUT_MS !== undefined) {
        fetchSignals.push(AbortSignal.timeout(FETCH_ABSOLUTE_TIMEOUT_MS));
      }
      const fetchSignal = AbortSignal.any(fetchSignals);

      let response: Response;
      // 缺口 1：记录 fetch 发出阶段
      emitStreamPhase(obsIndex, "fetch_sent", { model: attrModel });
      try {
        response = await fetch(`${this.baseURL}/chat/completions`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${this.apiKey}`,
          },
          body: JSON.stringify(sanitizeStrings(requestBody)),
          signal: fetchSignal,
          // B1-b：ECONNRESET/EPIPE 后 fallback 会置位进程级 keep-alive 开关，此处是
          // 真消费点——禁用后展开为 { keepalive: false }，强制新建连接而非复用池里
          // 那条已被对端关闭的死 socket（否则重试仍命中同一条，白烧重试次数）。
          // 未禁用时展开为空对象，规范路径逐字段不变。
          ...getKeepAliveFetchOptions(),
        });
      } catch (err: any) {
        // 区分"本地响应头超时"与"外层 signal（用户 ESC / fallback 整体超时）中断"：
        // - 响应头超时 → 抛 timeout 错误（带"超时"字样），经 classifyError 归为
        //   RetryableError("timeout")，让 fallback 走重试 → 降级，把 hang 转成自愈。
        // - 外层 signal 中断 → 原样抛出，由 fallback / 上层按 abort 处理（不重试）。
        if (headerTimedOut && !signal?.aborted) {
          throw new Error(
            `响应头超时：${headerTimeoutMs / 1000}s 未收到响应头（model=${this._model}）`,
          );
        }
        throw err;
      } finally {
        // 拿到响应头（或已失败）后立即清掉响应头超时定时器，
        // 后续 SSE 流由 parseSSE 的 idle 超时接管。
        if (headerTimeoutId !== null) {
          clearTimeout(headerTimeoutId);
          headerTimeoutId = null;
        }
        // 缺口 2 进阶：fetch 已 settle（返回或抛出）→ disarm header 未生效检查。
        (disarmHeaderIneffective as (() => void) | null)?.();
      }

      if (!response.ok) {
        const error = await response.text();
        log.error("LLM:OPENAI", `API 错误: ${response.status}`, error);
        // 缺口 1：HTTP 错误也记录阶段（含状态码）
        emitStreamPhase(obsIndex, "error", { http_status: response.status, model: attrModel });
        // 接入审计日志(WARN 级,fileOnly 不刷屏):API 层错误是排查会话异常的关键信号,
        // 原先只进 LLM:OPENAI 普通日志,audit.log 拿不到 HTTP 码 → 异常时定位慢。
        getLogger().warn(
          "AUDIT:API",
          `✗ OpenAI HTTP ${response.status} model=${effectiveModel} body=${(error ?? "").slice(0, 200)}`,
        );
        yield {
          type: "error",
          // statusCode 必须带上：能力自愈的结构判据（shouldRetryWithoutEffort）看的是
          // HTTP 码而非措辞——网关可能只透传一句 "400 Bad Request"，正文里啥字段名都没有。
          error: {
            message: `OpenAI API 错误: ${response.status} ${error}`,
            statusCode: response.status,
          },
        };
        return;
      }

      log.debug("LLM:OPENAI", `开始接收 SSE 流`);
      // G8：提取 OpenAI 系 rate-limit header（此前只有 anthropic.ts 提取，OpenAI-wire
      // provider 限流状态永远显示 ok）。extractRateLimitFromHeaders 已兼容 x-ratelimit-*。
      updateRateLimitStatus(response.headers);
      // P2-6：留网关请求标识，供 raw.jsonl 落盘后拿去找网关方核对具体是哪次请求
      // （实测本仓两族网关分别下发 x-oneapi-request-id / x-shellapi-request-id）。
      recordRequestId(response.headers);
      // 缺口 1/6：记录 headers_received 阶段（含 HTTP 状态码、Content-Type 和 TTFB）
      const ttfbMs = Date.now() - requestStartTime;
      const contentType = response.headers.get("content-type") ?? undefined;
      emitStreamPhase(obsIndex, "headers_received", {
        http_status: response.status,
        content_type: contentType,
        ttfb_ms: ttfbMs,
        model: attrModel,
      });
      // 缺口 6：独立 HttpConnected 事件（按 `HttpConnected` 检索一致性；确认网络层状态）
      emitHttpConnected(obsIndex, {
        status: response.status,
        content_type: contentType,
        ttfb_ms: ttfbMs,
        model: attrModel,
      });

      // ─── Content-Type 守卫（fail-fast 伪装成功的错误页）───
      // 背景（事故复盘 session 20260708-102143）：网关对不可用模型/渠道有时不返回
      // 4xx/5xx，而是回 HTTP 200 + `text/html` 的错误页（"No available channel"）。
      // 这个响应逐行进 parseSSE 后没有任何 `data: ` 行 → 0 事件读到流尾 → 被当成
      // "空回复 end_turn"静默收尾（stopReason=null），用户界面毫无提示。
      // 这里在开始解析前拦下：SSE 必须是 text/event-stream；明确是 HTML（或其它
      // 非流式文本页）时直接判错终止。归为 streamLevel 错误让 fallback.ts 按结构化
      // 字段处理（server_error → 重试 / 再降级），而非静默吐一个空流。
      // 保守策略：只拦 text/html（错误页的确定信号）；缺失 content-type、
      // text/event-stream、application/json（部分兼容网关如此标注合法流）均放行，
      // 避免误伤正常但 header 标注不规范的网关。
      if (contentType && contentType.toLowerCase().includes("text/html")) {
        // 读取少量响应体用于诊断（截断，避免把整页 HTML 灌进日志/上下文）。
        let bodySnippet = "";
        try {
          bodySnippet = (await response.text()).slice(0, 300).replace(/\s+/g, " ").trim();
        } catch {
          /* 读 body 失败不影响判错 */
        }
        emitStreamPhase(obsIndex, "error", {
          http_status: response.status,
          content_type: contentType,
          // 归因维度用别名（AUDIT 日志里仍打真名做诊断，见下方 warn）
          model: attrModel,
        });
        getLogger().warn(
          "AUDIT:API",
          `✗ OpenAI 响应 Content-Type=${contentType}（非 SSE，疑似网关错误页）model=${effectiveModel} body=${bodySnippet}`,
        );
        log.error(
          "LLM:OPENAI",
          `响应 Content-Type 为 ${contentType}（非 text/event-stream），判定为伪装成功的错误页，终止本次流`,
        );
        yield {
          type: "error",
          error: {
            message: `网关返回非流式响应（Content-Type: ${contentType}，HTTP ${response.status}），疑似模型/渠道不可用的错误页：${bodySnippet || "(空)"}`,
            // 结构化标记：让 fallback.ts 走 classifyStreamError → StreamLevelError（可重试/降级），
            // 而非落到"空流静默收尾"。type 用 server_error 语义（200 但内容非法，倾向瞬态/配置）。
            type: "server_error",
            streamLevel: true,
          },
        };
        return;
      }

      // 解析 SSE 流
      let accumulatedUsage: Usage = { inputTokens: 0, outputTokens: 0 };
      // PARSE-4：累积输出文本，供"端点不返回 usage"（Ollama 等）时估算兜底
      let accumulatedOutputText = "";
      // § StreamLifecycle 包装（T7）：parseSSE 保留其**字节级** idle/content 超时核心
      // （检测"零字节到达"的 TCP 半开——比事件级更细的信号，经 fdb47f30/9bc92c2c 淬炼，
      // 不下移以免降级检测能力）；这里叠加两项 parseSSE 原先缺失的能力：
      //   1) 统一 onStreamTelemetry 遥测（对齐 anthropic：stream_stall/completed 进 events.jsonl）；
      //   2) Layer 3 请求级整体超时兜底（overallTimeoutMs，事件级绝对上限）。
      // idleTimeoutMs 设为一个宽松上限（parseSSE 的字节级 idle 更严格、先触发），避免与之竞争。
      const lifecycle = createStreamLifecycle<StreamEvent>({
        // 事件级 idle 放宽到 overall 同量级：字节级 idle（parseSSE 内）才是权威的空闲判据，
        // 这层只作"连事件都彻底停了"的粗粒度兜底，不与字节级 idle 争抢触发。
        idleTimeoutMs: LIFECYCLE_PRESETS.mainLoop.overallTimeoutMs,
        // 配置-3：overall 阈值走 network-profile 统一解析（env override > 默认），
        // 不再就地 Number(process.env)。env 名保留 SID_CODE_OPENAI_OVERALL_TIMEOUT_MS。
        overallTimeoutMs: streamTimeouts.overallTimeoutMs,
        // P0-1：事件级进展写进 observer 快照，供 loop.ts 的 watchdog 读。
        // 与 parseSSE 内的字节级 updateStreamStats 是两层、都要（字节级能检测
        // 「零字节到达」的 TCP 半开，事件级负责把「有业务进展」广播给外层）。
        // obsIndex 与本路径 emitStreamPhase 用的是同一个，且不带 agentId ——
        // 否则拼出的 snapshot key 与 watchdog 读的不是同一把。
        progressObsIndex: obsIndex,
        stallWarnMs: 30_000,
        label: "OPENAI",
        // T14.6：收敛 first_content emit 到 lifecycle 层
        isFirstContent: (ev) => ev.type === "content_block_delta",
        requestStartTimeMs: requestStartTime,
        onFirstContentProgress: (ttftMs) => {
          if (!firstTokenTime) {
            firstTokenTime = Date.now();
            log.debug("LLM:OPENAI", `首 token 延迟: ${ttftMs}ms`);
            emitStreamPhase(obsIndex, "first_content", { ttft_ms: ttftMs, model: attrModel });
          }
        },
        // § 行为等价（T7）：abort 由 parseSSE（内部 abortPromise race）+ 下方消费循环
        // （`if (signal?.aborted) throw`）owns，不交给 lifecycle 早退，保持迁移前语义。
        onTimeout: (layer) => {
          // parseSSE 的字节级超时是第一道防线；这里的事件级超时是叠加兜底。
          try {
            // threshold_ms 必须报**触发的那一层自己的**阈值。
            //
            // 本路径两层取的是不同的数：idle 用 `preset.overallTimeoutMs`（刻意放宽，
            // 见上方 idleTimeoutMs 的注释），overall 用 `streamTimeouts.overallTimeoutMs`
            // （可被 SID_CODE_OPENAI_OVERALL_TIMEOUT_MS 覆盖）。原来一律报前者，于是
            // 运维一旦设了那个 env，overall 触发时报的阈值就与真实触发值不符 —— 排查的人
            // 拿着 600000 去对一条其实 120s 就断了的流，只会得出「看着没超时却断了」的
            // 错误结论。错误归因比没有归因更坏，这是本仓反复记的教训。
            emitTimeoutFired(obsIndex, layer === "overall" ? "turn_hard_timeout" : "idle_timeout", {
              threshold_ms:
                layer === "overall"
                  ? streamTimeouts.overallTimeoutMs
                  : LIFECYCLE_PRESETS.mainLoop.overallTimeoutMs,
              model: attrModel,
            });
          } catch {
            /* 可观测性不影响主流程 */
          }
        },
        onTelemetry: (evt: StreamTelemetrySignal) => {
          log.debug("TELEMETRY:OPENAI", `${evt.type}`, evt as any);
          try {
            params.onStreamTelemetry?.(evt);
          } catch {
            /* 遥测失败不影响主流程 */
          }
        },
      });
      for await (const event of lifecycle.guard(this.parseSSE(response.body!, signal))) {
        // Fix 1 纵深防御：每次事件到达后检查 signal（覆盖 parseSSE 内 race 的盲区）
        if (signal?.aborted) {
          // 缺口 1：用户中断记录 aborted 阶段
          emitStreamPhase(obsIndex, "aborted", { reason: "signal_aborted", model: attrModel });
          throw new Error("Request aborted");
        }
        // T14.1/T14.6：首 token 延迟（TTFT）已收敛到 lifecycle 的 onFirstContentProgress 回调，
        // 在 first-content 事件到达时统一 emit first_content。此处不再重复检测。

        // PARSE-4：累积文本增量（仅文本，工具调用 JSON 不计入输出估算的主体）
        if (event.type === "content_block_delta" && event.delta.type === "text_delta") {
          accumulatedOutputText += event.delta.text;
        }

        // 累积 usage
        if (event.type === "message_delta") {
          accumulatedUsage = event.usage;
          const u = event.usage;
          // 5.1：记录 provider **原始** output 是否为 0（在任何估算兜底之前捕获）。
          // 这是方案① 判"未答复 end_turn"的最硬结构信号——必须与下方估算兜底解耦：
          // 估算会把 outputTokens 补成非零，若下游只看补后的值就永远判不出"原始为 0"。
          // 故用独立 _rawOutputTokensZero 标记透传，估算只修账面、不污染该判据。
          const rawOutputZero = (u?.outputTokens ?? 0) === 0;
          // PARSE-4 + 5.1 扩展：output 为 0 但实际有内容时用字符估算兜底。
          // 旧版仅在 in=out 皆 0 时触发（Ollama 等）；本 case（DeepSeek 思考泄漏、
          // usage 全 0 却吐了数万字符）同样命中——避免 token 成本落成账面黑洞。
          // input 已非零则保留原值，仅补 output；两者皆零才一并估算 input。
          if (u && rawOutputZero) {
            const estOut = estimateTextTokens(accumulatedOutputText);
            if (estOut > 0) {
              const inputZero = (u.inputTokens ?? 0) === 0;
              const estIn = inputZero ? OpenAIProvider.estimatePromptTokens(params) : u.inputTokens;
              const patched: Usage = {
                ...u,
                inputTokens: estIn,
                outputTokens: estOut,
              };
              accumulatedUsage = patched;
              log.debug(
                "LLM:OPENAI",
                `output usage 为 0 但有内容(${accumulatedOutputText.length}字符)，已用估算兜底`,
                patched,
              );
              yield { ...event, usage: patched, _rawOutputTokensZero: true };
              continue;
            }
          }
          // 未触发估算：仍把原始 output 是否为 0 的事实透传给下游
          yield { ...event, _rawOutputTokensZero: rawOutputZero };
          continue;
        }

        yield event;
      }

      log.debug("LLM:OPENAI", "请求完成", {
        totalMs: Date.now() - requestStartTime,
        usage: accumulatedUsage,
      });
    } catch (err: any) {
      const log = getLogger();
      log.error("LLM:OPENAI", `请求异常`, { error: err.message, stack: err.stack });
      // 接入审计日志:连接/流式异常(含超时中断、ECONNRESET)是会话 hang/中断的关键信号。
      log.warn(
        "AUDIT:API",
        `✗ OpenAI 请求异常 model=${effectiveModel} err=${(err?.message ?? String(err)).slice(0, 200)}`,
      );
      yield {
        type: "error",
        error: { message: err.message || String(err) },
      };
    }
  }

  // ─── A3: Responses API 分派方法 ────────────────────────────────────────────

  /**
   * 判断当前模型是否应走 Responses API（POST /v1/responses）。
   *
   * 优先级：
   *   1. 环境变量 SID_CODE_OPENAI_PROTOCOL 强制开关（灰度/回滚）
   *   2. model-registry 的 protocolKind 字段（精确声明）
   *   3. 非官方 OpenAI 端点 → false（DeepSeek/Kimi/Qwen 永不触发）
   *   4. /^gpt-5\./i 启发式兜底（未注册的新 GPT-5.x 模型）
   */
  private shouldUseResponsesAPI(model: string): boolean {
    try {
      // 优先级 1：环境变量强制开关
      const envForce = process.env.SID_CODE_OPENAI_PROTOCOL;
      if (envForce === "responses") return true;
      if (envForce === "chat") return false;

      // 优先级 2：catalog protocolKind 声明
      const catalog = lookupCatalog(model);
      if (catalog?.protocolKind === "openai-responses") return true;

      // 优先级 3：非官方端点绝不走 Responses
      if (!this.isOfficialOpenAIEndpoint()) return false;

      // 优先级 4：GPT-5.x 启发式兜底
      return /^gpt-5\./i.test(model);
    } catch {
      // 任何异常 fallback 到 Chat Completions（安全护栏）
      return false;
    }
  }

  /**
   * 判断当前 baseURL 是否为官方 OpenAI 端点。
   *
   * ⚠️ 这只是 shouldUseResponsesAPI 的**优先级 3**（启发式兜底前的守门），
   * **不是**"只有官方端点才走 Responses API"的总闸门——优先级 2 的 catalog
   * `protocolKind: "openai-responses"` 声明在它**之前**短路返回 true。
   *
   * 也就是说：注册在 model-registry 里声明了 openai-responses 的模型（如 gpt-5.6 族），
   * 即便跑在企业自建网关（各类 OpenAI 兼容端点）上也会走 Responses API。这是**有意的**——
   * 声明式配置的权威性高于端点启发式，否则同一模型换个网关就静默降级到
   * Chat Completions，丢掉 reasoning.effort 等 Responses 专有能力。
   *
   * 前提是网关自身实现了 `/responses`。实测自建 new-api 类网关支持（返回标准 OpenAI 形状的
   * 响应与错误体）。若某网关不支持，用 `SID_CODE_OPENAI_PROTOCOL=chat`（优先级 1）
   * 强制降级，不要改这里的判断。
   *
   * 本方法真正的作用域：**未注册**的模型名（优先级 4 的 `/^gpt-5\./` 启发式）——
   * 只有官方端点才允许靠模型名猜协议，兼容端点上的未注册模型一律走 Chat Completions。
   */
  private isOfficialOpenAIEndpoint(): boolean {
    try {
      const url = new URL(this.baseURL);
      return url.hostname === "api.openai.com";
    } catch {
      return false;
    }
  }

  /**
   * 通过 Responses API（POST /v1/responses）发送请求并产出 StreamEvent。
   * 结构对标 sendMessageStream 的 Chat Completions 路径：
   *   构造请求 → fetch（含 header/absolute timeout）→ StreamLifecycle 包装 → 消费循环
   */
  private async *sendViaResponsesAPI(
    params: SendParams,
    effectiveModel: string,
    signal?: AbortSignal,
  ): AsyncGenerator<StreamEvent> {
    const log = getLogger();
    const requestStartTime = Date.now();
    let firstTokenTime: number | null = null;
    // 归因用别名（与 Chat Completions 路径同口径）：telemetry 打别名，否则同一真名的
    // 两个渠道会被聚合成一条，分渠道统计失效。请求体用 effectiveModel（真名）。
    const attrModel = params.model || this._model;

    // 构造 Responses API 请求体
    const requestBody = buildResponsesRequest(params, effectiveModel);
    log.debug("LLM:OPENAI:RESPONSES", `发送请求到 ${this.baseURL}/responses`, {
      model: requestBody.model,
      inputCount: requestBody.input.length,
      toolCount: requestBody.tools?.length ?? 0,
      maxOutputTokens: requestBody.max_output_tokens,
    });

    // ── 响应头超时（对标 Chat Completions 路径） ──
    const headerTimeoutMs = OpenAIProvider.resolveHeaderTimeoutMs(effectiveModel);
    const headerTimeoutCtl = new AbortController();
    let headerTimedOut = false;
    const obsIndex = currentSseDumpContext().turnIndex;
    let disarmHeaderIneffective: (() => void) | null = null;
    let headerTimeoutId: ReturnType<typeof setTimeout> | null = setTimeout(() => {
      headerTimedOut = true;
      log.warn(
        "LLM:OPENAI:RESPONSES",
        `响应头超时 ${headerTimeoutMs / 1000}s（model=${effectiveModel}）`,
      );
      emitTimeoutFired(obsIndex, "header_timeout", {
        threshold_ms: headerTimeoutMs,
        model: attrModel,
      });
      disarmHeaderIneffective = armIneffectiveCheck(
        obsIndex,
        "header_timeout",
        "fetch_not_settled_after_5s",
      );
      headerTimeoutCtl.abort();
    }, headerTimeoutMs);

    // fetch 绝对上限兜底：**默认不装**（P0-3，理由见 Chat Completions 路径同名段落的长注释）。
    // 本路径的 idle 覆盖来自 lifecycle 的 idleTimeoutMs（档①，见下方 createStreamLifecycle
    // 的 idleTimeoutMs），不依赖这层 fetch 硬顶 —— 该路径的解析器
    // （parseResponsesStream → readSSEEvents）里一个定时器都没有，所以事件级 idle 就是它的档①。
    const streamTimeouts = resolveProviderStreamTimeouts({ providerKind: "openai" });
    const FETCH_ABSOLUTE_TIMEOUT_MS = streamTimeouts.fetchAbsoluteTimeoutMs;
    const fetchSignals: AbortSignal[] = [headerTimeoutCtl.signal];
    if (signal) fetchSignals.unshift(signal);
    if (FETCH_ABSOLUTE_TIMEOUT_MS !== undefined) {
      fetchSignals.push(AbortSignal.timeout(FETCH_ABSOLUTE_TIMEOUT_MS));
    }
    const fetchSignal = AbortSignal.any(fetchSignals);

    let response: Response;
    emitStreamPhase(obsIndex, "fetch_sent", { model: attrModel });
    try {
      // Responses API 端点：/responses（baseURL 已含 /v1）
      response = await fetch(`${this.baseURL}/responses`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify(sanitizeStrings(requestBody)),
        signal: fetchSignal,
        // B1-b：keep-alive 开关真消费点（同 chat/completions 流式路径）。
        ...getKeepAliveFetchOptions(),
      });
    } catch (err: any) {
      if (headerTimedOut) {
        (disarmHeaderIneffective as (() => void) | null)?.();
        throw new Error(
          `OpenAI Responses API 响应头超时 ${headerTimeoutMs / 1000}s（model=${effectiveModel}）`,
        );
      }
      throw err;
    } finally {
      if (headerTimeoutId !== null) {
        clearTimeout(headerTimeoutId);
        headerTimeoutId = null;
      }
      (disarmHeaderIneffective as (() => void) | null)?.();
    }

    // 响应头已到达。归因用别名（与 Chat Completions 路径同口径）
    emitHttpConnected(obsIndex, { status: response.status, model: attrModel });
    // G8：Responses API 路径同样提取 rate-limit header
    updateRateLimitStatus(response.headers);
    // P2-6：网关请求标识（同 Chat Completions 路径）
    recordRequestId(response.headers);

    if (!response.ok) {
      const errorBody = await response.text().catch(() => "");
      log.error("LLM:OPENAI:RESPONSES", `HTTP ${response.status}`, {
        body: errorBody.slice(0, 500),
      });
      yield {
        type: "error",
        error: {
          message: `OpenAI Responses API HTTP ${response.status}: ${errorBody.slice(0, 200)}`,
          statusCode: response.status,
        },
      };
      return;
    }

    if (!response.body) {
      yield { type: "error", error: { message: "OpenAI Responses API 返回空 body" } };
      return;
    }

    try {
      // 累积变量
      let accumulatedUsage: Usage = { inputTokens: 0, outputTokens: 0 };
      let accumulatedOutputText = "";

      // StreamLifecycle 事件级兜底。
      //
      // ⚠️ 与 Chat Completions 路径**不能照抄**（本次遥测分诊查出的真缺陷）。
      // 那条路径把 idle 放宽到 overall 同量级、且不启用 content progress 层，理由是
      // 「parseSSE 内的**字节级** idle/content 超时更严格、先触发」——那是成立的前提。
      // 但本路径的解析器 `parseResponsesStream` → `readSSEEvents` 里**一个定时器都没有**
      // （全文 setTimeout/setInterval 命中数为 0），于是照抄那套放宽等于：
      // 字节级防线不存在、事件级防线又被主动调宽到 600s，两层同时失守。
      //
      // 症状是"看着有三层超时、实测只有漏斗那层在干活"：真实轨迹里 8 个 TimeoutFired
      // 全部是 `fallback_stream_timeout`，lifecycle 三层一次没触发过。修法是把本路径的
      // idle/content 两层按 network-profile 的真实档位启用（它们本就是为"没有字节级
      // 防线"的场景准备的），让 300s 档先于漏斗的 300s+ 抓到静默流。
      const lifecycle = createStreamLifecycle<StreamEvent>({
        idleTimeoutMs: streamTimeouts.idleTimeoutMs,
        // 与 idle 分层的意义：idle 对任何事件（含 `:` keep-alive 注释行）都续命，
        // content progress 只对 content_block_delta 续命——识破"只有心跳、无真内容"。
        contentProgressTimeoutMs: streamTimeouts.contentProgressTimeoutMs,
        // 配置-3：overall 阈值走 network-profile 统一解析（复用上方 streamTimeouts）
        overallTimeoutMs: streamTimeouts.overallTimeoutMs,
        // P0-1：本路径的解析器**没有**字节级看门狗（见上方长注释），所以事件级是
        // 这条路径唯一的进展信号源 —— 不写，watchdog 就只能读到建快照那一刻的
        // lastContentProgressAt，把任何超过阈值的正常长流当成「已收首字节、彻底无进展」强杀。
        progressObsIndex: obsIndex,
        stallWarnMs: 30_000,
        label: "OPENAI-RESPONSES",
        // T14.6：收敛 first_content emit 到 lifecycle 层
        isFirstContent: (ev) => ev.type === "content_block_delta",
        requestStartTimeMs: requestStartTime,
        onFirstContentProgress: (ttftMs) => {
          if (!firstTokenTime) {
            firstTokenTime = Date.now();
            log.debug("LLM:OPENAI:RESPONSES", `首 token 延迟: ${ttftMs}ms`);
            emitStreamPhase(obsIndex, "first_content", { ttft_ms: ttftMs, model: attrModel });
          }
        },
        // 三层各自上报自己的 layer 与**自己的**阈值（对齐 anthropic.ts 的写法）。
        // 原写法把 content_progress 也归成 `idle_timeout`、且 threshold 一律报 overall 的
        // 600s：既分不清"彻底静默"与"只有心跳无内容"（两者修法不同——前者查网络/网关，
        // 后者查模型是否在空转），又让 threshold_ms 与真实触发阈值不符。
        // 错误归因比没有归因更坏，这条是本仓反复记的教训。
        onTimeout: (layer) => {
          try {
            const timeoutLayer =
              layer === "content_progress"
                ? "content_progress_timeout"
                : layer === "overall"
                  ? "turn_hard_timeout"
                  : "idle_timeout";
            const threshold =
              layer === "content_progress"
                ? streamTimeouts.contentProgressTimeoutMs
                : layer === "overall"
                  ? streamTimeouts.overallTimeoutMs
                  : streamTimeouts.idleTimeoutMs;
            emitTimeoutFired(obsIndex, timeoutLayer, {
              threshold_ms: threshold,
              model: attrModel,
            });
          } catch {
            /* 可观测性不影响主流程 */
          }
        },
        onTelemetry: (evt: StreamTelemetrySignal) => {
          log.debug("TELEMETRY:OPENAI-RESPONSES", `${evt.type}`, evt as any);
          try {
            params.onStreamTelemetry?.(evt);
          } catch {
            /* 安全 */
          }
        },
        // 用 openai-responses.ts 导出的判定函数，不再就地手写第二份。
        //
        // 两处差异是实的、且方向不利：手写这份把 `content_block_start` 也算进展，
        // 而 Responses 流每开一个 text / tool_use / reasoning 块都会发一次
        // `content_block_start` —— 一个反复开块却不产出任何 delta 的流会被它一直续命，
        // 正是这层要识破的形态。导出那份只认 `content_block_delta`，与注释里写的
        // 「只对 content_block_delta 续命」一致。
        //
        // 这份手写副本此前不影响行为，是因为 contentProgressTimeoutMs 没传、整层空转
        // （即上面修掉的缺陷）—— 层一接通，它就从死代码变成会削弱防线的活代码。
        // 一份判据两处实现，本仓已栽过多次，收敛到唯一导出。
        isContentProgress: isResponsesContentProgress,
      });

      // 消费 parseResponsesStream + StreamLifecycle 包装
      for await (const event of lifecycle.guard(parseResponsesStream(response.body, signal))) {
        // 纵深防御：signal abort 检查
        if (signal?.aborted) {
          emitStreamPhase(obsIndex, "aborted", { reason: "signal_aborted", model: attrModel });
          throw new Error("Request aborted");
        }

        // T14.6：TTFT 已收敛到 lifecycle 的 onFirstContentProgress 回调，此处不再重复检测。

        // 累积文本
        if (event.type === "content_block_delta" && event.delta.type === "text_delta") {
          accumulatedOutputText += event.delta.text;
        }

        // 累积 usage
        if (event.type === "message_delta") {
          accumulatedUsage = event.usage;
        }

        yield event;
      }

      log.debug("LLM:OPENAI:RESPONSES", "请求完成", {
        totalMs: Date.now() - requestStartTime,
        usage: accumulatedUsage,
      });
    } catch (err: any) {
      log.error("LLM:OPENAI:RESPONSES", `请求异常`, { error: err.message, stack: err.stack });
      log.warn(
        "AUDIT:API",
        `✗ OpenAI Responses API 请求异常 model=${effectiveModel} err=${(err?.message ?? String(err)).slice(0, 200)}`,
      );
      yield {
        type: "error",
        error: { message: err.message || String(err) },
      };
    }
  }

  /**
   * 非流式请求（流式降级场景使用）。
   * 复用 convertMessages，用普通 chat/completions 请求（stream:false）。
   */
  /**
   * 非流式请求（网关不支持 SSE 时由 stream-handler 降级到此，也被 warmup / 分类器等旁路直接调用）。
   *
   * 这层只做**能力自愈**，真正的请求在 sendMessageNonStreamingInner。
   * 与流式路径的 withCapabilityHealing 严格同构：首次因「我们多发了一个模型不认的能力字段」
   * 而失败时，剥掉该字段重试一次。
   *
   * 为什么非流式也必须有（2026-08-01 补齐）：此前只有流式包了自愈，于是同一个未知模型
   * 「流式能自愈、降级到非流式就不能」——而降级本身往往发生在网关异常的时候，正是最不该
   * 再叠加一个可自愈失败的时刻。自愈是「永不报错」的执行层，两条路径的能力必须对称，
   * 否则用户遇到的行为取决于当时走了哪条路，无法解释也无法复现。
   */
  async sendMessageNonStreaming(
    params: SendParams,
    signal?: AbortSignal,
  ): Promise<AccumulatedResponse> {
    // 与流式自愈同源：能力记账按真名，见 withCapabilityHealing 注释。
    const model = pickWireModel(params, this._model);
    try {
      return await this.sendMessageNonStreamingInner(params, signal);
    } catch (err) {
      // 只自愈「我们自己多发的能力字段」，且必须确实发了它——其余错误（鉴权、限流、
      // 上下文超限、模型不存在）原样抛出，盲目重试只会掩盖真问题。
      if (params.reasoningEffort === undefined) throw err;
      const msg = err instanceof Error ? err.message : String(err);
      // 与流式路径同一套判据：措辞匹配（顺带学档位）**或** 结构匹配（HTTP 4xx 兜底）。
      const advice = learnFromError(model, msg);
      const structural = shouldRetryWithoutEffort({
        statusCode: extractHTTPStatus(err),
        errorMessage: msg,
      });
      if (!advice.dropEffort && !structural) throw err;
      getLogger().debug(
        "LLM:OPENAI",
        `能力自愈（非流式）：${model} 拒绝 reasoning_effort，剥离该字段重试`,
        { error: msg.slice(0, 160) },
      );
      const healed = await this.sendMessageNonStreamingInner(
        { ...params, reasoningEffort: undefined },
        signal,
      );
      // 走到这里说明重试**没有抛错**即成功——记账让下次不再多这一跳。
      // （抛错会直接冒泡出去，不会执行到这行，天然满足「只在成功后记」。）
      recordEffortRejected(model);
      getLogger().debug("LLM:OPENAI", `能力自愈完成（非流式）：${model}`);
      return healed;
    }
  }

  private async sendMessageNonStreamingInner(
    params: SendParams,
    signal?: AbortSignal,
  ): Promise<AccumulatedResponse> {
    // D1-1：发送前协议完整性关卡（非流式路径同样校验）
    guardOutgoingMessages(params.messages, { providerName: this.name() });
    // 真名：与流式 sendMessageStreamInner 严格同源（进请求体 + 做协议/参数判据）。
    // 两条路径必须同口径，否则「降级到非流式」会顺带换掉发出去的模型名。
    const effectiveModel = pickWireModel(params, this._model);

    // P0-5：协议分派必须与流式路径同源。此前本函数**无条件**打 /chat/completions，
    // 只有 sendMessageStreamInner 做分派 —— 于是 GPT-5.x 走三条降级路径
    //（流式传输错误降级 / 空流降级 / ModelFallback）时静默换协议：请求以 Chat 线格式
    // 发出、丢掉 Responses 专属能力，网关若不提供 Chat 端点还会二次失败（而降级恰好
    // 发生在网关已经异常的时刻），更关键的是缓存与用量口径分裂（命中键 Chat 在
    // prompt_tokens_details、Responses 在 input_tokens_details）。
    if (this.shouldUseResponsesAPI(effectiveModel)) {
      return await this.sendNonStreamingViaResponsesAPI(params, effectiveModel, signal);
    }

    // 与流式路径同口径传别名（compat 查表用），漏传即「非流式路径上用户声明静默失效」。
    const messages = this.convertMessages(params.messages, effectiveModel, params.model);
    // 与流式路径共用同一转换（含 schema 方言清理），避免两条线的 schema 形状漂移。
    const tools = OpenAIProvider.convertTools(effectiveModel, params.tools);

    const requestBody: any = {
      model: effectiveModel,
      messages,
      stream: false,
    };
    // §3.2：o-series 用 max_completion_tokens，其余用 max_tokens
    this.applyMaxTokens(requestBody, params.maxTokens, effectiveModel);
    // §2.1/§2.2/§2.6：DeepSeek 思考开关 / reasoning_effort / user_id 透传
    // （⚠️ 必须与流式路径同步：网关不支持 SSE 降级到此路径时，开关/强度才不会丢失）
    this.applyDeepSeekThinking(requestBody, params, effectiveModel);
    if (params.system) {
      // §3.1：o-series 用 developer role，其余 system；并避免重复注入(§4.1)
      this.prependSystemMessage(requestBody.messages, params.system, effectiveModel);
    }
    if (tools && tools.length > 0) {
      requestBody.tools = tools;
      // §4.2/§2.4：工具调用策略透传（DeepSeek 思考模式跳过 tool_choice）
      this.applyToolChoice(requestBody, params, effectiveModel);
    }

    // § P1: model-capability-filter 参数过滤（与流式路径对齐，须在字段赋值之后执行才生效）。
    filterParamsForModel(effectiveModel, requestBody);

    const log = getLogger();
    log.debug("LLM:OPENAI", "非流式请求", { model: requestBody.model });

    const response = await fetch(`${this.baseURL}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify(sanitizeStrings(requestBody)),
      signal,
      // B1-b：非流式路径同样消费 keep-alive 开关——它是流式失败后的降级路径，
      // 若这里仍复用死 socket，降级会跟着一起失败。
      ...getKeepAliveFetchOptions(),
    });

    // G8：非流式路径同样提取 rate-limit header
    updateRateLimitStatus(response.headers);

    if (!response.ok) {
      const errText = await response.text();
      const err = new Error(`OpenAI API 错误: ${response.status} ${errText}`);
      // 挂上状态码：能力自愈的结构判据看 HTTP 码而非措辞（网关可能只回 "400 Bad Request"）。
      // 用 statusCode + status 两个名字，兼容 errors.ts::extractHTTPStatus 的两种读法。
      (err as any).statusCode = response.status;
      (err as any).status = response.status;
      throw err;
    }

    const data: any = await response.json();
    const choice = data.choices?.[0];
    const msg = choice?.message ?? {};
    const content: ContentBlock[] = [];

    // §2.3：DeepSeek reasoning_content（思考链）。非流式路径此前完全忽略此字段——
    // 不仅 TUI 丢失思考过程，更关键的是下一轮回放该 assistant 消息时缺 reasoning_content，
    // 与流式路径行为不一致。这里对齐 stream-processor：思考块放在文本块**之前**入 content
    //（思考先于答复），并在 _meta 保存原文供 convertMessages 下轮回传。
    const reasoningContent: string =
      typeof msg.reasoning_content === "string" ? msg.reasoning_content : "";
    if (reasoningContent.length > 0) {
      content.push({ type: "thinking", thinking: reasoningContent });
    }

    if (typeof msg.content === "string" && msg.content.length > 0) {
      // 部分 OpenAI 兼容模型（GPT-5.4 等）以内联 <think>...</think> 标签返回思考过程，
      // 而非通过结构化 reasoning_content 字段。若不提取，标签会作为普通文本泄漏到 TUI。
      // 仅在尚未从 reasoning_content 提取到思考块时才尝试（避免重复）。
      if (reasoningContent.length === 0) {
        const extracted = extractInlineThinkTags(msg.content);
        if (extracted.thinking) {
          content.push({ type: "thinking", thinking: extracted.thinking });
        }
        // <internal_en> 归位：中文铁律模式的提示词允许模型把英文技术思考包进该标签
        // （见 system-prompt.ts 思考语言疏导段）。标签只是给模型的书写协议，不该泄漏到
        // 正文——与 <think> 同样处理成 thinking 块，思考区照常可见、正文保持纯中文。
        const en = extractInternalEnTags(extracted.text);
        if (en.thinking) {
          content.push({ type: "thinking", thinking: en.thinking });
        }
        if (en.text) {
          content.push({ type: "text", text: en.text });
        }
      } else {
        // reasoning_content 已提供思考链，但正文里仍可能带 <internal_en>（两条通道不互斥）。
        const en = extractInternalEnTags(msg.content);
        if (en.thinking) {
          content.push({ type: "thinking", thinking: en.thinking });
        }
        if (en.text) {
          content.push({ type: "text", text: en.text });
        }
      }
    }
    if (Array.isArray(msg.tool_calls)) {
      for (const tc of msg.tool_calls) {
        let input: unknown = {};
        try {
          input = tc.function?.arguments ? JSON.parse(tc.function.arguments) : {};
        } catch {
          input = {};
        }
        content.push({
          type: "tool_use",
          id: tc.id || "",
          name: tc.function?.name || "",
          input,
        });
      }
    }

    const finishReason = choice?.finish_reason;
    const stopReason = OpenAIProvider.mapFinishReason(finishReason);

    // §4.4：DeepSeek 特有 insufficient_system_resource（deepseek-api.md:2094-2096）。
    // 非流式路径同样须视为可重试——抛错让上层（stream-handler 降级路径 / warmup 等）经
    // classifyError 归为 overloaded 触发重试，而非返回一个静默截断的 end_turn 式响应。
    if (finishReason === "insufficient_system_resource") {
      throw new Error("DeepSeek insufficient_system_resource（推理系统资源不足，可重试）");
    }

    // §2.1：内容审查拒绝。模型触发安全策略时返回 `refusal`（拒绝理由）而非 `content`。
    // 此前完全未解析——若 refusal 非空而 content 为空，会得到无任何块的空响应，
    // 表现为"模型莫名没回复"。这里在正文均空时把 refusal 文本兜底为 text 块，
    // 至少让用户/上层看到拒绝原因，并标注来源。
    if (content.length === 0 && typeof msg.refusal === "string" && msg.refusal.length > 0) {
      content.push({ type: "text", text: `[模型拒绝] ${msg.refusal}` });
      getLogger().warn("LLM:OPENAI", `模型返回 refusal: ${msg.refusal.slice(0, 200)}`);
    }

    // 缓存命中数：见 extractOpenAICacheHit 的字段兜底说明（流式/非流式单一事实源）。
    const cacheHit = extractOpenAICacheHit(data.usage);
    // 缺口分析二类：推理 token 单独计数（completion_tokens 子集，不叠加 output）。
    const reasoning = extractOpenAIReasoningTokens(data.usage);

    return {
      role: "assistant",
      content,
      stopReason,
      usage: {
        inputTokens: data.usage?.prompt_tokens ?? 0,
        outputTokens: data.usage?.completion_tokens ?? 0,
        ...(cacheHit > 0 ? { cacheReadInputTokens: cacheHit } : {}),
        ...(reasoning > 0 ? { reasoningTokens: reasoning } : {}),
      },
      // §2.3：reasoning_content 存入 _meta，供 convertMessages 下轮按需回传
      //（与流式路径 stream-processor 的 response._meta 同源）。
      ...(reasoningContent.length > 0 ? { _meta: { reasoning_content: reasoningContent } } : {}),
    };
  }

  /**
   * 非流式 Responses API 请求（P0-5）。
   *
   * 与流式 {@link sendViaResponsesAPI} 共用请求构造（`buildResponsesRequest`）与 usage
   * 提取（`parseResponsesBody` → `applyResponsesUsage`），只把 `stream` 翻成 false —— 刻意
   * 不写第二份提取逻辑，否则两条路径的缓存口径会再次分裂（正是本次要修的病）。
   *
   * 请求形状差异只有一处：Responses 的 `stream` 字段在类型上声明为字面量 `true`
   *（流式是唯一原本的用法），这里覆盖成 false 后 cast，避免为一个布尔值放宽公共类型。
   */
  private async sendNonStreamingViaResponsesAPI(
    params: SendParams,
    effectiveModel: string,
    signal?: AbortSignal,
  ): Promise<AccumulatedResponse> {
    const log = getLogger();
    const streamingBody = buildResponsesRequest(params, effectiveModel);
    const requestBody = { ...streamingBody, stream: false };

    log.debug("LLM:OPENAI:RESPONSES", "非流式请求", {
      model: requestBody.model,
      inputCount: requestBody.input.length,
      toolCount: requestBody.tools?.length ?? 0,
    });

    const response = await fetch(`${this.baseURL}/responses`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify(sanitizeStrings(requestBody)),
      signal,
      // 与 Chat 非流式路径同口径：降级路径若复用死 socket，降级会跟着一起失败。
      ...getKeepAliveFetchOptions(),
    });

    // G8：与 Chat 路径一致地提取 rate-limit header
    updateRateLimitStatus(response.headers);

    if (!response.ok) {
      const errText = await response.text();
      const err = new Error(`OpenAI Responses API 错误: ${response.status} ${errText}`);
      // 挂状态码：能力自愈的结构判据看 HTTP 码而非措辞（见 sendMessageNonStreaming）
      (err as any).statusCode = response.status;
      (err as any).status = response.status;
      throw err;
    }

    const body = (await response.json()) as ResponsesNonStreamingBody;

    // 顺带把 Responses 的失败态转成异常，让上层 classifyError 决定是否重试；
    // 否则 status=failed 会被当成一个内容为空的正常回合（静默截断）。
    if (body.status === "failed") {
      throw new Error(`OpenAI Responses API 返回 failed: ${body.error?.message ?? "未知原因"}`);
    }

    const parsed = parseResponsesBody(body);
    return {
      role: "assistant",
      content: parsed.content as ContentBlock[],
      stopReason: parsed.stopReason,
      usage: parsed.usage,
    };
  }

  /**
   * 解析 SSE 流，转换为统一的 StreamEvent
   * 支持多工具并行调用：用 Map<index, ToolCallState> 追踪每个工具调用
   */
  private async *parseSSE(
    stream: ReadableStream<Uint8Array>,
    signal?: AbortSignal,
  ): AsyncIterable<StreamEvent> {
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let nextContentIndex = 0;
    let textBlockStarted = false;
    let textBlockIndex = -1;
    // 多工具并行追踪：key 是 OpenAI 的 tool_call index
    const toolCalls = new Map<number, ToolCallState>();
    const usage: Usage = { inputTokens: 0, outputTokens: 0 };
    const requestStartAt = Date.now();
    let lastContentProgressAt = Date.now();
    /**
     * PR9：`lastContentProgressAt` 那一刻的休眠账本读数。
     *
     * 两个变量必须成对更新（`markContentProgress()` 是唯一入口），否则扣减会算错方向：
     * 账本是**进程级累计值**，只记起点不更新 → 之后每次核对都把这次进展之前的历史休眠
     * 又减一遍，越睡越"欠"，判据永远到不了点（把误杀换成漏杀，一样是缺陷）。
     */
    let sleepAtLastProgress = getSleepLedger().getTotalMs();
    const markContentProgress = () => {
      lastContentProgressAt = Date.now();
      sleepAtLastProgress = getSleepLedger().getTotalMs();
    };
    // 休眠观测器：本函数内的字节级判据依赖账本，账本要有人来记
    // （一次性 setTimeout 自己观测不到休眠，理由见 sleep-detect.ts 的 startSleepObserver）。
    const releaseSleepObserver = startSleepObserver();
    /** 诊断日志：SID_CODE_DEBUG_SSE=1 启用，打印关键事件到 stderr */
    const debugSse = process.env.SID_CODE_DEBUG_SSE === "1";
    const dbg = (msg: string) => {
      if (debugSse) process.stderr.write(`[SSE] ${msg}\n`);
    };
    let totalChunks = 0;
    let emptyChunks = 0;
    /** 延迟 message_delta：finish_reason 和 usage 可能在不同 chunk 中 */
    let pendingFinishReason: string | null = null;
    // DeepSeek reasoning_content 追踪
    let reasoningBlockStarted = false;
    let reasoningContent = "";

    // 5.2：逐 chunk 采样落盘（默认关闭，SID_CODE_DEBUG_SSE_DUMP=1 启用）。
    // 用于排查"思考走哪个字段、哪个 chunk 从 reasoning_content 切到 content"。
    const dumpCtx = currentSseDumpContext();
    const chunkDumper = new SseChunkDumper(dumpCtx.sessionId, dumpCtx.turnIndex, requestStartAt);
    // 缺口 1：parseSSE 内的 turn index（用于 StreamPhase/TimeoutFired/StreamStall 事件）
    const parseObsIndex = dumpCtx.turnIndex;

    // 流式看门狗阈值统一走 network-profile（必删-1/-2 + 配置-3）：
    //   - idle：N 秒内 reader 无任何 chunk → 断开（半开 TCP 兜底）
    //   - content progress：即使 reader 持续 settle（空行/ping），无有效内容进展也超时中断
    // 不再按 /deepseek/i 分档（原 90/180s、120/300s 违反 network-profile 顶部原则，
    // 且非 deepseek 慢模型 qwen/kimi/glm 长文会被偏紧的 90s 误杀）。统一取一套够宽的默认值。
    // 覆盖顺序 env > settings.network > 默认（PR10：此前 settings 那层不存在，四项是伪配置）。
    // 具体取值见 network-profile.ts 的档①/档② 注释 —— 这里刻意不重复数字，
    // 免得注释与唯一真相源各说一套。
    const streamTimeouts = resolveProviderStreamTimeouts({ providerKind: "openai" });
    const IDLE_TIMEOUT_MS = streamTimeouts.idleTimeoutMs;
    const CONTENT_PROGRESS_TIMEOUT_MS = streamTimeouts.contentProgressTimeoutMs;

    /** 30s stall 日志（只记不杀，对齐 claude-code，给弱模型喘息空间） */
    const STALL_LOG_MS = 30_000;
    let stallEmitted = false; // 缺口 1：每次流只发一次 StreamStall 事件（避免 events.jsonl 膨胀）
    const stallLogger = setInterval(() => {
      // PR9：stall 口径同样扣休眠。它只记不杀，但记错了一样有害 ——
      // 一次长休眠会让 events.jsonl 里凭空多出一条"无进展 281s"的 StreamStall，
      // 而那 281s 机器根本没在跑。排查的人拿它当卡死证据就会追错方向。
      const elapsed =
        Date.now() -
        lastContentProgressAt -
        Math.max(0, getSleepLedger().getTotalMs() - sleepAtLastProgress);
      // P0-1：**无条件**每 tick 写一次快照，不再被 `elapsed >= STALL_LOG_MS` 门控。
      //
      // 原写法把「要不要告警」与「要不要更新快照」压在同一个 if 里，后果是一条
      // 一直有进展的慢流（reasoning_content 每 10~25s 吐一批，elapsed 永远到不了 30s）
      // **一次都不会写快照** —— 于是 `query/loop.ts` 的 watchdog 读到的永远是建快照时
      // 的初始值 `chunksReceived: 0` / `lastContentProgressAt = 建快照时刻`，
      // 判成「彻底卡死」强杀。实测形态：WatchdogKill 报 total_chunks=0，
      // 而同一条流的 RetryTelemetry 录得 11183 个 SSE 事件。
      //
      // stall 判定继续保留，但**只决定要不要发 StreamStall / 写调试日志**。
      updateStreamStats(parseObsIndex, {
        chunksReceived: totalChunks,
        emptyChunks,
        lastContentProgressAt,
      });
      if (elapsed >= STALL_LOG_MS) {
        dbg(
          `stall: ${(elapsed / 1000).toFixed(0)}s 无内容进展 chunks=${totalChunks} empty=${emptyChunks}`,
        );
        // 缺口 1：每 60s 记录一次 StreamStall 事件（首次 30s 触发后不重复）
        if (!stallEmitted) {
          stallEmitted = true;
          emitStreamStall(parseObsIndex, {
            no_content_progress_ms: elapsed,
            total_chunks: totalChunks,
            empty_chunks: emptyChunks,
          });
        }
      }
    }, STALL_LOG_MS);

    // Fix 1: signal abort promise — 让用户 ESC/Ctrl+C 能打断已进入 SSE 消费的流
    // 在外部创建一次，避免每次循环创建新 listener 导致泄漏
    // 预先 abort 走循环顶部快速检查（第 838 行），不在此创建 reject Promise（避免 unhandled rejection）
    let signalAbortHandler: (() => void) | null = null;
    const abortPromise =
      signal && !signal.aborted
        ? new Promise<never>((_, reject) => {
            signalAbortHandler = () => reject(new Error("Request aborted"));
            signal.addEventListener("abort", signalAbortHandler, { once: true });
          })
        : null;

    // 空转崩溃修复：收到 [DONE] 后置位，让外层 while 立即退出，不再 reader.read()。
    let streamDone = false;
    try {
      // 缺口 1：记录进入 SSE 消费阶段
      emitStreamPhase(parseObsIndex, "sse_consuming", { model: this._model });
      while (true) {
        // 前置检查：循环顶部快速判断（方案 B 补充，覆盖 reader.read() settle 后的盲区）
        if (signal?.aborted) {
          reader.cancel().catch(() => {});
          throw new Error("Request aborted");
        }

        // idle timeout 默认启用：reader 超时后 reject + cancel 释放底层 TCP 连接
        const readPromise = reader.read();
        let timeoutId: ReturnType<typeof setTimeout> | null = null;
        // 性能修复：此前 cancelTimeoutId 无句柄、永不 clearTimeout，每次 reader.read()
        // 泄漏一个存活 IDLE_TIMEOUT_MS+100ms 的定时器。token 级流式下每秒泄漏数百个，
        // Bun 定时器堆膨胀 → 高频 timer syscall + 调度抢占（实测 7700/s involuntary ctx switch）。
        let cancelTimeoutId: ReturnType<typeof setTimeout> | null = null;
        // 缺口 2 进阶：idle 超时 fire 后武装未生效检查；race settle 时 disarm。
        let disarmIdleIneffective: (() => void) | null = null;
        // PR9：本次 read 的休眠感知窗口（每次 read 新建一个 —— 字节级 idle 的语义就是
        // "这一次 read 挂起了多久"）。回调里必须二次核对：休眠后 setTimeout 会被
        // 唤醒即补发，"fire 了"≠"真过了 IDLE_TIMEOUT_MS"。
        const readDeadline = createSleepAwareDeadline(IDLE_TIMEOUT_MS);
        // idle 真到点时的开枪动作。抽成闭包（不是 function 声明——那会丢掉 `this`）：
        // 让"休眠补发→重排"与"真到点→开枪"两条分支共用同一份 log/emit/reject 代码，
        // 避免两份副本各自演化成"改一处漏一处"。
        const fireIdleTimeout = (reject: (e: Error) => void) => {
          // 升 warn：debug:false 下经 logger 的 ERROR/WARN→stderr 兜底留痕（见 logger.ts log()）。
          // 空闲超时是关键异常信号，事故复盘必须可见，不能只靠 SID_CODE_DEBUG_SSE 开关。
          getLogger().warn(
            "SSE",
            `空闲超时 ${IDLE_TIMEOUT_MS / 1000}s 无 chunk（chunks=${totalChunks} empty=${emptyChunks}），中断流`,
          );
          // 缺口 2：记录 idle 超时触发
          emitTimeoutFired(parseObsIndex, "idle_timeout", {
            threshold_ms: IDLE_TIMEOUT_MS,
            chunks: totalChunks,
            empty_chunks: emptyChunks,
            model: this._model,
          });
          // 缺口 2 进阶：武装未生效检查（reject 后若 race 未 settle → TimeoutIneffective）
          disarmIdleIneffective = armIneffectiveCheck(
            parseObsIndex,
            "idle_timeout",
            "read_race_not_settled_after_5s",
          );
          reject(
            new Error(
              `SSE 流空闲超时：${IDLE_TIMEOUT_MS / 1000} 秒无 chunk chunks=${totalChunks} empty=${emptyChunks}`,
            ),
          );
        };
        const timeoutPromise = new Promise<never>((_resolve, reject) => {
          const armRead = (delayMs: number) => {
            timeoutId = setTimeout(() => {
              const remaining = readDeadline.remainingMs();
              if (remaining > 0) {
                getLogger().warn(
                  "SSE",
                  `idle 定时器被休眠补发（已剔除 ${(readDeadline.sleepMs() / 1000).toFixed(0)}s），` +
                    `距真正到期还有 ${(remaining / 1000).toFixed(0)}s，重排而非中断`,
                );
                armRead(remaining);
                // cancel 定时器同步顺延，否则它会在 reject 之前把 reader 关掉。
                if (cancelTimeoutId !== null) clearTimeout(cancelTimeoutId);
                cancelTimeoutId = setTimeout(() => {
                  reader.cancel().catch(() => {});
                }, remaining + 100);
                return;
              }
              fireIdleTimeout(reject);
            }, delayMs);
          };
          armRead(IDLE_TIMEOUT_MS);
          // 超时后 cancel reader，释放底层 TCP 连接（+100ms 确保 reject 先传播）
          cancelTimeoutId = setTimeout(() => {
            reader.cancel().catch(() => {});
          }, IDLE_TIMEOUT_MS + 100);
        });

        let result: Awaited<ReturnType<typeof reader.read>>;
        try {
          const racers: Promise<any>[] = [readPromise, timeoutPromise];
          if (abortPromise) racers.push(abortPromise);
          result = await Promise.race(racers);
        } finally {
          if (timeoutId !== null) clearTimeout(timeoutId);
          if (cancelTimeoutId !== null) clearTimeout(cancelTimeoutId);
          // race 已 settle（read 返回 / idle reject / abort reject）→ disarm idle 未生效检查。
          (disarmIdleIneffective as (() => void) | null)?.();
        }

        const { done, value } = result;
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";

        for (const line of lines) {
          if (!line.trim() || line.startsWith(":")) continue;
          if (!line.startsWith("data: ")) continue;

          const data = line.slice(6);
          if (data === "[DONE]") {
            markContentProgress();
            dbg(
              `[DONE] received after ${Date.now() - requestStartAt}ms chunks=${totalChunks} empty=${emptyChunks}`,
            );
            // 缺口 1：记录流正常完成 + 更新最终统计
            emitStreamPhase(parseObsIndex, "completed", {
              chunks: totalChunks,
              empty_chunks: emptyChunks,
              duration_ms: Date.now() - requestStartAt,
              model: this._model,
              // P2-3：OpenAI 族的 usage 只在流**尾部**下发（上面 chunk.usage 分支），
              // 首内容时刻拿不到命中数，所以缓存维度挂在 completed 而不是 first_content。
              // 消费侧因此需要把 first_content(ttft) 与 completed(cache_hit) 按
              // (session, index, 出现顺序) 配对 —— 见 digest.ts 的 TTFT 分桶实现。
              ...cacheDimsFor(usage.cacheReadInputTokens ?? 0),
            });
            updateStreamStats(parseObsIndex, {
              chunksReceived: totalChunks,
              emptyChunks,
              lastContentProgressAt,
            });
            // [DONE] 前 flush 延迟的 message_delta（此时 usage 已更新）
            if (pendingFinishReason) {
              yield {
                type: "message_delta",
                delta: {
                  stop_reason: OpenAIProvider.mapFinishReason(pendingFinishReason),
                },
                usage,
              };
              pendingFinishReason = null;
            }
            yield { type: "message_stop" };
            // 空转崩溃修复（2026-07 迁移 skill 崩溃复盘）：收到 [DONE] 表示流已逻辑完成，
            // 必须立即跳出、不再 reader.read()。此前用 continue 继续读，正常情况下服务端会
            // 紧接着 EOF 让 read() 返回 done；但某些网关在 [DONE] 后会把 socket 挂起数十秒
            // 才 RST（实测 39s），这期间流其实早已完成却卡在读取上，最终 socket 错误还会经
            // finally 的 reader.cancel() 逃逸成 unhandledRejection 崩溃。置 streamDone 跳出
            // 外层 while，从源头消除这段空转窗口。
            streamDone = true;
            break;
          }

          try {
            const chunk = JSON.parse(data);
            chunkDumper.record(chunk); // 5.2：采样（未启用时空转）

            // §3.3：流中途的 API error chunk（配额超限/内容过滤/上游中断）。
            // 此前只看 choices/usage，error 被 `!delta && !finishReason` 静默跳过，
            // 表现为"流莫名结束/空响应/超时"。这里显式 yield error 并终止流。
            if (chunk.error) {
              const msg = chunk.error.message || JSON.stringify(chunk.error);
              dbg(`stream error chunk: ${msg}`);
              // T6：透传结构化 error.type/code + streamLevel 标记，让 fallback.ts 按
              // 结构化字段判定重试（OpenAI 族 error 对象常带 type/code 但 message 无关键词）。
              yield {
                type: "error",
                error: {
                  message: `OpenAI 流内错误: ${msg}`,
                  type: chunk.error.type || chunk.error.code,
                  streamLevel: true,
                },
              };
              return;
            }

            const delta = chunk.choices?.[0]?.delta;
            const finishReason = chunk.choices?.[0]?.finish_reason;
            totalChunks++;

            // Token 用量（可能在任何 chunk 中，包括 choices 为空的最终 chunk）
            if (chunk.usage) {
              usage.inputTokens = chunk.usage.prompt_tokens || 0;
              usage.outputTokens = chunk.usage.completion_tokens || 0;
              // 缓存命中数：见 extractOpenAICacheHit 的字段兜底说明（与非流式共用）。
              const cacheHit = extractOpenAICacheHit(chunk.usage);
              if (cacheHit > 0) usage.cacheReadInputTokens = cacheHit;
              // 缺口分析二类：推理 token 单独计数（completion_tokens 子集，不叠加 output）。
              const reasoning = extractOpenAIReasoningTokens(chunk.usage);
              if (reasoning > 0) usage.reasoningTokens = reasoning;
            }

            if (!delta && !finishReason) continue;

            // 跟踪有效内容进展（供 stall 日志 + content progress timeout 使用）
            // content/tool_calls/finish_reason/reasoning_content 均视为有效进展
            const hasContent = typeof delta?.content === "string" && delta.content.length > 0;
            const hasToolCalls = Array.isArray(delta?.tool_calls) && delta.tool_calls.length > 0;
            const hasReasoning =
              typeof delta?.reasoning_content === "string" && delta.reasoning_content.length > 0;
            if (hasContent || hasToolCalls || hasReasoning || finishReason) {
              markContentProgress();
            } else {
              emptyChunks++;
            }

            // DeepSeek reasoning_content（思考链）
            if (delta?.reasoning_content) {
              if (!reasoningBlockStarted) {
                reasoningBlockStarted = true;
                yield {
                  type: "content_block_start",
                  index: nextContentIndex,
                  content_block: { type: "text", text: "" },
                  _raw_block: { type: "thinking" },
                };
                nextContentIndex++;
              }
              reasoningContent += delta.reasoning_content;
              yield {
                type: "content_block_delta",
                index: nextContentIndex - 1,
                delta: { type: "text_delta", text: delta.reasoning_content },
              };
            }

            // 文本内容
            if (delta?.content) {
              if (reasoningBlockStarted && !textBlockStarted) {
                yield { type: "content_block_stop", index: nextContentIndex - 1 };
                reasoningBlockStarted = false;
              }
              if (!textBlockStarted) {
                textBlockStarted = true;
                textBlockIndex = nextContentIndex;
                yield {
                  type: "content_block_start",
                  index: nextContentIndex,
                  content_block: { type: "text", text: "" },
                };
                nextContentIndex++;
              }
              yield {
                type: "content_block_delta",
                index: textBlockIndex,
                delta: { type: "text_delta", text: delta.content },
              };
            }

            // §2.1：流式内容审查拒绝。模型触发安全策略时在 delta.refusal 推送拒绝理由
            // 而非 delta.content。此前完全未解析 → 拒绝场景静默丢失，表现为空响应。
            // 这里复用文本块通道把 refusal 文本透传，让用户看到拒绝原因（与非流式路径一致）。
            if (delta?.refusal) {
              if (reasoningBlockStarted && !textBlockStarted) {
                yield { type: "content_block_stop", index: nextContentIndex - 1 };
                reasoningBlockStarted = false;
              }
              if (!textBlockStarted) {
                textBlockStarted = true;
                textBlockIndex = nextContentIndex;
                yield {
                  type: "content_block_start",
                  index: nextContentIndex,
                  content_block: { type: "text", text: "" },
                };
                nextContentIndex++;
              }
              yield {
                type: "content_block_delta",
                index: textBlockIndex,
                delta: { type: "text_delta", text: delta.refusal },
              };
              markContentProgress();
            }

            // 工具调用（支持多个并行）
            if (delta?.tool_calls) {
              // 如果 reasoning 块还开着（没有 content 的情况下直接到 tool_calls），先关闭
              if (reasoningBlockStarted) {
                yield { type: "content_block_stop", index: nextContentIndex - 1 };
                reasoningBlockStarted = false;
              }
              for (const tc of delta.tool_calls) {
                const tcIndex = tc.index ?? 0;

                if (!toolCalls.has(tcIndex)) {
                  // 新工具调用开始
                  // 如果文本块已开始，先关闭它
                  if (textBlockStarted) {
                    yield { type: "content_block_stop", index: textBlockIndex };
                    textBlockStarted = false;
                  }

                  const contentIdx = nextContentIndex;
                  const state: ToolCallState = {
                    id: tc.id || "",
                    name: tc.function?.name || "",
                    arguments: "",
                    contentIndex: contentIdx,
                  };
                  toolCalls.set(tcIndex, state);
                  nextContentIndex = contentIdx + 1;

                  yield {
                    type: "content_block_start",
                    index: state.contentIndex,
                    content_block: {
                      type: "tool_use",
                      id: state.id,
                      name: state.name,
                      input: {},
                    },
                  };
                }

                const state = toolCalls.get(tcIndex)!;

                // 补充 id（首个 chunk 可能没有 id）
                if (tc.id && !state.id) {
                  state.id = tc.id;
                }
                // 补充 name
                if (tc.function?.name && !state.name) {
                  state.name = tc.function.name;
                }

                if (tc.function?.arguments) {
                  state.arguments += tc.function.arguments;
                  yield {
                    type: "content_block_delta",
                    index: state.contentIndex,
                    delta: {
                      type: "input_json_delta",
                      partial_json: tc.function.arguments,
                    },
                  };
                }
                // F3：记录工具参数增量（区分 identity-only 退化 vs broken-JSON）
                dbg(
                  `tool_call[${tcIndex}] name=${state.name || "?"} ` +
                    `args_delta_len=${tc.function?.arguments?.length ?? 0} ` +
                    `args_acc_len=${state.arguments.length}`,
                );
              }
            }

            // 完成：延迟 message_delta，等 usage chunk 到达后再 yield
            if (finishReason) {
              // 关闭 reasoning 块（如果还没关闭）
              if (reasoningBlockStarted) {
                yield { type: "content_block_stop", index: nextContentIndex - 1 };
                reasoningBlockStarted = false;
              }

              // 关闭文本块（如果还没关闭）
              if (textBlockStarted) {
                yield { type: "content_block_stop", index: textBlockIndex };
                textBlockStarted = false;
              }

              // 关闭所有工具调用块
              for (const [, state] of toolCalls) {
                // F3：工具块关闭时记录最终参数特征——
                // args_len=0 → identity-only 退化（模型完全没填参数）；
                // args_len>0 但 JSON.parse 失败 → broken-JSON（参数被发但截断/非法）。
                // 二者在 stream-processor 都落成 input={}，但根因不同，此日志用于区分。
                if (debugSse) {
                  let parseOk = true;
                  try {
                    if (state.arguments) JSON.parse(state.arguments);
                    else parseOk = state.arguments.length === 0 ? false : true;
                  } catch {
                    parseOk = false;
                  }
                  dbg(
                    `tool_call close: name=${state.name || "?"} ` +
                      `finish=${finishReason} args_len=${state.arguments.length} ` +
                      `args_valid_json=${state.arguments.length > 0 && parseOk} ` +
                      `${state.arguments.length === 0 ? "[EMPTY-PARAM 退化]" : ""}`,
                  );
                }
                yield { type: "content_block_stop", index: state.contentIndex };
              }

              // §4.4：DeepSeek 特有 insufficient_system_resource（推理系统资源不足中断，
              // deepseek-api.md:2094-2096 明确要求 openai.ts 视为可重试）。此前落 default→end_turn
              // 被当成正常结束，回答静默截断且不重试。这里显式转成 error 事件，让 fallback.ts
              // 的 classifyError 归为 overloaded → 触发重试/降级链，而非吞掉。
              if (finishReason === "insufficient_system_resource") {
                dbg(`finish_reason=insufficient_system_resource → 转可重试 error`);
                yield {
                  type: "error",
                  error: {
                    message: "DeepSeek insufficient_system_resource（推理系统资源不足，可重试）",
                  },
                };
                return;
              }

              pendingFinishReason = finishReason;
            }
          } catch (parseErr) {
            // 跳过无法解析的行
          }
        }

        // 空转崩溃修复：[DONE] 已处理完（含 message_stop / 延迟 message_delta 的 yield），
        // 跳出外层 while，不再 reader.read()（否则会卡在网关延迟关闭的 socket 上空转）。
        if (streamDone) break;

        // Fix 2: content progress timeout — 每次 reader.read() settle 后检查
        // 即使 TCP 层有字节到达（空行/ping），只要无有效内容进展就超时中断
        //
        // PR9：扣除休眠。本处是**同步核对**（不是定时器回调），所以不存在"补发的一枪"，
        // 但挂钟差值同样会把休眠算进去 —— 一次 281s 的休眠足以让一条真实无进展 3.4s 的
        // 健康流在这里被判超时。判据统一成 `now - start - sleepPause`，与
        // loop.ts 的 businessElapsedMs 同口径。
        const sleptSinceProgress = Math.max(0, getSleepLedger().getTotalMs() - sleepAtLastProgress);
        const contentElapsed = Date.now() - lastContentProgressAt - sleptSinceProgress;
        if (contentElapsed >= CONTENT_PROGRESS_TIMEOUT_MS) {
          getLogger().warn(
            "SSE",
            `内容进展超时 ${CONTENT_PROGRESS_TIMEOUT_MS / 1000}s 无有效内容（chunks=${totalChunks} empty=${emptyChunks}），中断流`,
          );
          // 缺口 2：记录内容进展超时触发
          emitTimeoutFired(parseObsIndex, "content_progress_timeout", {
            threshold_ms: CONTENT_PROGRESS_TIMEOUT_MS,
            chunks: totalChunks,
            empty_chunks: emptyChunks,
            model: this._model,
          });
          reader.cancel().catch(() => {});
          throw new Error(`SSE 内容进展超时：${CONTENT_PROGRESS_TIMEOUT_MS / 1000}s 无有效内容`);
        }
      }
    } finally {
      clearInterval(stallLogger);
      // PR9：释放休眠观测器引用（引用计数归零才真的停 interval）。
      releaseSleepObserver();
      chunkDumper.flush(); // 5.2：流结束（正常/异常/取消）都 flush 采样
      // 清理 signal listener，避免 Promise 泄漏
      if (signal && signalAbortHandler) {
        signal.removeEventListener("abort", signalAbortHandler);
      }
      // best-effort 清理：cancel/releaseLock 失败不影响主流程，但补 debug 痕迹，
      // 避免"整块空吞"——排查 reader 泄漏/双重释放时至少日志里有线索（静默-8）。
      //
      // ⚠️ 崩溃根因修复（2026-07 迁移 skill 崩溃复盘）：reader.cancel() 返回 Promise，
      // 当底层 stream 已因 socket RST 进入 errored 态时，它返回的是一个 **rejected**
      // Promise，且 rejection 是**异步**的——同步 try/catch 根本抓不到，rejection 会逃逸
      // 成 floating unhandledRejection。cli.ts 的全局兜底不认 socket 错误（不在 abort 白
      // 名单）→ 误判为真故障 → process.exit(1) 崩溃。即便上方 for-await 的 catch 已经优
      // 雅处理了同一个 read() 错误，这个 finally 里独立的 cancel() rejection 仍会杀进程。
      // 必须用 .catch() 兜住异步 rejection（对齐本文件 1374/1411/1731 行的既有写法）。
      try {
        reader.cancel().catch((e) => {
          getLogger().debug(
            "LLM:OPENAI",
            `reader.cancel() 失败（不影响主流程）: ${(e as Error)?.message}`,
          );
        });
      } catch (e) {
        // 极少数运行时 cancel() 同步抛错的兜底（如 reader 状态非法）
        getLogger().debug(
          "LLM:OPENAI",
          `reader.cancel() 同步异常（不影响主流程）: ${(e as Error)?.message}`,
        );
      }
      try {
        reader.releaseLock();
      } catch (e) {
        getLogger().debug(
          "LLM:OPENAI",
          `reader.releaseLock() 失败（不影响主流程）: ${(e as Error)?.message}`,
        );
      }
    }
  }
}

/**
 * 未知模型的能力探针入口（app.ts::maybeProbeUnknownModel 在 /model 切到一个注册表 + 能力
 * 缓存都没有记录的模型时调用）。
 *
 * 只做一件事：给 model-capabilities.ts 的 probeModelCapability 包一层 openai 线格式的
 * `send` 适配器——该模块自身故意不碰任何 provider 实现（见其文件头注释「避免本模块依赖
 * provider」），HTTP 细节（端点拼接 `/chat/completions`、Bearer 鉴权）留给调用方，此函数
 * 就是 openai 协议族的那份适配器，与本文件其余请求方法（如 sendMessageNonStream）拼端点
 * 的方式一致。
 *
 * 失败静默：探针是纯优化项，网络错误/超时/无法识别的响应都不抛出——真实对话请求若撞上
 * 同样的能力误判，自有 withCapabilityHealing 兜底重试，探针只是想提前把这一跳省掉。
 */
export async function probeOpenAICompatModel(
  model: string,
  baseURL: string,
  apiKey: string,
): Promise<void> {
  const { probeModelCapability } = await import("./model-capabilities.ts");
  const base = baseURL.replace(/\/$/, "");
  await probeModelCapability({
    model,
    send: async (body) => {
      const resp = await fetch(`${base}/chat/completions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(10_000),
        // B1-b：能力探测虽是一次性调用（自带 10s 超时、不进重试漏斗），也一并消费
        // keep-alive 开关——保持「本文件所有 fetch 出口都读同一个开关」的不变式，
        // 避免日后有人照着这里新增 fetch 时漏掉。
        ...getKeepAliveFetchOptions(),
      });
      if (resp.ok) return { ok: true };
      const errorMessage = await resp.text().catch(() => "");
      return { ok: false, errorMessage };
    },
  });
}
