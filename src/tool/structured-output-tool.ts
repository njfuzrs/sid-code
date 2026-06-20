/**
 * Dynamic Workflows M2 — 结构化输出工具(StructuredOutput)
 *
 * 对标 cc 的 SyntheticOutputTool:当 workflow 脚本调 `agent({schema})` 时,给那个子代理临时
 * 挂上这个工具,并把它的 inputSchema 设成 workflow 传入的 JSON Schema。子代理被系统提示要求
 * "最后必须调一次 StructuredOutput 工具返回结构化结果"。工具在 execute 里用 schema 校验输入:
 *   - 不合规 → 返回 isError,把错误回喂给子代理触发重试(由 agentic-loop 续轮);
 *   - 合规   → 原样返回输入作为结构化结果,SubAgent 层据此旁路 extractFinalText。
 *
 * 与 cc 的差异:
 *   - 校验器用自研零依赖 json-schema-validator(项目不引 Ajv),错误风格对齐 `path: message`。
 *   - identity 缓存:同一个 schema 对象引用(workflow 一次 run 常复用同一 SCHEMA 常量 30-80 次)
 *     缓存其 shape 校验结果,省掉重复检查。
 */

import type {
  LegacyTool as Tool,
  LegacyToolResult as ToolResult,
  PermissionResult,
  ToolUseContext,
} from "./types.ts";
import {
  validateAgainstSchema,
  formatSchemaErrors,
  checkSchemaShape,
} from "../workflow/json-schema-validator.ts";

/** 工具名(对齐 cc) */
export const STRUCTURED_OUTPUT_TOOL_NAME = "StructuredOutput";

/**
 * schema shape 校验的 identity 缓存。
 * key = schema 对象引用;value = checkSchemaShape 结果(null=合法 / string=错误)。
 * workflow 一次 run 里同一 SCHEMA 常量被复用几十次,缓存省掉重复 shape 检查。
 */
const shapeCache = new WeakMap<object, string | null>();

/** 带缓存的 shape 校验 */
function cachedCheckShape(schema: Record<string, unknown>): string | null {
  const cached = shapeCache.get(schema);
  if (cached !== undefined) return cached;
  const result = checkSchemaShape(schema);
  shapeCache.set(schema, result);
  return result;
}

/**
 * 结构化输出工具。每个带 schema 的 agent 调用构造一个实例(共享同一 schema 引用时缓存生效)。
 */
export class StructuredOutputTool implements Tool {
  /** workflow 传入的 JSON Schema(纯对象 POJO) */
  private readonly schema: Record<string, unknown>;
  /** 最近一次校验通过的输入(供 SubAgent 旁路 extractFinalText 取用) */
  private captured: unknown = undefined;
  /** 是否已捕获到合规输出 */
  private hasCaptured = false;

  constructor(schema: Record<string, unknown>) {
    this.schema = schema;
  }

  /** 是否已捕获到合规的结构化输出 */
  get hasCapturedOutput(): boolean {
    return this.hasCaptured;
  }

  /** 取最近一次校验通过的结构化输出(对象形态) */
  getCapturedOutput(): unknown {
    return this.captured;
  }

  /** 只读工具:不改任何东西,只回数据 */
  readOnly(): boolean {
    return true;
  }

  /** 始终放行:它只是返回数据,无副作用 */
  async checkPermissions(
    _input: unknown,
    _context: ToolUseContext,
  ): Promise<PermissionResult> {
    return { behavior: "allow", updatedInput: _input as Record<string, unknown> };
  }

  name(): string {
    return STRUCTURED_OUTPUT_TOOL_NAME;
  }

  description(): string {
    return "把你的最终回答以要求的结构化格式返回。你必须在回答末尾**恰好调用一次**这个工具来提供结构化输出。";
  }

  usageGuide(): string {
    return `- 这是返回结构化结果的唯一途径,workflow 编排依赖它的输出。
- 必须严格匹配提供的 JSON Schema:字段名、类型、必填项、枚举值都要对。
- 只调一次,放在你完成分析之后。`;
  }

  /** 动态 inputSchema:直接返回 workflow 提供的 schema(这是本工具的特殊之处) */
  inputSchema(): Record<string, unknown> {
    return this.schema;
  }

  async execute(input: unknown): Promise<ToolResult> {
    // 1) schema 本身是否像合法 JSON Schema(带缓存)
    const shapeErr = cachedCheckShape(this.schema);
    if (shapeErr) {
      // schema 本身有问题:这是 workflow 作者的错,不是子代理的错,直接报错(不可重试修复)
      return {
        output: `[StructuredOutput] 提供的 schema 非法: ${shapeErr}`,
        isError: true,
      };
    }

    // 2) 用 schema 校验子代理给的输入
    const result = validateAgainstSchema(this.schema, input);
    if (!result.valid) {
      // 不合规:把错误回喂,子代理在下一轮修正后重新调用(对齐 cc 自动重试)
      return {
        output: `输出不符合要求的 schema,请修正后重新调用 StructuredOutput 工具: ${formatSchemaErrors(
          result.errors,
        )}`,
        isError: true,
      };
    }

    // 3) 合规:捕获校验后的输入,供 SubAgent 旁路 extractFinalText 取用。
    this.captured = input;
    this.hasCaptured = true;
    return {
      output: JSON.stringify(input),
      isError: false,
    };
  }
}

/**
 * 给子代理临时挂 StructuredOutput 工具时,注入系统提示的附加段。
 * 由 SubAgent 在 task.schema 存在时拼到 system prompt 末尾。
 */
export function structuredOutputPromptSuffix(): string {
  return `

## 结构化输出要求(强制)

本次任务要求结构化输出。你**必须**在完成分析后,调用一次 \`${STRUCTURED_OUTPUT_TOOL_NAME}\` 工具,
按其 inputSchema 指定的 JSON Schema 返回结果。不要把结构化数据写在普通文本里——只有通过该工具
返回的内容才会被 workflow 采纳。若工具报告 schema 不匹配,请阅读错误信息修正字段后重新调用。`;
}
