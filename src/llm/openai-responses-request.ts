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
import { serializeToolResultContentForOpenAI } from "./openai-tool-result-content.ts";

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
 * 递归地把 zod 生成的 JSON Schema 改造成满足 OpenAI Structured Outputs / 函数调用
 * strict 模式要求的形态：
 * 1. 每个 object 节点的 required 补全为该节点全部 properties key —— strict 模式不允许
 *    "可选 key"，可选语义必须改用 nullable 类型表达（OpenAI 官方要求：optional 字段要
 *    用 union 类型带上 null，且仍要出现在 required 里，null 表示"未提供"）；
 * 2. 原本不在 required 里的字段（即 zod `.optional()` 字段），其子 schema 包一层
 *    "允许 null"（简单 type 用 `type: [原type, "null"]` 数组形式——OpenAI 官方推荐
 *    写法；否则退化为 `anyOf: [原 schema, {type:"null"}]`）；
 * 3. additionalProperties 显式设为 false（zod `z.toJSONSchema()` 默认已带，这里兜底，
 *    防止未来 zod 版本升级或个别写法导致缺失）；
 * 4. 递归处理 properties / items（数组，含 tuple 数组）/ anyOf|oneOf|allOf 分支，
 *    保证任意深度嵌套都满足要求——OpenAI 的 strict 校验是递归的，只修顶层不够
 *    （2026-07-13 事故里报错定位的正是嵌套两层的 `questions[].options[]`）。
 *
 * 背景（2026-07-13 生产事故）：registry.ts 默认给内置工具打 `strict: true`（原为
 * Anthropic Constrained Decoding 设计），本文件的 convertTools() 曾无条件透传给
 * OpenAI Responses API；但 zod 的 `.optional()` 字段转 JSON Schema 后不会出现在
 * required 里，完全不满足 OpenAI strict 模式的硬性要求，导致任何带 optional 字段
 * 的工具一旦发给 GPT-5.x 系列模型就 400（实测内置工具 30 个里 23 个中招，包括
 * ask_user_question/read/edit/bash/grep 等高频工具，参见
 * `OpenAI Responses API HTTP 400: Invalid schema for function 'ask_user_question'...
 * 'required' is required to be supplied`）。
 *
 * 不做的事：不处理 record/字典模式（additionalProperties 为 schema 对象而非 false，
 * 或 patternProperties）——这类 schema 架构上就与 strict 模式互斥（OpenAI 不支持
 * 动态 key），目前内置工具没有这种写法（已用脚本核实全量内置工具）。一旦出现，
 * 应在 registry.ts 层面不给该工具打 strict:true，而不是在这里强行"修"一个改不对
 * 的 schema。
 */
function toStrictJsonSchema(schema: unknown): unknown {
  if (schema === null || typeof schema !== "object") return schema;
  if (Array.isArray(schema)) return schema.map(toStrictJsonSchema);

  const node: Record<string, unknown> = { ...(schema as Record<string, unknown>) };

  // 递归处理组合关键字分支（union / 交叉类型内部也可能是 object 节点）
  for (const key of ["anyOf", "oneOf", "allOf"] as const) {
    if (Array.isArray(node[key])) {
      node[key] = (node[key] as unknown[]).map(toStrictJsonSchema);
    }
  }

  // 递归处理数组 items（单 schema 场景；tuple 数组场景 items 本身是数组，走上面的分支）
  if (node.items !== undefined) {
    node.items = toStrictJsonSchema(node.items);
  }

  // object 节点：补全 required + 把新纳入 required 的原 optional 字段转 nullable
  if (node.type === "object" && node.properties && typeof node.properties === "object") {
    const properties = node.properties as Record<string, unknown>;
    const originalRequired = new Set(
      Array.isArray(node.required) ? (node.required as string[]) : [],
    );
    const allKeys = Object.keys(properties);
    const newProperties: Record<string, unknown> = {};

    for (const key of allKeys) {
      const propSchema = toStrictJsonSchema(properties[key]);
      newProperties[key] = originalRequired.has(key) ? propSchema : makeNullable(propSchema);
    }

    node.properties = newProperties;
    node.required = allKeys;
    if (node.additionalProperties === undefined) {
      node.additionalProperties = false;
    }
  }

  return node;
}

/**
 * 把一个 JSON Schema 节点改造成"允许 null"，用于表达 zod `.optional()` 的可选语义
 * （strict 模式下可选字段仍必须出现在 required 里，靠类型可空来表达"可以不提供"，
 * 模型需要时会显式传 null）。
 */
function makeNullable(schema: unknown): unknown {
  if (schema === null || typeof schema !== "object" || Array.isArray(schema)) {
    return { anyOf: [schema, { type: "null" }] };
  }
  const node = schema as Record<string, unknown>;
  if (typeof node.type === "string") {
    // 简单 type 场景：type: "string" → type: ["string", "null"]（OpenAI 官方推荐写法）
    return { ...node, type: [node.type, "null"] };
  }
  if (Array.isArray(node.type)) {
    return node.type.includes("null") ? node : { ...node, type: [...node.type, "null"] };
  }
  // 无简单 type（如 enum-only、$ref、已有 anyOf/oneOf 的复合 schema）：整体包一层 anyOf
  return { anyOf: [node, { type: "null" }] };
}

