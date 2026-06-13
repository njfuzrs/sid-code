/**
 * 重试/限流状态提示 — CM3（实时倒计时）+ CM4（限流升级建议）
 *
 * 当 LLM 请求触发重试/限流/过载/降级时，在流式区上方显示一条友好提示：
 * - CM3：基于 retryAtMs 实时倒计时「N 秒后重试…」，由共享时钟驱动（use-interval.ts 的
 *   useAnimationTimer，避免各自起 setInterval）。
 * - CM4：当 kind=rate_limit 时附升级建议（切换模型 / 提升配额）。
 *
 * 数据来源：TUIState.retryStatus（app.ts 的 fallback onRetry/onFallback 回调写入）。
 */

import React from "react";
import Box from "../../ink/components/Box.js";
import Text from "../../ink/components/Text.js";
import { theme } from "../semantic-colors.ts";
import { useAnimationTimer } from "../../ink/hooks/use-interval.ts";
import type { RetryStatusInfo } from "../App.tsx";

interface RetryStatusProps {
  status: RetryStatusInfo | null;
  /** 当前时间戳（毫秒）。默认用共享时钟实时刷新；测试可注入固定值。 */
  nowMs?: number;
}

/** 剩余秒数（向上取整，至少 0）。 */
export function remainingSeconds(retryAtMs: number, nowMs: number): number {
  return Math.max(0, Math.ceil((retryAtMs - nowMs) / 1000));
}

/** 各类重试的主提示文案。 */
function headline(status: RetryStatusInfo, secs: number): string {
  switch (status.kind) {
    case "rate_limit":
      return secs > 0
        ? `⚠ 触发限流（第 ${status.attempt} 次重试），${secs} 秒后重试…`
        : `⚠ 触发限流，正在重试（第 ${status.attempt} 次）…`;
    case "overloaded":
      return secs > 0
        ? `⚠ 服务过载（第 ${status.attempt} 次重试），${secs} 秒后重试…`
        : `⚠ 服务过载，正在重试（第 ${status.attempt} 次）…`;
    case "fallback":
      return `↘ 已降级到备用模型 ${status.fallbackModel ?? ""}`.trimEnd();
    case "retry":
    default:
      return secs > 0
        ? `⟳ 请求失败（第 ${status.attempt} 次重试），${secs} 秒后重试…`
        : `⟳ 正在重试（第 ${status.attempt} 次）…`;
  }
}

export const RetryStatus: React.FC<RetryStatusProps> = ({ status, nowMs }) => {
  // 共享时钟实时刷新（每 ~500ms），仅当有 status 时才有意义。
  const tick = useAnimationTimer(500);
  if (!status) return null;

  const now = nowMs ?? (tick || Date.now());
  const secs = remainingSeconds(status.retryAtMs, now);
  const color =
    status.kind === "rate_limit" || status.kind === "overloaded"
      ? theme.status.error
      : theme.status.warning;

  return (
    <Box flexDirection="column" paddingX={1}>
      <Text color={color}>{headline(status, secs)}</Text>
      {status.kind === "rate_limit" ? (
        <Text color={theme.text.secondary}>
          建议：用 /model 切换到其它模型，或检查 API 配额 / 升级套餐以提升限流额度。
        </Text>
      ) : null}
    </Box>
  );
};
