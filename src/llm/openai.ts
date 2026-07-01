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
} from "./types.ts";
import { getLogger } from "../debug/logger.ts";
import { guardOutgoingMessages } from "./protocol-sentinel.ts";
import { filterParamsForModel } from "./model-capability-filter.ts";
import { lookupCatalog } from "./model-params-catalog.ts";
import { estimateTextTokens } from "../context/token.ts";
import { sanitizeStrings } from "./sanitize-unicode.ts";

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
const RESPONSE_HEADER_TIMEOUT_MS = {
  deepseek: 120_000,
  default: 60_000,
} as const;

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
      thinking: false,       // OpenAI 的 o1/o3 有内置推理，但接口不同
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
   * 当前模型在多轮工具调用时是否要求回传 reasoning_content（方案⓪真因修复）。
   *
   * 判据取自 model-registry 的 requiresReasoningContentForToolCalls 能力标志：
   *   - DeepSeek V4 thinking 系 → true（tool-call 轮必回传，否则 400 + 思维链断裂）
   *   - 旧 deepseek-reasoner → false（回传会触发旧协议 400）
   *   - 未知模型 / 无 reasoning 概念 → false（保守：仅无 tool_calls 时回传，维持旧行为）
   */
  private requiresReasoningContentForToolCalls(): boolean {
    return lookupCatalog(this._model)?.requiresReasoningContentForToolCalls === true;
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
   * 规范枚举 5 值：stop / length / tool_calls / content_filter / function_call。
   *   - tool_calls / function_call → tool_use
   *   - length → max_tokens
   *   - content_filter → content_filter（不再误并入 end_turn，掩盖内容审查）
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
    const override = Number(process.env.SID_CODE_RESPONSE_HEADER_TIMEOUT_MS);
    if (Number.isFinite(override) && override > 0) {
      return override;
    }
    return /deepseek/i.test(model)
      ? RESPONSE_HEADER_TIMEOUT_MS.deepseek
      : RESPONSE_HEADER_TIMEOUT_MS.default;
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
   */
  private prependSystemMessage(messages: any[], system: string, model: string): void {
    const first = messages[0];
    if (first && (first.role === "system" || first.role === "developer")) {
      return; // 已有，避免双 system（§4.1）
    }
    const role = this.isReasoningModel(model) ? "developer" : "system";
    messages.unshift({ role, content: system });
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
   * 透传 DeepSeek 思考模式相关字段到请求体顶层（§2.1 / §2.2 / §2.6）。
   * 流式与非流式路径共用，避免降级时行为不一致。
   *
   * DeepSeek（OpenAI 兼容端点）的协议约定（见 api-reference/deepseek-api.md）：
   * - `thinking: { type: "enabled" | "disabled" }`——思考开关，请求体顶层字段。
   *   注意 OpenAI **SDK** 用法是放进 extra_body，但 SDK 只是把它展开到 HTTP body 顶层；
   *   sid-code 直发 fetch，故直接写顶层即可。
   * - `reasoning_effort: "high" | "max"`——思考强度，请求体顶层字段（非 extra_body）。
   * - `user_id`——KVCache/调度/内容安全隔离，请求体顶层字段。
   *
   * 仅对 DeepSeek 模型下发 thinking/reasoning_effort（其它 OpenAI 兼容端点不认这两个字段，
   * 贸然下发可能 400）。user_id 是通用隔离字段，任意端点都按需下发。
   */
  private applyDeepSeekThinking(requestBody: any, params: SendParams, model: string): void {
    const isDeepSeek = /deepseek/i.test(model);

    if (isDeepSeek) {
      // 思考开关：显式下发 enabled/disabled。params.thinking 不传时不下发，
      // 沿用 DeepSeek 服务端默认（enabled）。
      if (params.thinking) {
        requestBody.thinking = {
          type: params.thinking.enabled ? "enabled" : "disabled",
        };
      }
      // 思考强度：思考显式关闭时不下发，避免冲突；其余情况按需下发。
      const thinkingDisabled = params.thinking?.enabled === false;
      if (params.reasoningEffort && !thinkingDisabled) {
        requestBody.reasoning_effort = params.reasoningEffort;
      }
    }

    // user_id：通用隔离字段，按需下发（DeepSeek 专有语义，其它端点忽略不报错）。
    if (params.userId) {
      requestBody.user_id = params.userId;
    }

    // OpenAI o-series（o1/o3/o4…）：内置推理，仅透传 reasoning_effort（low/medium/high，无 max）。
    // 不下发 thinking 开关（o-series 无显式开关）。effort.ts 已把 max 钳为 high，这里原样透传。
    const isOSeries = /^o[0-9]/i.test(model);
    if (isOSeries && params.reasoningEffort && params.reasoningEffort !== "max") {
      requestBody.reasoning_effort = params.reasoningEffort;
    }
  }

  /**
   * 透传工具调用策略（§4.2 / §2.4）。流式与非流式共用。
   *
   * §2.4：DeepSeek V4 思考模式**不接受** `tool_choice` 参数（实测会 400，
   * OMP 官方配置亦标注 `supportsToolChoice: false`）。因此当模型为 DeepSeek
   * 且思考未显式关闭时，跳过 `tool_choice` 下发并记日志告警，而非冒 400 风险。
   * `parallel_tool_calls` 未见 DeepSeek 思考模式冲突报告，保持下发。
   */
  private applyToolChoice(requestBody: any, params: SendParams, model: string): void {
    const isDeepSeek = /deepseek/i.test(model);
    const thinkingActive = isDeepSeek && params.thinking?.enabled !== false;
    const toolChoice = OpenAIProvider.toToolChoice(params.toolChoice);

    if (toolChoice !== undefined) {
      if (thinkingActive) {
        // DeepSeek 思考模式下 tool_choice 会触发 400，跳过下发（保留模型自主调用）。
        getLogger().warn(
          "LLM:OPENAI",
          `DeepSeek 思考模式不支持 tool_choice，已跳过下发（请求的 toolChoice=${JSON.stringify(params.toolChoice)}）`,
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
  private convertMessages(messages: Message[]): any[] {
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
          const carryOnToolCalls = this.requiresReasoningContentForToolCalls();
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
              content: block.content && block.content.length > 0 ? block.content : "(empty)",
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

  async *sendMessageStream(
    params: SendParams,
    signal?: AbortSignal,
  ): AsyncIterable<StreamEvent> {
    // D1-1：发送前协议完整性关卡（只读校验 + 告警 + 落盘，不修数据，尊重 ADR-039）
    guardOutgoingMessages(params.messages, { providerName: this.name() });
    // 转换消息格式
    const messages = this.convertMessages(params.messages);

    // 转换工具定义
    const tools = params.tools?.map((t) => ({
      type: "function",
      function: {
        name: t.name,
        description: t.description,
        parameters: t.input_schema,
      },
    }));

    const effectiveModel = params.model || this._model;
    const requestBody: any = {
      model: effectiveModel,
      messages,
      stream: true,
      stream_options: { include_usage: true },
    };

    // § P1: model-capability-filter 参数过滤（基于 catalog 声明的协议能力自动处理 o-series 等模型）
    // 注意：filterParamsForModel 与下方 applyMaxTokens/prependSystemMessage 有功能重叠，
    // 但 filter 只在 catalog 命中且声明了对应字段时才生效，已有逻辑作为 runtime 兜底保留。
    filterParamsForModel(effectiveModel, requestBody);

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
      let headerTimeoutId: ReturnType<typeof setTimeout> | null = setTimeout(() => {
        headerTimedOut = true;
        log.warn(
          "LLM:OPENAI",
          `响应头超时 ${headerTimeoutMs / 1000}s 未收到响应头，主动中断 fetch（model=${this._model}）`,
        );
        headerTimeoutCtl.abort();
      }, headerTimeoutMs);
      // 注意：不调 unref()。fdb47f30 的教训正是 fallback 的整体超时定时器 unref 后
      // 在 hang 场景疑似未按时 fire；响应头超时是关键防线，宁可让它保持进程活跃。
      const fetchSignal = signal
        ? AbortSignal.any([signal, headerTimeoutCtl.signal])
        : headerTimeoutCtl.signal;

      let response: Response;
      try {
        response = await fetch(`${this.baseURL}/chat/completions`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${this.apiKey}`,
          },
          body: JSON.stringify(sanitizeStrings(requestBody)),
          signal: fetchSignal,
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
      }

      if (!response.ok) {
        const error = await response.text();
        log.error("LLM:OPENAI", `API 错误: ${response.status}`, error);
        // 接入审计日志(WARN 级,fileOnly 不刷屏):API 层错误是排查会话异常的关键信号,
        // 原先只进 LLM:OPENAI 普通日志,audit.log 拿不到 HTTP 码 → 异常时定位慢。
        getLogger().warn(
          "AUDIT:API",
          `✗ OpenAI HTTP ${response.status} model=${effectiveModel} body=${(error ?? "").slice(0, 200)}`,
        );
        yield {
          type: "error",
          error: { message: `OpenAI API 错误: ${response.status} ${error}` },
        };
        return;
      }

      log.debug("LLM:OPENAI", `开始接收 SSE 流`);

      // 解析 SSE 流
      let accumulatedUsage: Usage = { inputTokens: 0, outputTokens: 0 };
      // PARSE-4：累积输出文本，供"端点不返回 usage"（Ollama 等）时估算兜底
      let accumulatedOutputText = "";
      for await (const event of this.parseSSE(response.body!, signal)) {
        // Fix 1 纵深防御：每次事件到达后检查 signal（覆盖 parseSSE 内 race 的盲区）
        if (signal?.aborted) {
          throw new Error("Request aborted");
        }
        // 记录首 token 延迟（TTFT）
        if (event.type === "content_block_delta" && !firstTokenTime) {
          firstTokenTime = Date.now();
          log.debug("LLM:OPENAI", `首 token 延迟: ${firstTokenTime - requestStartTime}ms`);
        }

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
              const estIn = inputZero
                ? OpenAIProvider.estimatePromptTokens(params)
                : u.inputTokens;
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
      log.warn("AUDIT:API", `✗ OpenAI 请求异常 model=${effectiveModel} err=${(err?.message ?? String(err)).slice(0, 200)}`);
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
  async sendMessageNonStreaming(
    params: SendParams,
    signal?: AbortSignal,
  ): Promise<AccumulatedResponse> {
    // D1-1：发送前协议完整性关卡（非流式路径同样校验）
    guardOutgoingMessages(params.messages, { providerName: this.name() });
    const messages = this.convertMessages(params.messages);
    const tools = params.tools?.map((t) => ({
      type: "function",
      function: {
        name: t.name,
        description: t.description,
        parameters: t.input_schema,
      },
    }));

    const effectiveModel = params.model || this._model;
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
    });

    if (!response.ok) {
      const errText = await response.text();
      throw new Error(`OpenAI API 错误: ${response.status} ${errText}`);
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
        if (extracted.text) {
          content.push({ type: "text", text: extracted.text });
        }
      } else {
        content.push({ type: "text", text: msg.content });
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

    // §2.1：内容审查拒绝。模型触发安全策略时返回 `refusal`（拒绝理由）而非 `content`。
    // 此前完全未解析——若 refusal 非空而 content 为空，会得到无任何块的空响应，
    // 表现为"模型莫名没回复"。这里在正文均空时把 refusal 文本兜底为 text 块，
    // 至少让用户/上层看到拒绝原因，并标注来源。
    if (
      content.length === 0 &&
      typeof msg.refusal === "string" &&
      msg.refusal.length > 0
    ) {
      content.push({ type: "text", text: `[模型拒绝] ${msg.refusal}` });
      getLogger().warn("LLM:OPENAI", `模型返回 refusal: ${msg.refusal.slice(0, 200)}`);
    }

    // DeepSeek 缓存命中数：顶层 prompt_cache_hit_tokens（DeepSeek 专有），
    // 兜底读 OpenAI 标准的 prompt_tokens_details.cached_tokens。
    // DeepSeek 无缓存写入计费概念，cacheCreationInputTokens 不映射（恒 0）。
    const cacheHit = data.usage?.prompt_cache_hit_tokens
      ?? data.usage?.prompt_tokens_details?.cached_tokens
      ?? 0;

    return {
      role: "assistant",
      content,
      stopReason,
      usage: {
        inputTokens: data.usage?.prompt_tokens ?? 0,
        outputTokens: data.usage?.completion_tokens ?? 0,
        ...(cacheHit > 0 ? { cacheReadInputTokens: cacheHit } : {}),
      },
      // §2.3：reasoning_content 存入 _meta，供 convertMessages 下轮按需回传
      //（与流式路径 stream-processor 的 response._meta 同源）。
      ...(reasoningContent.length > 0
        ? { _meta: { reasoning_content: reasoningContent } }
        : {}),
    };
  }

  /**
   * 解析 SSE 流，转换为统一的 StreamEvent
   * 支持多工具并行调用：用 Map<index, ToolCallState> 追踪每个工具调用
   */
  private async *parseSSE(stream: ReadableStream<Uint8Array>, signal?: AbortSignal): AsyncIterable<StreamEvent> {
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

    /** 流式空闲超时（默认启用，不再依赖环境变量开关）
     *  仅 1 级 idle timeout：N 秒内 reader 无任何 chunk → 断开
     *  按模型区分：DeepSeek 大上下文处理慢 → 180s；Claude/OpenAI 等 → 90s */
    const isDeepSeek = /deepseek/i.test(this._model);
    const IDLE_TIMEOUT_MS = isDeepSeek ? 180_000 : 90_000;

    /** Fix 2: content progress timeout — 区分 TCP keep-alive 与业务进展
     *  即使 reader.read() 持续 settle（空行/ping），只要无有效内容进展就超时中断。
     *  DeepSeek 思考模型给 5min（思考期间 reasoning_content 算进展）；其他 2min。
     *  支持环境变量覆盖（测试用）。 */
    const CONTENT_PROGRESS_TIMEOUT_MS = process.env.SID_CODE_CONTENT_PROGRESS_TIMEOUT_MS
      ? parseInt(process.env.SID_CODE_CONTENT_PROGRESS_TIMEOUT_MS, 10)
      : (isDeepSeek ? 300_000 : 120_000);

    /** 30s stall 日志（只记不杀，对齐 claude-code，给弱模型喘息空间） */
    const STALL_LOG_MS = 30_000;
    const stallLogger = setInterval(() => {
      const elapsed = Date.now() - lastContentProgressAt;
      if (elapsed >= STALL_LOG_MS) {
        dbg(`stall: ${(elapsed / 1000).toFixed(0)}s 无内容进展 chunks=${totalChunks} empty=${emptyChunks}`);
      }
    }, STALL_LOG_MS);

    // Fix 1: signal abort promise — 让用户 ESC/Ctrl+C 能打断已进入 SSE 消费的流
    // 在外部创建一次，避免每次循环创建新 listener 导致泄漏
    // 预先 abort 走循环顶部快速检查（第 838 行），不在此创建 reject Promise（避免 unhandled rejection）
    let signalAbortHandler: (() => void) | null = null;
    const abortPromise = (signal && !signal.aborted) ? new Promise<never>((_, reject) => {
      signalAbortHandler = () => reject(new Error("Request aborted"));
      signal.addEventListener("abort", signalAbortHandler, { once: true });
    }) : null;

    try {
      while (true) {
        // 前置检查：循环顶部快速判断（方案 B 补充，覆盖 reader.read() settle 后的盲区）
        if (signal?.aborted) {
          reader.cancel().catch(() => {});
          throw new Error("Request aborted");
        }

        // idle timeout 默认启用：reader 超时后 reject + cancel 释放底层 TCP 连接
        const readPromise = reader.read();
        let timeoutId: ReturnType<typeof setTimeout> | null = null;
        const timeoutPromise = new Promise<never>((_resolve, reject) => {
          timeoutId = setTimeout(() => {
            // 升 warn：debug:false 下经 logger 的 ERROR/WARN→stderr 兜底留痕（见 logger.ts log()）。
            // 空闲超时是关键异常信号，事故复盘必须可见，不能只靠 SID_CODE_DEBUG_SSE 开关。
            getLogger().warn(
              "SSE",
              `空闲超时 ${IDLE_TIMEOUT_MS / 1000}s 无 chunk（chunks=${totalChunks} empty=${emptyChunks}），中断流`,
            );
            reject(new Error(`SSE 流空闲超时：${IDLE_TIMEOUT_MS / 1000} 秒无 chunk chunks=${totalChunks} empty=${emptyChunks}`));
          }, IDLE_TIMEOUT_MS);
          // 超时后 cancel reader，释放底层 TCP 连接（+100ms 确保 reject 先传播）
          setTimeout(() => { reader.cancel().catch(() => {}); }, IDLE_TIMEOUT_MS + 100);
        });

        let result: Awaited<ReturnType<typeof reader.read>>;
        try {
          const racers: Promise<any>[] = [readPromise, timeoutPromise];
          if (abortPromise) racers.push(abortPromise);
          result = await Promise.race(racers);
        } finally {
          if (timeoutId !== null) clearTimeout(timeoutId);
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
            lastContentProgressAt = Date.now();
            dbg(`[DONE] received after ${Date.now() - requestStartAt}ms chunks=${totalChunks} empty=${emptyChunks}`);
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
            continue;
          }

          try {
            const chunk = JSON.parse(data);

            // §3.3：流中途的 API error chunk（配额超限/内容过滤/上游中断）。
            // 此前只看 choices/usage，error 被 `!delta && !finishReason` 静默跳过，
            // 表现为"流莫名结束/空响应/超时"。这里显式 yield error 并终止流。
            if (chunk.error) {
              const msg = chunk.error.message || JSON.stringify(chunk.error);
              dbg(`stream error chunk: ${msg}`);
              yield { type: "error", error: { message: `OpenAI 流内错误: ${msg}` } };
              return;
            }

            const delta = chunk.choices?.[0]?.delta;
            const finishReason = chunk.choices?.[0]?.finish_reason;
            totalChunks++;

            // Token 用量（可能在任何 chunk 中，包括 choices 为空的最终 chunk）
            if (chunk.usage) {
              usage.inputTokens = chunk.usage.prompt_tokens || 0;
              usage.outputTokens = chunk.usage.completion_tokens || 0;
              // DeepSeek 缓存命中数：顶层 prompt_cache_hit_tokens（DeepSeek 专有），
              // 兜底读 OpenAI 标准的 prompt_tokens_details.cached_tokens。
              // 不映射 cacheCreationInputTokens——DeepSeek 无缓存写入计费概念（恒 0）。
              const cacheHit = chunk.usage.prompt_cache_hit_tokens
                ?? chunk.usage.prompt_tokens_details?.cached_tokens
                ?? 0;
              if (cacheHit > 0) usage.cacheReadInputTokens = cacheHit;
            }

            if (!delta && !finishReason) continue;

            // 跟踪有效内容进展（供 stall 日志 + content progress timeout 使用）
            // content/tool_calls/finish_reason/reasoning_content 均视为有效进展
            const hasContent = typeof delta?.content === "string" && delta.content.length > 0;
            const hasToolCalls = Array.isArray(delta?.tool_calls) && delta.tool_calls.length > 0;
            const hasReasoning = typeof delta?.reasoning_content === "string" && delta.reasoning_content.length > 0;
            if (hasContent || hasToolCalls || hasReasoning || finishReason) {
              lastContentProgressAt = Date.now();
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
              lastContentProgressAt = Date.now();
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

              pendingFinishReason = finishReason;
            }
          } catch (parseErr) {
            // 跳过无法解析的行
          }
        }

        // Fix 2: content progress timeout — 每次 reader.read() settle 后检查
        // 即使 TCP 层有字节到达（空行/ping），只要无有效内容进展就超时中断
        const contentElapsed = Date.now() - lastContentProgressAt;
        if (contentElapsed >= CONTENT_PROGRESS_TIMEOUT_MS) {
          getLogger().warn(
            "SSE",
            `内容进展超时 ${CONTENT_PROGRESS_TIMEOUT_MS / 1000}s 无有效内容（chunks=${totalChunks} empty=${emptyChunks}），中断流`,
          );
          reader.cancel().catch(() => {});
          throw new Error(`SSE 内容进展超时：${CONTENT_PROGRESS_TIMEOUT_MS / 1000}s 无有效内容`);
        }
      }
    } finally {
      clearInterval(stallLogger);
      // 清理 signal listener，避免 Promise 泄漏
      if (signal && signalAbortHandler) {
        signal.removeEventListener("abort", signalAbortHandler);
      }
      try { reader.cancel(); } catch {}
      try { reader.releaseLock(); } catch {}
    }
  }
}
