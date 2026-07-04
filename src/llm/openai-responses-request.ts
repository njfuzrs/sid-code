/**
 * OpenAI Responses API 请求构建
 *
 * 负责将 sid-code 内部的 Message[] + SendParams 转换为
 * OpenAI Responses API（POST /v1/responses）的请求体格式。
 *
 * Responses API 与 Chat Completions 的关键差异：
 * - 消息载荷字段名为 `input`（而非 `messages`）；
 * - 工具调用/结果不再走顶层 `tool_calls`，而是作为 `input` 数组中的
 *   独立 item（`function_call` / `function_call_output`）；
 * - 系统提示走顶层 `instructions`（而非 role:"system" 消息）；
 * - 文本内容部分区分输入/输出：user 用 `input_text`，assistant 用 `output_text`；
 * - 工具定义为扁平格式（name/description/parameters 直接平铺，不嵌套 function）。
 */

import type { SendParams, Message, ToolDefinition, ContentBlock } from "./types.ts";

/**
 * OpenAI Responses API 请求体
 * POST /v1/responses
 */
export interface ResponsesAPIRequest {
  model: string;
  input: ResponsesInputItem[];
  instructions?: string;
  tools?: ResponsesToolDef[];
  stream: true;
  store: false;
  max_output_tokens?: number;
  temperature?: number;
  top_p?: number;
  tool_choice?: "auto" | "none" | "required" | { type: "function"; name: string };
  parallel_tool_calls?: boolean;
}

/** Responses API input item —— 消息或函数调用/输出 */
export type ResponsesInputItem =
  | { role: "user"; content: ResponsesContentPart[] }
  | { role: "assistant"; content: ResponsesContentPart[] }
  | { type: "function_call"; call_id: string; name: string; arguments: string }
  | { type: "function_call_output"; call_id: string; output: string };

/** Responses API content part */
export type ResponsesContentPart =
  | { type: "input_text"; text: string }
  | { type: "output_text"; text: string };

/** Responses API 工具定义（扁平格式，不嵌套 function 字段） */
export interface ResponsesToolDef {
  type: "function";
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  strict?: boolean;
}

/**
 * 将 sid-code ToolDefinition[] 转换为 Responses API 扁平工具格式。
 * Chat Completions: { type:"function", function:{ name, description, parameters } }
 * Responses API:    { type:"function", name, description, parameters, strict? }
 */
function convertTools(tools: ToolDefinition[]): ResponsesToolDef[] {
  return tools.map((tool) => {
    const def: ResponsesToolDef = {
      type: "function",
      name: tool.name,
      description: tool.description,
      parameters: tool.input_schema,
    };
    // strict 仅在显式声明时透传，保持与内部定义一致
    if (tool.strict !== undefined) {
      def.strict = tool.strict;
    }
    return def;
  });
}

/**
 * 将单条内部 Message 展开为若干 Responses API input item。
 *
 * 拆分规则：
 * - 同一消息中的文本块合并到一个 role item 中；
 * - 遇到 tool_use / tool_result 就切分为独立 item（function_call / function_call_output）；
 * - thinking / redacted_thinking 忽略（Responses API 无对应概念）。
 *
 * 顺序保持与原 content 一致：文本片段按出现位置聚合，工具 item 就地插入，
 * 保证「文本 → 工具调用 → 文本」之类的交错顺序不被打乱。
 */
function expandMessage(message: Message): ResponsesInputItem[] {
  const items: ResponsesInputItem[] = [];
  // 待合并的文本部分缓冲区
  let textParts: ResponsesContentPart[] = [];

  // 将缓冲区中的文本刷成一个 role item
  const flushText = () => {
    if (textParts.length === 0) return;
    if (message.role === "user") {
      items.push({ role: "user", content: textParts });
    } else {
      items.push({ role: "assistant", content: textParts });
    }
    textParts = [];
  };

  for (const block of message.content as ContentBlock[]) {
    switch (block.type) {
      case "text": {
        // user → input_text；assistant → output_text
        if (message.role === "user") {
          textParts.push({ type: "input_text", text: block.text });
        } else {
          textParts.push({ type: "output_text", text: block.text });
        }
        break;
      }
      case "tool_use": {
        // 工具调用切分为独立 item，先刷掉前置文本保持顺序
        flushText();
        items.push({
          type: "function_call",
          call_id: block.id,
          name: block.name,
          arguments: JSON.stringify(block.input),
        });
        break;
      }
      case "tool_result": {
        // 工具结果切分为独立 item
        flushText();
        items.push({
          type: "function_call_output",
          call_id: block.tool_use_id,
          output: block.content,
        });
        break;
      }
      case "thinking":
      case "redacted_thinking":
        // Responses API 无对应概念，忽略
        break;
    }
  }

  // 刷掉尾部残留文本
  flushText();
  return items;
}

/**
 * 将 sid-code toolChoice 转换为 Responses API 的 tool_choice 字段。
 * - "auto" | "none" | "required" 原样透传；
 * - { name: "foo" } → { type: "function", name: "foo" }。
 */
function convertToolChoice(
  toolChoice: SendParams["toolChoice"],
): ResponsesAPIRequest["tool_choice"] | undefined {
  if (toolChoice === undefined) return undefined;
  if (typeof toolChoice === "string") return toolChoice;
  return { type: "function", name: toolChoice.name };
}

/**
 * 将 sid-code 内部消息格式转换为 Responses API 请求体。
 *
 * 映射规则：
 * - params.system → 顶层 instructions
 * - user TextBlock → { role:"user", content:[{type:"input_text", text}] }
 * - assistant TextBlock → { role:"assistant", content:[{type:"output_text", text}] }
 * - assistant ToolUseBlock → { type:"function_call", call_id:block.id, name:block.name, arguments:JSON.stringify(block.input) }
 * - user ToolResultBlock → { type:"function_call_output", call_id:block.tool_use_id, output:block.content }
 * - ThinkingBlock / RedactedThinkingBlock → 忽略（Responses API 无对应概念）
 *
 * 注意：同一消息中的文本块合并到一个 role item 中；遇到 tool_use/tool_result 就切分为独立 item。
 * 不处理 thinking / reasoningEffort（GPT-5.x 不支持），请求为无状态（store: false）。
 */
export function buildResponsesRequest(params: SendParams, effectiveModel: string): ResponsesAPIRequest {
  // 展开所有消息为扁平的 input item 序列
  const input: ResponsesInputItem[] = [];
  for (const message of params.messages) {
    input.push(...expandMessage(message));
  }

  const request: ResponsesAPIRequest = {
    model: effectiveModel,
    input,
    stream: true,
    store: false,
    max_output_tokens: params.maxTokens,
  };

  // 系统提示 → 顶层 instructions
  if (params.system !== undefined && params.system !== "") {
    request.instructions = params.system;
  }

  // 工具定义（扁平格式）
  if (params.tools && params.tools.length > 0) {
    request.tools = convertTools(params.tools);
  }

  // 工具选择策略
  const toolChoice = convertToolChoice(params.toolChoice);
  if (toolChoice !== undefined) {
    request.tool_choice = toolChoice;
  }

  // 并行工具调用开关
  if (params.parallelToolCalls !== undefined) {
    request.parallel_tool_calls = params.parallelToolCalls;
  }

  return request;
}
