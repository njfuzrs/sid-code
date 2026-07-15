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
import { WARNING_MARK, RETRY_MARK, FALLBACK_MARK } from "../constants/figures.ts";
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
        ? `${WARNING_MARK} 触发限流（第 ${status.attempt} 次重试），${secs} 秒后重试…`
        : `${WARNING_MARK} 触发限流，正在重试（第 ${status.attempt} 次）…`;
    case "overloaded":
      return secs > 0
        ? `${WARNING_MARK} 服务过载（第 ${status.attempt} 次重试），${secs} 秒后重试…`
        : `${WARNING_MARK} 服务过载，正在重试（第 ${status.attempt} 次）…`;
    case "fallback":
      return `${FALLBACK_MARK} 已降级到备用模型 ${status.fallbackModel ?? ""}`.trimEnd();
    case "retry":
    default:
      return secs > 0
        ? `${RETRY_MARK} 请求失败（第 ${status.attempt} 次重试），${secs} 秒后重试…`
        : `${RETRY_MARK} 正在重试（第 ${status.attempt} 次）…`;
  }
}

export const RetryStatus: React.FC<RetryStatusProps> = ({ status, nowMs }) => {
  // 墙钟自持刷新（每 500ms）：不复用共享时钟的 useAnimationTimer。
  //
  // 两个根因（见 memory & docs/_template 现象记录）：
  // 1. useAnimationTimer 以 keepAlive=false 订阅共享时钟——只在有 keepAlive 订阅者
  //    （可见的 spinner 动画）驱动时才 tick。而请求失败等待重试的这段时间里，LLM 未在
  //    流式输出、spinner 未必在跑 → 共享时钟 interval 为 null → tick 永不推进 → 倒计时定格。
  // 2. 即便时钟在跑，clock.now() 返回的是「相对启动的毫秒」（Date.now()-startTime），
  //    而 retryAtMs 是「绝对时间戳」（Date.now()+delayMs）。两者量纲不同，相减得到的
  //    剩余秒数是错的（时钟一旦真跑起来反而算成一个巨大的负值 → 恒显示 0）。
  //
  // 正解：用一个只在本组件挂载期运行的墙钟 setInterval，nowState 取 Date.now()，与
  // retryAtMs 同量纲。父层（MainScreenLayout）无条件渲染 <RetryStatus status={retryStatus}/>，
  // status 为 null 时组件内部早返回 null；定时器的启停由 isCountingDown 门控的 effect
  // cleanup 管理（翻假即 clearInterval），而非组件卸载。测试可通过 nowMs 注入固定时刻绕过定时器。
  const [nowState, setNowState] = React.useState(() => Date.now());
  // 仅在"真正需要逐秒刷新的倒计时"时才起定时器：
  // - nowMs 注入（测试）→ 用固定值，不起定时器；
  // - kind==="fallback" → headline 是静态降级文案、不含秒数，起定时器纯空转，排除掉。
  const isCountingDown =
    !!status && nowMs === undefined && status.kind !== "fallback";
  React.useEffect(() => {
    if (!isCountingDown) return;
    const timer = setInterval(() => setNowState(Date.now()), 500);
    return () => clearInterval(timer);
  }, [isCountingDown]);

  if (!status) return null;

  const now = nowMs ?? nowState;
  const secs = remainingSeconds(status.retryAtMs, now);
  const color =
    status.kind === "rate_limit" || status.kind === "overloaded"
      ? theme.status.error
      : theme.status.warning;

  return (
    <Box flexDirection="column" paddingX={1}>
      <Text color={color}>{headline(status, secs)}</Text>
      {status.kind === "rate_limit" ? (
        <Box marginTop={1}>
          <Text color={theme.text.secondary}>
            建议：用 /model 切换到其它模型，或检查 API 配额 / 升级套餐以提升限流额度。
          </Text>
        </Box>
      ) : null}
    </Box>
  );
};