/**
 * 递归检测：schema 里是否存在「strict 模式无法表达」的节点。
 *
 * OpenAI strict 模式要求每个 schema 节点都有确定的 `type`（或 enum/const/$ref/组合器
 * anyOf|oneOf|allOf 之一）来约束取值。zod 的 `z.any()` / `z.unknown()`（"任意 JSON
 * 值"）转 JSON Schema 后是一个**空对象 `{}`**（除 $schema/description 外无任何约束键），
 * 既没有 type 也没有 enum/组合器——这类"无约束任意值"字段在 strict 模式下**根本无法
 * 表达**（strict 的本质就是"约束解码"，而任意值意味着无约束），无论怎么包装 nullable
 * 都会被 OpenAI 400：`schema must have a 'type' key`。
 *
 * 背景（2026-07-14 复测发现）：修好 ask_user_question 的 optional 字段后，实测 gpt-5.4
 * 仍在 `workflow` 工具上 400——它的 `args` 字段是 `z.unknown()`（传给脚本的任意入参），
 * 生成空 schema `{}`，makeNullable 把它包成 `anyOf:[{}, {type:"null"}]`，那个 `{}`
 * 分支仍无 type key。这类工具架构上就与 strict 互斥，正确做法是**该工具整体降级为
 * 非 strict**（发原始 schema、不带 strict:true，让服务端按普通函数调用处理），而不是
 * 硬塞一个 OpenAI 必拒的 schema。
 *
 * 用运行时自检而非按工具名硬编码豁免：未来任何新增的 `z.any()`/`z.unknown()` 字段工具
 * 都会被自动识别并降级，不会再次踩坑。
 */
function hasStrictIncompatibleNode(schema: unknown): boolean {
  if (schema === null || typeof schema !== "object") return false;
  if (Array.isArray(schema)) return schema.some(hasStrictIncompatibleNode);

  const node = schema as Record<string, unknown>;
  const hasType = node.type !== undefined;
  const hasEnumOrConst = node.enum !== undefined || node.const !== undefined;
  const hasRef = node.$ref !== undefined;
  const combinators = ["anyOf", "oneOf", "allOf"] as const;
  const hasCombinator = combinators.some((k) => Array.isArray(node[k]));
  const isStructural = node.properties !== undefined || node.items !== undefined;

  // 「无约束任意值」叶子：既无 type，也无 enum/const/$ref/组合器，且不是 object/array 结构节点。
  if (!hasType && !hasEnumOrConst && !hasRef && !hasCombinator && !isStructural) {
    return true;
  }

  // 递归下钻各类子节点
  for (const key of combinators) {
    if (Array.isArray(node[key]) && (node[key] as unknown[]).some(hasStrictIncompatibleNode)) {
      return true;
    }
  }
  if (node.items !== undefined && hasStrictIncompatibleNode(node.items)) return true;
  if (node.properties && typeof node.properties === "object") {
    for (const v of Object.values(node.properties as Record<string, unknown>)) {
      if (hasStrictIncompatibleNode(v)) return true;
    }
  }
  return false;
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
    // strict 仅在显式声明时透传，保持与内部定义一致。
    // strict:true 时必须把 parameters 改造成满足 OpenAI strict 模式要求的形态
    // （所有字段进 required + optional 语义转 nullable），否则原样透传 zod 生成的
    // schema 会因缺失 required 字段被 OpenAI 400（见 toStrictJsonSchema 顶部背景）。
    if (tool.strict !== undefined) {
      if (tool.strict) {
        const strictParams = toStrictJsonSchema(tool.input_schema);
        // 改造后自检：若仍含「无约束任意值」节点（z.any()/z.unknown()，如 workflow.args），
        // 该工具与 strict 模式互斥——降级为非 strict（发原始 schema、不带 strict），
        // 避免 OpenAI 400 `schema must have a 'type' key`（见 hasStrictIncompatibleNode 顶部背景）。
        if (hasStrictIncompatibleNode(strictParams)) {
          def.strict = false;
          def.parameters = tool.input_schema;
        } else {
          def.strict = true;
          def.parameters = strictParams as Record<string, unknown>;
        }
      } else {
        def.strict = false;
      }
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
        // 工具结果切分为独立 item。
        // output 走统一序列化：is_error 前缀标注 + mediaBlocks 降级文本说明
        // （此前只取 block.content，两者静默丢弃——审计第 6 条）。
        flushText();
        items.push({
          type: "function_call_output",
          call_id: block.tool_use_id,
          output: serializeToolResultContentForOpenAI(block, "openai-responses"),
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
