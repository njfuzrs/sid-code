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
  ToolCapabilityFields,
  ToolProgressData,
  ToolDescriptionContext,
  ToolUseContext,
  PermissionResult,
} from "./types.ts";

/** 形态在两个接口上完全一致、可以原样透传的字段 */
type ForwardedKey = keyof ToolCapabilityFields | "isDestructive";

/**
 * 透传字段的唯一事实源。类型是 `Record<ForwardedKey, true>`：
 * - `ToolCapabilityFields` 新增一个键而这里没加 → tsc 报「缺少属性」；
 * - 这里写了一个接口上不存在的键 → tsc 报「对象字面量只能指定已知属性」。
 *
 * 为什么不是逐行 `if (tool.x) legacy.x = tool.x`：那种写法漏了 `isDestructive` 和 5 个
 * 能力字段（exemptFromLoopDetection / needsPermissionChecker / strictPriority /
 * jitAffectedPaths / resultDisplayMode），而文件头注释还写着「全部透传」。其中
 * `isDestructive` 漏传会让 checker Step 13.5 的安全类确认对新接口工具静默失效
 * （yesMode / auto 分类器下直接放行）。
 *
 * 为什么不是 `...tool` 整体展开：Tool 上有 `name`（字符串，LegacyTool 是方法）、`call`、
 * `isReadOnly`、`serializeResult` 等形态不同或 Legacy 侧没有的成员，展开会把它们原样
 * 带过去，而方法的 `this` 也要逐个处理。用键表等于「只展开确认过语义的那部分」。
 */
const FORWARDED_KEYS: Record<ForwardedKey, true> = {
  zodSchema: true,
  searchHint: true,
  shouldDefer: true,
  alwaysLoad: true,
  interruptBehavior: true,
  maxResultSizeChars: true,
  toAutoClassifierInput: true,
  backfillObservableInput: true,
  exemptFromLoopDetection: true,
  needsPermissionChecker: true,
  strictPriority: true,
  jitAffectedPaths: true,
  resultDisplayMode: true,
  isDestructive: true,
};

/** 测试与审计用：bridge 透传的全部键 */
export const BRIDGE_FORWARDED_KEYS = Object.keys(FORWARDED_KEYS) as ForwardedKey[];

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
 * - ToolCapabilityFields 与 isDestructive：按 FORWARDED_KEYS 全部透传（编译期穷举，
 *   方法绑定到原 tool，保证 `this` 指向不变）
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

    isEnabled() {
      return tool.isEnabled();
    },
  };

  // 透传 ToolCapabilityFields + isDestructive（键表见 FORWARDED_KEYS）。
  // 判 undefined 而非真值：`shouldDefer: false` / `strictPriority: 0` 也是有意义的声明。
  const target = legacy as unknown as Record<ForwardedKey, unknown>;
  for (const key of BRIDGE_FORWARDED_KEYS) {
    const value: unknown = tool[key];
    if (value === undefined) continue;
    target[key] = typeof value === "function" ? value.bind(tool) : value;
  }

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
