/**
 * 工具结果呈现档位的**解析单点**。
 *
 * 背景与设计依据见 `tool/types.ts` 的 `ToolCapabilityFields.resultDisplayMode` 注释
 * （病灶：一个 `output: string` 兼了「模型侧 tool_result 正文」与「用户侧展示内容」两职，
 * 导致 `todo_write` 等工具的提示词直接泄漏到 TUI；对标 claude-code 的双出口设计）。
 *
 * ## 为什么要单独一个模块
 *
 * 有**两个**执行器需要做同一件事（`query/tool-executor.ts` 主循环、
 * `agent/tool-executor.ts` 子代理），且字段有常量与函数两种形态、函数还可能抛。
 * 两处各写一遍 `typeof m === "function" ? m(input) : m` 迟早漂移出
 * 「主循环隐藏了、子代理没隐藏」这类只在特定路径复现的不一致——本仓库在
 * `buildSettledToolCallIfReady`（history-adapter.ts）上已经吃过一次同型的亏。
 *
 * ## 契约
 *
 * - **纯函数、不抛**。工具自报的函数形态若抛异常，按「无声明」处理（原样展示）：
 *   呈现档位的判定失败绝不该让工具调用本身失败，也不该静默吞掉结果。
 * - **只影响展示**。返回值不参与 `ToolResultBlock.content` 的构造，模型侧行为零改动。
 */

import type { ToolResultDisplayMode } from "./types.ts";

/**
 * 能自报呈现档位的最小结构。
 *
 * 刻意只约束 `resultDisplayMode` 一个字段、不 `Pick` 自 `LegacyTool | Tool`：
 * 新旧两版接口都带这个字段（都 extends `ToolCapabilityFields`），而调用方拿到的
 * 静态类型时而是 `LegacyTool`、时而是 `Tool`、时而是 registry 的联合类型。
 * 按「有这个字段就能解析」结构化约束，比枚举接口更贴合实际调用点。
 */
type DisplayModeCapable = {
  resultDisplayMode?:
    | ToolResultDisplayMode
    | ((input: unknown) => ToolResultDisplayMode | undefined);
};

/**
 * 解析某次工具调用的呈现档位。
 *
 * @param tool  工具实例（可能为 undefined——注册表查不到时按无声明处理）
 * @param input 本次调用的原始 input（函数形态据此分档，如 skill 的 activate/delegate）
 * @returns `"hidden"` / `"summary"`，或 `undefined` 表示原样展示
 */
export function resolveResultDisplayMode(
  tool: DisplayModeCapable | undefined | null,
  input: unknown,
): ToolResultDisplayMode | undefined {
  const mode = tool?.resultDisplayMode;
  if (!mode) return undefined;
  if (typeof mode !== "function") return mode;
  try {
    return mode(input) ?? undefined;
  } catch {
    // 判定失败 → 原样展示。宁可多显示一点，不可因为一个展示优化让结果消失。
    return undefined;
  }
}
