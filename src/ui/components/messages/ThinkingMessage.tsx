/**
 * 思考过程展示组件
 *
 * 渲染模型的思考过程。视觉语言（对标 Claude Code / gemini-cli）：
 * - 标题行：✻ 图标 + 状态文案（流式中 = "思考中…"，已完成 = "思考过程"）
 * - 正文：统一 secondary + italic，左侧一条竖线引导，保留段落结构
 * - 折叠态：单行摘要，含字符数与展开提示
 *
 * 关键设计原则：单一视觉语言，不做"第一行高亮、其余暗色"的无依据多色处理。
 */

import React from "react";
import Box from "../../../ink/components/Box.js";
import Text from "../../../ink/components/Text.js";
import { ClockContext } from "../../../ink/components/ClockContext.js";
import { theme } from "../../semantic-colors.ts";
import { THINKING_MARK, CURSOR } from "../../constants/figures.ts";
import { formatLargeNumber } from "../../utils/format-number.ts";

interface ThinkingMessageProps {
  text: string;
  width: number;
  /** 是否折叠为一行摘要，默认 false（展开） */
  collapsed?: boolean;
  /** 是否正在流式输出（仅影响标题文案：思考中… vs 思考过程） */
  streaming?: boolean;
  /** 思考耗时（秒）。流式态由组件自计时；完成态可由外部传入冻结值 */
  thinkingSeconds?: number;
  /**
   * 思考开始的绝对时间戳（ms，来自 app.ts onThinking 首帧）。
   * 传入后计时器以此为起点，与 stream-processor 的 durationMs 同源，
   * 避免流式→历史项转换时秒数跳变。不传则退回组件挂载时刻（旧行为）。
   */
  thinkingStartMs?: number;
  /**
   * 折叠态是否显示「ctrl+o 展开」提示，默认 true。
   * 仅在 ctrl+o 真能切换的场景（AB 虚拟列表模式）显示；
   * 主屏 Static 模式（print-and-forget，无法重渲已打印项）传 false，避免误导。
   */
  showExpandHint?: boolean;
}

