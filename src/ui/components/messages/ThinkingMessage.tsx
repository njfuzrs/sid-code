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
import { useInterval } from "../../../ink/hooks/use-interval.ts";
import { theme } from "../../semantic-colors.ts";

interface ThinkingMessageProps {
  text: string;
  width: number;
  /** 是否折叠为一行摘要，默认 false（展开） */
  collapsed?: boolean;
  /** 是否正在流式输出（仅影响标题文案：思考中… vs 思考过程） */
  streaming?: boolean;
  /** 思考耗时（秒）。流式态由组件自计时；完成态可由外部传入冻结值 */
  thinkingSeconds?: number;
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
 * 借共享 Clock（useInterval），不额外开 setInterval。
 */
function useThinkingTimer(streaming: boolean): number {
  const [seconds, setSeconds] = React.useState(0);
  const startRef = React.useRef<number | null>(null);

  // 进入流式态时记录起点并清零；离开流式态时保留最后值（冻结）。
  React.useEffect(() => {
    if (streaming) {
      startRef.current = Date.now();
      setSeconds(0);
    } else {
      startRef.current = null;
    }
  }, [streaming]);

  useInterval(
    () => {
      if (startRef.current !== null) {
        setSeconds(Math.floor((Date.now() - startRef.current) / 1000));
      }
    },
    streaming ? 1000 : null,
  );

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
}) => {
  // 流式态自计时；完成态优先用外部传入的冻结值，无则自计时器最后值。
  const timerSeconds = useThinkingTimer(streaming);
  const elapsed = thinkingSeconds ?? timerSeconds;

  if (!text.trim()) return null;

  // 折叠态：单行摘要
  if (collapsed) {
    return (
      <Box width={width}>
        <Text color={theme.text.secondary} dimColor>
          {"✻ 思考过程 · "}{text.length.toLocaleString()}{" 字符 · ctrl+t 展开"}
        </Text>
      </Box>
    );
  }

  const lines = normalizeThinkingLines(text);
  if (lines.length === 0) return null;

  // 标题：流式中显示「思考中… (Ns)」实时耗时；完成态显示「已思考 Ns」
  const title = streaming
    ? `✻ 思考中… (${formatThinkingDuration(elapsed)})`
    : elapsed > 0
      ? `✻ 已思考 ${formatThinkingDuration(elapsed)}`
      : "✻ 思考过程";
  // 正文容器扣除 marginLeft(1)，其内 border(1)+paddingLeft(1) 由 ink 在该宽度内分配
  const bodyWidth = Math.max(1, width - 1);

  return (
    <Box width={width} flexDirection="column">
      {/* 标题行：secondary 色 italic 弱化，不抢正文注意力 */}
      <Text color={theme.text.secondary} italic>
        {title}
      </Text>

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
          <Text color={theme.ui.dark} dimColor>
            {"▌"}
          </Text>
        )}
      </Box>
    </Box>
  );
};
