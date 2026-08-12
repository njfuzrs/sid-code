/**
 * G19：LegacyTool ↔ 新泛型 Tool 桥接适配器
 *
 * 允许用 buildTool() 构建的新版 Tool 注册到现有 Registry（仅接受 LegacyTool）。
 * 这是渐进迁移的关键基础设施——新工具可逐一用新接口写，通过 bridge 注册到产线 registry，
 * 无需等全量迁移完成或改 registry 内部类型。
 *
 * 桥接方向：新 Tool → LegacyTool 包装（toLegacyTool）
 * 反向（LegacyTool → Tool）暂不需要——registry 直接消费 LegacyTool。
 */

import type {
  Tool,
  LegacyTool,
  LegacyToolResult,
  ToolProgressData,
  ToolDescriptionContext,
  ToolUseContext,
  PermissionResult,
} from "./types.ts";

/**
 * 将新版 Tool<Input, Output> 适配为 LegacyTool，可直接 registry.register()。
 *
 * 映射规则：
 * - name: string → name(): string（getter 包装）
 * - description(ctx?) → description(ctx?)（透传）
 * - inputSchema() → inputSchema()（透传）
 * - call(input, ctx, onProgress) → execute(input, signal, onProgress)（适配 ToolUseContext 合成）
 * - isReadOnly(input) → readOnly()（无参回退 isReadOnly()）
 * - isConcurrencySafe(input) → isConcurrencySafe(input)（透传）
 * - checkPermissions → checkPermissions（透传）
 * - ToolCapabilityFields 全部透传（zodSchema/searchHint/shouldDefer/interruptBehavior/...）
 */
export function toLegacyTool<Input = unknown, Output = string>(
  tool: Tool<Input, Output>,
): LegacyTool {
  const legacy: LegacyTool = {
    name() {
      return tool.name;
    },

    description(ctx?: ToolDescriptionContext) {
      return tool.description(ctx);
    },

    inputSchema() {
      return tool.inputSchema();
    },

    async execute(
      input: unknown,
      signal?: AbortSignal,
      onProgress?: (event: ToolProgressData) => void,
    ): Promise<LegacyToolResult> {
      // 合成最小化的 ToolUseContext（执行器真正使用的字段只有 abortSignal）
      const ctx: ToolUseContext = {
        options: {
          tools: [],
          mainLoopModel: "",
          mcpClients: [],
          isNonInteractive: false,
        },
        abortSignal: signal ?? new AbortController().signal,
        fileStateCache: null as any, // 新工具若需要可自行从闭包捕获
        messages: [],
        permissionMode: "default",
      };

      const result = await tool.call(input as Input, ctx, onProgress);

      return {
        output: typeof result.data === "string" ? result.data : JSON.stringify(result.data),
        isError: result.isError,
      };
    },

    readOnly() {
      return tool.isReadOnly();
    },

    isConcurrencySafe(input: unknown) {
      return tool.isConcurrencySafe(input as Input);
    },

    usageGuide() {
      return tool.usageGuide?.() ?? "";
    },
  };

  // 透传 ToolCapabilityFields
  if (tool.zodSchema) legacy.zodSchema = tool.zodSchema;
  if (tool.searchHint) legacy.searchHint = tool.searchHint;
  if (tool.shouldDefer) legacy.shouldDefer = tool.shouldDefer;
  if (tool.alwaysLoad) legacy.alwaysLoad = tool.alwaysLoad;
  if (tool.interruptBehavior) legacy.interruptBehavior = tool.interruptBehavior;
  if (tool.maxResultSizeChars !== undefined) legacy.maxResultSizeChars = tool.maxResultSizeChars;
  if (tool.toAutoClassifierInput)
    legacy.toAutoClassifierInput = tool.toAutoClassifierInput.bind(tool);
  if (tool.backfillObservableInput)
    legacy.backfillObservableInput = tool.backfillObservableInput.bind(tool);

  // 权限检查透传
  if (tool.checkPermissions) {
    legacy.checkPermissions = async (
      input: unknown,
      context: ToolUseContext,
    ): Promise<PermissionResult> => {
      return tool.checkPermissions!(input as Input, context);
    };
  }

  return legacy;
}
