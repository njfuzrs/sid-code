/**
 * 终端集成 Hook（TM2/TM3/TM4 接线）
 *
 * 把 src/ink/ 已实现的终端能力 hook 接到 app 层：
 * - TM2 终端标题（OSC 0）：随会话状态更新窗口/标签标题,多窗口可识别。
 *   标题格式「<状态前缀> <任务名>」：
 *     · 进行中  → 动画盲文点 ⠂⠐ 交替（对标 cc 的"小圆点代表进行中"）
 *     · 完成/中断/等待/空闲 → 静态星号 ✳（对标 cc 的"小星号代表结束或中断"）
 *   全为单色几何字形,不用彩色 emoji（项目 L1.1 铁律）。
 * - TM4 tab 状态（OSC 21337）：idle/busy/waiting 彩色圆点。
 * - TM3 桌面通知 / bell（OSC 777 + BEL）：响应从「忙」回到「闲」时提醒一次。
 *
 * 设计原则：
 * - 纯 app 层接线,底层发送逻辑由 ink hook / context 封装,终端不支持时静默丢弃。
 * - 通知仅在「忙→闲」边沿触发一次,避免每帧/每 token 刷屏。
 * - 标题动画仅在「进行中」跑,且 a11y 模式下完全关闭（屏幕阅读器会把标题
 *   每帧变化读成噪声,对标 LoadingIndicator 的 a11y 处理）。
 * - writeRaw context 缺失（headless / 测试）时整体降级为 no-op。
 */

import { useContext, useEffect, useRef, useState } from "react";
import { StreamingState } from "../types.ts";
import { useTerminalTitle } from "@sid-code/tui-renderer/hooks/use-terminal-title.ts";
import { useTabStatus, type TabStatusKind } from "@sid-code/tui-renderer/hooks/use-tab-status.ts";
import { TerminalWriteContext } from "@sid-code/tui-renderer/useTerminalNotification.ts";
import { BEL } from "@sid-code/tui-renderer/termio/ansi.ts";
import { OSC, osc, wrapForMultiplexer } from "@sid-code/tui-renderer/termio/osc.ts";
import { useIsAccessibilityEnabled } from "../accessibility/AccessibilityContext.tsx";
import { TITLE_STATIC_PREFIX, TITLE_ANIMATION_FRAMES } from "../constants/figures.ts";

/** 标题动画切帧间隔（毫秒）。对标 cc 的 TITLE_ANIMATION_INTERVAL_MS=960,刻意慢——
 *  标题栏不需要高频跳动,慢节奏更省 setState 且不打扰。 */
const TITLE_ANIMATION_INTERVAL_MS = 960;

export interface UseTerminalIntegrationProps {
  /** 当前流式状态 */
  streamingState: StreamingState;
  /** 标题用的任务名/项目名（会话任务名优先,回退 cwd 末段） */
  titleHint?: string;
  /** 是否启用桌面通知（响应完成提醒）。默认 true */
  notifyOnComplete?: boolean;
}

/** 把流式状态映射为 tab 状态圆点 */
function toTabStatus(state: StreamingState): TabStatusKind {
  switch (state) {
    case StreamingState.Connecting:
    case StreamingState.Responding:
      // Connecting（等首字）也算「忙」——tab 圆点在连接期就要亮起。
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
  const a11y = useIsAccessibilityEnabled();

  // TM4：tab 状态彩色圆点
  useTabStatus(toTabStatus(streamingState));

  // ── TM2：终端标题 ──
  const baseTitle = titleHint && titleHint.trim() ? titleHint.trim() : "sid-code";
  // 「活动中」= 连接（等首字）或响应中。标题动画前缀在连接期就开始跳动，
  // 让用户从回车那刻起就看到窗口在「工作」，而非等首字到达才动。
  const isActive =
    streamingState === StreamingState.Connecting ||
    streamingState === StreamingState.Responding;

  // 进行中跑标题动画帧（a11y 下不跑,见文件头说明）。
  const [frame, setFrame] = useState(0);
  useEffect(() => {
    if (a11y || !isActive) return;
    const timer = setInterval(() => {
      setFrame((f) => (f + 1) % TITLE_ANIMATION_FRAMES.length);
    }, TITLE_ANIMATION_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [a11y, isActive]);

  // 活动中 → 动画点（a11y 下退化为静态首帧）；其余状态 → 静态星号。
  const prefix = isActive
    ? (a11y ? TITLE_ANIMATION_FRAMES[0] : TITLE_ANIMATION_FRAMES[frame] ?? TITLE_ANIMATION_FRAMES[0])
    : TITLE_STATIC_PREFIX;
  useTerminalTitle(`${prefix} ${baseTitle}`);

  // ── TM3：响应完成通知（忙→闲边沿触发一次）──
  const prevStateRef = useRef<StreamingState>(streamingState);

  useEffect(() => {
    const prev = prevStateRef.current;
    prevStateRef.current = streamingState;

    if (!notifyOnComplete || !writeRaw) return;

    // 从「忙」回到「闲」视为一轮响应完成 → 提示一次。
    // 「忙」含 Connecting 与 Responding：若请求在首字到达前被取消（Connecting→Idle），
    // 同样视为一轮结束，提示一次。
    const wasBusy =
      prev === StreamingState.Connecting || prev === StreamingState.Responding;
    if (wasBusy && streamingState === StreamingState.Idle) {
      // 原始 BEL：所有终端/tmux 都能 fallback（tmux 触发 window bell flag）。
      writeRaw(BEL);
      // Ghostty 桌面通知；不支持的终端会静默丢弃该 OSC 序列。
      writeRaw(wrapForMultiplexer(osc(OSC.GHOSTTY, "notify", baseTitle, "响应完成")));
    }
  }, [streamingState, notifyOnComplete, writeRaw, baseTitle]);
}
