/**
 * 结构化输出（JSON Schema 约束）
 *
 * 让 SDK 调用者约束 Agent 的最终输出为结构化 JSON：
 * - buildStructuredOutputPrompt：把 JSON Schema 注入 system prompt
 * - extractStructuredOutput：从助手消息提取并解析 JSON（支持 ```json 包裹）
 *
 * 对齐 Claude Code structured_output 能力（spec §5.5）。
 * P0-2: 校验升级——复用 json-schema-validator 做完整 JSON Schema 递归校验，
 * 替代原有的顶层类型+required 浅层检查。
 */

import type { Message } from "../llm/types.ts";
import { validateAgainstSchema, formatSchemaErrors } from "../workflow/json-schema-validator.ts";

export interface StructuredOutputConfig {
  /** JSON Schema 约束 */
  jsonSchema: Record<string, unknown>;
  /** 最大重试次数 */
  maxRetries?: number;
}

export type ExtractResult =
  | { success: true; data: unknown }
  | { success: false; error: string };

/**
 * 从助手消息中提取结构化输出
 * 尝试把最后一个 text block 解析为 JSON（支持 ```json ... ``` 包裹）
 */
export function extractStructuredOutput(
  message: Message,
  schema: Record<string, unknown>,
): ExtractResult {
  if (message.role !== "assistant") {
    return { success: false, error: "非助手消息" };
  }

  const textBlocks = message.content.filter(
    (b): b is { type: "text"; text: string } => b.type === "text",
  );
  const lastText = textBlocks[textBlocks.length - 1];
  if (!lastText) {
    return { success: false, error: "无文本内容" };
  }

  // 提取 JSON（支持 ```json ... ``` 代码块）
  let jsonStr = lastText.text.trim();
  const codeBlockMatch = jsonStr.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
  if (codeBlockMatch) {
    jsonStr = codeBlockMatch[1].trim();
  }

  let data: unknown;
  try {
    data = JSON.parse(jsonStr);
  } catch (err) {
    return {
      success: false,
      error: `JSON 解析失败: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  // P0-2: 完整 JSON Schema 递归校验（替换原有的浅层 type+required 检查）
  // 复用 workflow 路径同一校验器，保证 SDK 和 Workflow 路径校验深度一致
  const result = validateAgainstSchema(schema, data);
  if (!result.valid) {
    return {
      success: false,
      error: `Schema 校验失败: ${formatSchemaErrors(result.errors)}`,
    };
  }

  return { success: true, data };
}

/**
 * 构建结构化输出的系统提示词补充
 */
export function buildStructuredOutputPrompt(
  schema: Record<string, unknown>,
): string {
  return [
    "",
    "<structured-output-requirement>",
    "你必须以 JSON 格式输出最终结果，严格遵循以下 JSON Schema：",
    "```json",
    JSON.stringify(schema, null, 2),
    "```",
    "将 JSON 放在 ```json ... ``` 代码块中。",
    "不要在 JSON 之外添加任何解释文本。",
    "</structured-output-requirement>",
  ].join("\n");
}
