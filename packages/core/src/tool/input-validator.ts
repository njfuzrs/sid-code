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
import { normalizeStrictNulls } from "./nullish-normalize.ts";

/** 校验结果 */
export type ToolInputValidation = { ok: true; data: unknown } | { ok: false; message: string };

/**
 * 「schema 未发送」补救提示（对标 claude-code buildSchemaNotSentHint）。
 *
 * 场景：延迟加载（ToolSearch）启用时，未激活的延迟工具其完整 schema **不在**首轮上下文里。
 * 模型只看到工具名（<available-deferred-tools> 列表），却凭记忆猜参数结构直接盲调——
 * 典型翻车是把带类型的参数（数组/数字/布尔）猜错结构或猜成字符串，触发 zod 校验失败。
 *
 * 此时裸 zod 错误（"questions 期望 array 实际 undefined"）会误导模型以为是自己参数写错、
 * 反复微调猜测，而**真正根因是它根本没看到 schema**。追加本提示把根因和自救路径讲清楚：
 * 先 tool_search 激活拿到 schema，再重试。
 *
 * 返回 null 表示无需补救（未启用延迟加载 / 工具非延迟池成员 / 已激活 → schema 已发送）。
 */
export function buildSchemaNotSentHint(
  tool: LegacyTool,
  opts: { toolSearchEnabled: boolean; isDeferred: boolean; isActivated: boolean },
): string | null {
  // 三重门控（对标 claude-code：门控失配只多花一轮往返，不会造成错误行为）：
  // 1. 延迟加载未启用 → 全量工具首轮直出，参数错是模型自己的锅，别误导它去 tool_search
  // 2. 工具不在延迟池 → schema 本就发了，与「未发送」无关
  // 3. 工具已激活 → schema 已随激活进入上下文，同样已发送
  if (!opts.toolSearchEnabled) return null;
  if (!opts.isDeferred) return null;
  if (opts.isActivated) return null;
  return (
    `\n\n⚠️ 本工具（${tool.name()}）的 schema 尚未发送给你——它是延迟加载工具，` +
    `当前只有工具名在 <available-deferred-tools> 列表里，完整参数结构不在你的上下文中。` +
    `没有 schema，你只能凭记忆猜参数，带类型的参数（数组/对象/数字）极易猜错结构。` +
    `请先调用 tool_search（参数 query: "select:${tool.name()}"）激活它拿到真实 schema，再重试本次调用。`
  );
}

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

  // strict 契约回填：OpenAI strict 模式要求 optional 字段进 required 并用 null 表达
  // "未提供"（见 openai-responses-request.ts toStrictJsonSchema），模型遵约传 null
  // 后会被原始 zod schema 的 `.optional()` 拒绝——sid-code 让模型传 null 又拒绝它。
  // 这里在校验前把这类 null 翻译回 zod 的"未提供"表示法。
  // 只处理「optional 且未显式 nullable」的字段，`.nullable()` 的业务 null 不受影响；
  // 同时拦下 `z.coerce.*` 把 null 静默转成 0 的污染（详见 nullish-normalize.ts）。
  const normalized = normalizeStrictNulls(schema, input);

  const result = schema.safeParse(normalized);
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