/** 格式化思考耗时 */
function formatThinkingDuration(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}m${s}s`;
}

/**
 * 思考态计时 Hook：仅在 streaming=true 时累加秒数，停止后冻结当前值。
 *
 * thinkingStartMs：外部传入的起点时间戳（来自 onThinking 首帧，与 stream-processor
 * 的 durationMs 同源）。传入则用之；不传则退回组件挂载时刻（旧行为，误差 < 1 帧）。
 *
 * 关键：以 keepAlive=true 订阅 Clock，自己驱动时钟。
 * 纯思考阶段（正文尚未开始、无后台任务）可能没有其他 keepAlive 订阅者，
 * 若用 keepAlive=false 则 Clock 的 setInterval 不启动，回调永远不触发，
 * 计时器卡在 0。思考计时是用户正在关注的"活"指标，理应自驱动。
 */
function useThinkingTimer(streaming: boolean, thinkingStartMs?: number): number {
  const [seconds, setSeconds] = React.useState(0);
  const startRef = React.useRef<number | null>(null);
  const clock = React.useContext(ClockContext);

  // 进入流式态时记录起点并清零；离开流式态时保留最后值（冻结）。
  // 优先用外部传入的 thinkingStartMs（与 stream-processor durationMs 同源），
  // 无则退回 Date.now()（组件挂载时刻，旧行为）。
  React.useEffect(() => {
    if (streaming) {
      startRef.current = thinkingStartMs ?? Date.now();
      setSeconds(Math.floor((Date.now() - startRef.current) / 1000));
    } else {
      startRef.current = null;
    }
  }, [streaming, thinkingStartMs]);

  // 直接订阅 Clock，keepAlive=true 确保时钟自驱动
  React.useEffect(() => {
    if (!clock || !streaming) return;

    let lastUpdate = clock.now();

    const onChange = (): void => {
      const now = clock.now();
      if (now - lastUpdate >= 1000) {
        lastUpdate = now;
        if (startRef.current !== null) {
          setSeconds(Math.floor((Date.now() - startRef.current) / 1000));
        }
      }
    };

    // keepAlive=true：思考计时器自驱动 Clock，不依赖其他组件
    return clock.subscribe(onChange, true);
  }, [clock, streaming]);

  return seconds;
}

/**
 * 规整思考文本：
 * - 去除每行尾部空白
 * - 合并连续空行为单个空行（保留段落分隔，不粗暴删光）
 * - 去除首尾空行
 */
function normalizeThinkingLines(text: string): string[] {
  const rawLines = text.replace(/\r\n/g, "\n").split("\n");
  const out: string[] = [];
  let blankRun = 0;
  for (const line of rawLines) {
    if (line.trim() === "") {
      blankRun++;
      // 仅在已有内容后保留至多一个空行作为段落分隔
      if (blankRun === 1 && out.length > 0) out.push("");
    } else {
      blankRun = 0;
      out.push(line.replace(/\s+$/, ""));
    }
  }
  while (out.length > 0 && out[out.length - 1] === "") out.pop();
  return out;
}

export const ThinkingMessage: React.FC<ThinkingMessageProps> = ({
  text,
  width,
  collapsed = false,
  streaming = false,
  thinkingSeconds,
  thinkingStartMs,
  showExpandHint = true,
}) => {
  // 流式态自计时；完成态优先用外部传入的冻结值，无则自计时器最后值。
  const timerSeconds = useThinkingTimer(streaming, thinkingStartMs);
  const elapsed = thinkingSeconds ?? timerSeconds;

  if (!text.trim()) return null;

  // 折叠态：单行摘要（对标 claude-code 的 "∴ Thinking" 一行折叠）
  // 流式中折叠 → 显示实时耗时（思考仍在进行，但不抢正文视口）；
  // 完成后折叠 → 显示已思考耗时 + 字符数。
  if (collapsed) {
    const summary = streaming
      ? `${THINKING_MARK} 思考中… (${formatThinkingDuration(elapsed)})`
      : elapsed > 0
        ? `${THINKING_MARK} 已思考 ${formatThinkingDuration(elapsed)} · ${formatLargeNumber(text.length)} 字符`
        : `${THINKING_MARK} 思考过程 · ${formatLargeNumber(text.length)} 字符`;
    return (
      <Box width={width}>
        <Text color={theme.text.secondary} italic>
          {summary}
          {/* 仅在 ctrl+o 真能展开时给提示；流式中不提示（无需打扰） */}
          {!streaming && showExpandHint ? " · ctrl+o 展开" : ""}
        </Text>
      </Box>
    );
  }

  const lines = normalizeThinkingLines(text);
  if (lines.length === 0) return null;

  // 标题：流式中显示「思考中… (Ns)」实时耗时；完成态显示「已思考 Ns」
  const title = streaming
    ? `${THINKING_MARK} 思考中… (${formatThinkingDuration(elapsed)})`
    : elapsed > 0
      ? `${THINKING_MARK} 已思考 ${formatThinkingDuration(elapsed)}`
      : `${THINKING_MARK} 思考过程`;
  // 正文容器扣除 marginLeft(1)，其内 border(1)+paddingLeft(1) 由 ink 在该宽度内分配
  const bodyWidth = Math.max(1, width - 1);

  return (
    <Box width={width} flexDirection="column">
      {/* 标题行：secondary 色 italic 弱化，不抢正文注意力 */}
      <Box marginBottom={1}>
        <Text color={theme.text.secondary} italic>
          {title}
        </Text>
      </Box>

      {/* 正文：左侧竖线引导 + 统一 secondary italic */}
      <Box
        marginLeft={1}
        paddingLeft={1}
        borderStyle="single"
        borderLeft={true}
        borderRight={false}
        borderTop={false}
        borderBottom={false}
        borderColor={theme.ui.dark}
        flexDirection="column"
        width={bodyWidth}
      >
        {lines.map((line, index) => (
          <Text
            key={`thought-${index}`}
            color={theme.text.secondary}
            italic
            wrap="wrap"
          >
            {line === "" ? " " : line}
          </Text>
        ))}
        {/* 流式时在末尾附一个光标提示，暗示仍在输出 */}
        {streaming && (
          <Text color={theme.ui.dark}>
            {CURSOR}
          </Text>
        )}
      </Box>
    </Box>
  );
};
