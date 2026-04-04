/**
 * 工具系统核心类型
 * 新版泛型 Tool 接口 + buildTool() 工厂函数
 * 旧版 LegacyTool 接口保留用于渐进式迁移
 */

import type { ContentBlock } from "../llm/types.ts";

// ===== 旧版接口（渐进式迁移期间保留） =====

/** 旧版工具执行结果 */
export interface LegacyToolResult {
  output: string;
  isError?: boolean;
}

/** 旧版工具接口 */
export interface LegacyTool {
  name(): string;
  description(): string;
  inputSchema(): Record<string, unknown>;
  execute(input: unknown, signal?: AbortSignal): Promise<LegacyToolResult>;
  readOnly?(): boolean;
  isConcurrencySafe?(input: unknown): boolean;
  usageGuide?(): string;
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
> {
  /** 工具唯一名称 */
  readonly name: string;

  // ===== 核心生命周期 =====

  /** 执行工具操作 */
  call(
    input: Input,
    context: ToolUseContext,
    onProgress?: (event: Progress) => void,
  ): Promise<ToolResult<Output>>;

  /** 输入校验（在权限检查之前执行） */
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

  /** 工具描述（发送给 LLM） */
  description(): string;

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

  /** 工具结果最大字符数（超过则持久化到磁盘），Infinity 表示不限制 */
  maxResultSizeChars?: number;
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

// ===== 适配器 =====

/**
 * 适配器：将旧 LegacyTool 包装为新 Tool 接口
 * 渐进式迁移期间使用，新旧接口共存
 */
export function legacyToolAdapter(legacy: LegacyTool): Tool {
  return buildTool({
    name: legacy.name(),
    description: legacy.description.bind(legacy),
    inputSchema: legacy.inputSchema.bind(legacy),
    usageGuide: legacy.usageGuide ? legacy.usageGuide.bind(legacy) : undefined,
    isReadOnly: () => legacy.readOnly?.() ?? false,
    isConcurrencySafe: (input?: unknown) => {
      // 优先使用细粒度的 isConcurrencySafe
      if (legacy.isConcurrencySafe) {
        return legacy.isConcurrencySafe(input);
      }
      // 回退到 readOnly
      return legacy.readOnly?.() ?? false;
    },
    call: async (input: unknown, context: ToolUseContext) => {
      const result = await legacy.execute(input, context.abortSignal);
      return { data: result.output, isError: result.isError };
    },
  });
}

// ===== 向后兼容的类型别名 =====

/**
 * @deprecated 使用 LegacyToolResult 代替
 * 保留此别名以减少迁移期间的编译错误
 */
export type ToolResultCompat = LegacyToolResult;
