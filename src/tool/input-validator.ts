/**
 * 工具输入的 zod 运行时校验
 *
 * 在工具边界统一拦截畸形参数（模型给出类型不符的输入）。这是新版工具接口
 * `validateInput` 想做却从未接线的事——现由执行器在调用工具前用 `zodSchema.safeParse`
 * 完成，并把 ZodError 翻译成对模型友好的结构化错误消息，提升自我纠错成功率。
 *
 * 设计要点：
 * - 用 safeParse 而非 parse：返回结果对象而不抛异常，契合工具执行的错误返回风格。
 * - 错误消息按"字段路径 + 期望/实际"逐条列出，让模型精确定位要改哪个参数。
 * - 成功时返回校验后的 data（zod 会剥离/规整），供执行器替换原始 input。
 */

import type { LegacyTool } from "./types.ts";

/** 校验结果 */
export type ToolInputValidation =
  | { ok: true; data: unknown }
  | { ok: false; message: string };

/**
 * 用工具的 zodSchema 校验输入。
 *
 * 工具未提供 zodSchema 时返回 { ok: true, data: input } 原样放行（回退到工具内部
 * 的手工检查），保证迁移期间未升级的工具不受影响。
 */
export function validateToolInput(tool: LegacyTool, input: unknown): ToolInputValidation {
  const schema = tool.zodSchema;
  if (!schema) {
    return { ok: true, data: input };
  }

  const result = schema.safeParse(input);
  if (result.success) {
    return { ok: true, data: result.data };
  }

  return { ok: false, message: formatZodError(tool.name(), result.error) };
}

/**
 * 把 ZodError 翻译成对模型友好的中文错误消息。
 *
 * 形如：
 *   参数校验失败（工具 read）:
 *   - file_path: 期望 string，实际收到 number
 *   - offset: 期望 number，实际收到 string
 */
function formatZodError(toolName: string, error: unknown): string {
  const issues = (error as { issues?: ZodIssueLike[] })?.issues;
  if (!Array.isArray(issues) || issues.length === 0) {
    return `参数校验失败（工具 ${toolName}）: ${String((error as { message?: string })?.message ?? error)}`;
  }

  const lines = issues.map((issue) => {
    const path = issue.path && issue.path.length > 0 ? issue.path.join(".") : "(根)";
    return `- ${path}: ${translateIssue(issue)}`;
  });

  return `参数校验失败（工具 ${toolName}）:\n${lines.join("\n")}`;
}

/** zod issue 的结构（v4），只取本模块需要的字段 */
interface ZodIssueLike {
  code?: string;
  path?: Array<string | number>;
  message?: string;
  expected?: string;
  received?: string;
  keys?: string[];
}

/** 单条 issue → 中文描述。优先用 expected/received，回退原始 message */
function translateIssue(issue: ZodIssueLike): string {
  if (issue.code === "invalid_type" && issue.expected) {
    const received = issue.received ?? "unknown";
    // 附加 zod 原始 message 作为补充信息，帮助模型自我纠正
    const suffix = issue.message ? `（${issue.message}）` : "";
    return `期望 ${issue.expected}，实际收到 ${received}${suffix}`;
  }
  if (issue.code === "unrecognized_keys" && issue.keys?.length) {
    return `存在未识别的字段: ${issue.keys.join(", ")}`;
  }
  // 其余类型（too_small / invalid_enum_value / custom 等）直接透传 zod 的 message
  return issue.message ?? "参数不合法";
}
