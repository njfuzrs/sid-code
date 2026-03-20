/**
 * 工具边框动态样式计算
 *
 * 根据工具执行状态动态计算边框颜色。
 * 参考 gemini-cli/packages/cli/src/ui/utils/borderStyles.ts
 */

import { theme } from "../semantic-colors.ts";
import type { ToolCallStatus } from "../components/messages/ToolShared.tsx";

/**
 * 计算工具分组的边框外观
 */
export function getToolGroupBorderAppearance(
  tools: Array<{ status: ToolCallStatus }>,
): { borderColor: string; borderDimColor: boolean } {
  if (tools.length === 0) {
    return { borderColor: theme.border.default, borderDimColor: false };
  }

  const hasPending = tools.some(
    (t) => t.status !== "success" && t.status !== "error" && t.status !== "cancelled",
  );

  const borderColor = hasPending ? theme.status.warning : theme.border.default;
  const borderDimColor = hasPending;

  return { borderColor, borderDimColor };
}
