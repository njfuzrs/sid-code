/**
 * 终端集成 Hook（TM2/TM3/TM4 接线）
 *
 * 把 src/ink/ 已实现的终端能力 hook 接到 app 层：
 * - TM2 终端标题（OSC 0）：随会话状态更新窗口/标签标题，多窗口可识别
 * - TM4 tab 状态（OSC 21337）：idle/busy/waiting 彩色圆点
 * - TM3 桌面通知 / bell（OSC 9/99/777 + BEL）：响应从「忙」回到「闲」时提醒一次
 *
 * 设计原则：
 * - 纯 app 层接线，底层发送逻辑由 ink hook / context 封装，终端不支持时静默丢弃。
 * - 通知仅在「忙→闲」边沿触发一次，避免每帧/每 token 刷屏。
 * - writeRaw context 缺失（headless / 测试）时整体降级为 no-op。
 */

import { useContext, useEffect, useRef } from "react";
import { StreamingState } from "../types.ts";
import { useTerminalTitle } from "../../ink/hooks/use-terminal-title.ts";
import { useTabStatus, type TabStatusKind } from "../../ink/hooks/use-tab-status.ts";
import { TerminalWriteContext } from "../../ink/useTerminalNotification.ts";
import { BEL } from "../../ink/termio/ansi.ts";
import { OSC, osc, wrapForMultiplexer } from "../../ink/termio/osc.ts";

export interface UseTerminalIntegrationProps {
  /** 当前流式状态 */
  streamingState: StreamingState;
  /** 标题用的项目名/会话名（如 cwd basename） */
  titleHint?: string;
  /** 是否启用桌面通知（响应完成提醒）。默认 true */
  notifyOnComplete?: boolean;
}

/** 把流式状态映射为 tab 状态圆点 */
function toTabStatus(state: StreamingState): TabStatusKind {
  switch (state) {
    case StreamingState.Responding:
      return "busy";
    case StreamingState.WaitingForConfirmation:
      return "waiting";
    case StreamingState.Idle:
    default:
      return "idle";
  }
}

export function useTerminalIntegration({
  streamingState,
  titleHint,
  notifyOnComplete = true,
}: UseTerminalIntegrationProps): void {
  const writeRaw = useContext(TerminalWriteContext);

  // TM4：tab 状态彩色圆点
  useTabStatus(toTabStatus(streamingState));

  // TM2：终端标题。忙时标注「⚙ 工作中」，等待确认标注「⏳」，闲时回到项目名。
  const baseTitle = titleHint && titleHint.trim() ? titleHint.trim() : "sid-code";
  const title =
    streamingState === StreamingState.Responding
      ? `⚙ ${baseTitle}`
      : streamingState === StreamingState.WaitingForConfirmation
        ? `⏳ ${baseTitle}`
        : baseTitle;
  useTerminalTitle(title);

  // TM3：响应完成通知（忙→闲边沿触发一次）
  const prevStateRef = useRef<StreamingState>(streamingState);

  useEffect(() => {
    const prev = prevStateRef.current;
    prevStateRef.current = streamingState;

    if (!notifyOnComplete || !writeRaw) return;

    // 从「忙」回到「闲」视为一轮响应完成 → 提示一次。
    if (prev === StreamingState.Responding && streamingState === StreamingState.Idle) {
      // 原始 BEL：所有终端/tmux 都能 fallback（tmux 触发 window bell flag）。
      writeRaw(BEL);
      // Ghostty 桌面通知；不支持的终端会静默丢弃该 OSC 序列。
      writeRaw(wrapForMultiplexer(osc(OSC.GHOSTTY, "notify", baseTitle, "响应完成")));
    }
  }, [streamingState, notifyOnComplete, writeRaw, baseTitle]);
}
