/**
 * 工具系统核心类型
 * 新版泛型 Tool 接口 + buildTool() 工厂函数
 * 旧版 LegacyTool 接口保留用于渐进式迁移
 */

import type { ContentBlock } from "../llm/types.ts";
import type { z } from "zod/v4";

/**
 * 工具 zod schema 的统一类型。
 *
 * 从 `zod/v4` 子路径取（与 `z.toJSONSchema` 同源）——zod 3.25 内部同时打包
 * v3(classic) 与 v4，`toJSONSchema` 只在 v4 暴露。工具层一律用 v4 schema，
 * 由执行器 `safeParse` 做运行时校验、registry 用 `z.toJSONSchema` 生成 LLM 定义。
 */
export type ToolZodSchema<Input = unknown> = z.ZodType<Input>;

/**
 * description() 的上下文入参（对标 claude-code 的入参感知描述）。
 *
 * 工具可据此动态调整描述文本——例如非交互模式下隐藏需要 UI 确认的提示，
 * 或按权限上下文补充约束。全部可选：无参调用（description()）仍然合法，
 * 既有 25 个工具的零参实现无需改动即满足新签名（可选参数向后兼容）。
 */
export interface ToolDescriptionContext {
  /** 是否非交互模式（SDK/CI）——可据此省略需要 UI 交互的说明 */
  isNonInteractive?: boolean;
  /** 当前权限模式（default / plan / acceptEdits 等） */
  permissionMode?: string;
}

/**
 * ToolSearch 协议字段 + 中断行为 —— 新旧两版接口共享的"能力声明"。
 *
 * 字段先行：`searchHint` / `shouldDefer` / `alwaysLoad` 由 registry 的
 * activeDefinitions() 消费（按 shouldDefer 过滤首轮上下文），`interruptBehavior`
 * 为后续接线预留。`zodSchema` 由执行器与 registry 消费（运行时校验 + JSON Schema 生成）。
 */
export interface ToolCapabilityFields<Input = unknown> {
  /**
   * zod schema（替代手写 JSON Schema，提供运行时校验 + 类型推导）。
   * 可选：与 inputSchema() 共存。执行器优先 safeParse(zodSchema)，registry 优先
   * z.toJSONSchema(zodSchema) 生成 LLM 定义；未提供时回退到 inputSchema()。
   */
  zodSchema?: ToolZodSchema<Input>;

  /** 给 ToolSearch 做关键词匹配的一句话描述（3-10 词） */
  searchHint?: string;

  /** 标记为延迟加载——默认不进 LLM 上下文（由 ToolSearch 按需调出） */
  shouldDefer?: boolean;

  /** 强制不进延迟加载（ToolSearch 启用时仍首轮可见） */
  alwaysLoad?: boolean;

  /** 用户发新消息时的行为：cancel（取消）或 block（继续运行），默认 block */
  interruptBehavior?: () => "cancel" | "block";

  /**
   * 工具结果最大字符数（超过则持久化到磁盘并返回摘要）。Infinity 表示不限制。
   *
   * 执行器把它透传给 result-storage 的 processToolResult，优先于 storage 内置的
   * TOOL_MAX_RESULT_SIZE 常量表——让"落盘阈值"成为工具自身可控的接口字段。
   * 未声明时回退到常量表 / 默认值。新旧两版接口共享。
   */
  maxResultSizeChars?: number;

  /**
   * G7：给 auto 模式安全分类器（tool-classifier.ts）看的"精简语义视图"。
   *
   * 对标 claude-code Tool.ts:556 `toAutoClassifierInput`。分类器默认吃原始完整 input，
   * 上下文臃肿且噪声大；工具可实现此钩子自报"最能反映风险的关键片段"（如 Edit 报
   * `/tmp/x: new content`）。返回 `undefined` 表示无自定义视图（分类器回退原始 input）；
   * 返回空字符串 `""` 表示该工具与安全无关、可跳过 LLM 判断（分类器据此走保守放行/降噪）。
   *
   * 纯读取语义、无副作用——分类器只读它，不据此改变执行输入。
   */
  toAutoClassifierInput?(input: Input): string | undefined;
}

// ===== 旧版接口（渐进式迁移期间保留） =====

/** 旧版工具执行结果 */
export interface LegacyToolResult {
  output: string;
  isError?: boolean;
  /**
   * 结构化 diff(edit/write 工具填充)。由 tool-executor 透传到
   * ToolResultBlock.structuredPatch,供 UI 直接渲染高亮,绕过文本正则解析。
   * 其余工具不填充,保持 undefined。
   */
  structuredPatch?: import("diff").StructuredPatchHunk[];
}

/**
 * 旧版工具接口。
 *
 * @deprecated 自 2026-06 工具接口现代化起，新工具请使用新版泛型 `Tool<Input, Output, Progress>`。
 * 当前 25 个工具类仍是 LegacyTool 实现（渐进式迁移中，尚未完成向新版 Tool 的接口级迁移），
 * 但已全部接入 zod schema 运行时校验。待全部工具完成接口迁移后，此接口将被删除。
 */
export interface LegacyTool extends ToolCapabilityFields {
  name(): string;
  /** 工具描述（发送给 LLM）。可选入参用于入参/上下文感知（对标 claude-code），无参调用兼容既有实现。 */
  description(context?: ToolDescriptionContext): string;
  inputSchema(): Record<string, unknown>;
  /**
   * 执行工具。
   *
   * @param onProgress 可选进度回调（G5 接线）。长跑工具（大 bash、大 web_fetch）可在执行
   *   期间多次调用，把中间进度桥接到 UI；执行器负责把它路由到状态栏。既有工具不实现即忽略，
   *   向后兼容（可选参数）。对标 claude-code toolExecution.ts 的 progress 流桥接。
   */
  execute(input: unknown, signal?: AbortSignal, onProgress?: (event: ToolProgressData) => void): Promise<LegacyToolResult>;
  readOnly?(): boolean;
  isConcurrencySafe?(input: unknown): boolean;
  usageGuide?(): string;
  /**
   * 工具自身的额外权限逻辑（passthrough 语义）。
   * 接口未强制，但 checker.ts Step 5.5 以鸭子类型调用；read/write/edit/bash 等已实现。
   */
  checkPermissions?(input: unknown, context: ToolUseContext): Promise<PermissionResult>;
}

// ===== 新版接口 =====

/** 工具进度事件基类 */
export interface ToolProgressData {
  type: string;
  [key: string]: unknown;
}

/** 工具执行结果 — 三元组 */
export interface ToolResult<T = string> {
  /** 工具的实际输出数据 */
  data: T;
  /** 工具执行是否出错 */
  isError?: boolean;
  /** 工具执行过程中产生的附加消息（如子代理的对话历史） */
  newMessages?: Array<{ role: string; content: ContentBlock[] }>;
  /** 上下文修改器（如 EnterPlanMode 需要修改权限模式） */
  contextModifier?: (context: ToolUseContext) => ToolUseContext;
}

/** 权限检查结果 */
export type PermissionResult =
  | { behavior: "allow"; updatedInput?: unknown }
  | { behavior: "deny"; message: string }
  | { behavior: "ask"; message: string }
  | { behavior: "passthrough" };  // 工具没有意见，交给权限系统决定

/** 输入校验结果 */
export type ValidationResult =
  | { result: true }
  | { result: false; message: string };

/** 工具执行的完整环境快照 */
export interface ToolUseContext {
  /** 配置 */
  options: {
    tools: Tool[];
    mainLoopModel: string;
    mcpClients: unknown[];
    /** 非交互模式（SDK/CI） */
    isNonInteractive: boolean;
  };

  /** 中止信号 */
  abortSignal: AbortSignal;

  /** 文件状态缓存 */
  fileStateCache: import("./file-state-cache.ts").FileStateCache;

  /** 消息历史 */
  messages: Array<{ role: string; content: ContentBlock[] }>;

  /** 权限模式 */
  permissionMode: string;

  /** 子代理 ID（仅子代理执行时有值） */
  agentId?: string;

  /** 子代理类型（仅子代理执行时有值） */
  agentType?: string;
}

/** 工具接口 — 泛型版本 */
export interface Tool<
  Input = unknown,
  Output = string,
  Progress extends ToolProgressData = ToolProgressData,
> extends ToolCapabilityFields<Input> {
  /** 工具唯一名称 */
  readonly name: string;

  // ===== 核心生命周期 =====

  /** 执行工具操作 */
  call(
    input: Input,
    context: ToolUseContext,
    onProgress?: (event: Progress) => void,
  ): Promise<ToolResult<Output>>;

  /**
   * 输入校验（在权限检查之前执行）。
   *
   * @deprecated 全仓零调用，从未被任何 executor 接线。畸形参数的运行时拦截已由
   * 执行器的 zod `safeParse(zodSchema)` 在工具边界统一完成（见 query/tool-executor.ts
   * 与 agent/tool-executor.ts）。保留此字段仅为向后兼容，新工具请用 `zodSchema`。
   */
  validateInput?(input: Input, context: ToolUseContext): Promise<ValidationResult>;

  /** 权限检查（工具自身的额外权限逻辑） */
  checkPermissions?(input: Input, context: ToolUseContext): Promise<PermissionResult>;

  // ===== 输入感知的安全标记 =====

  /** 是否只读（影响 plan 模式自动放行、并发策略） */
  isReadOnly(input?: Input): boolean;

  /** 是否并发安全（影响多工具并行执行） */
  isConcurrencySafe(input?: Input): boolean;

  /** 是否破坏性操作（影响安全分类器风险评估） */
  isDestructive?(input?: Input): boolean;

  /** 当前环境是否可用 */
  isEnabled(): boolean;

  // ===== 模型交互 =====

  /** 工具描述（发送给 LLM）。可选入参用于入参/上下文感知（对标 claude-code），无参调用兼容既有实现。 */
  description(context?: ToolDescriptionContext): string;

  /** 参数的 JSON Schema */
  inputSchema(): Record<string, unknown>;

  /** 工具使用指南（注入系统提示词） */
  usageGuide?(): string;

  // ===== 结果序列化 =====

  /** 将工具结果序列化为 API 格式的 tool_result */
  serializeResult?(data: Output, toolUseId: string): {
    type: "tool_result";
    tool_use_id: string;
    content: string;
    is_error?: boolean;
  };
}

// ===== 工厂函数 =====

/** 工具默认值 — fail-closed 哲学 */
const TOOL_DEFAULTS: Partial<Tool> = {
  isEnabled: () => true,
  isReadOnly: () => false,
  isConcurrencySafe: () => false,
  isDestructive: () => false,
};

/** 工具定义（buildTool 的输入） */
export type ToolDef<Input = unknown, Output = string> = Partial<Tool<Input, Output>> & {
  name: string;
  call: Tool<Input, Output>["call"];
  description: Tool<Input, Output>["description"];
  inputSchema: Tool<Input, Output>["inputSchema"];
};

/** 工厂函数：填充默认值，返回完整的 Tool 对象 */
export function buildTool<Input = unknown, Output = string>(
  def: ToolDef<Input, Output>,
): Tool<Input, Output> {
  return {
    ...TOOL_DEFAULTS,
    ...def,
  } as Tool<Input, Output>;
}
