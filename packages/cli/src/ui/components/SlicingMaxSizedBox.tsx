/**
 * 内容截断组件
 *
 * 当子内容超过 maxChars 或 maxLines 时，截断并显示隐藏行数提示。
 *
 * 对标 claude-code 的 renderTruncatedContent（utils/terminal.ts）：
 * - maxColumnWidth 开启宽度感知换行：长行先按终端列宽折叠，再按 maxLines 截断。
 *   这样“3 行”是 3 个视觉行，而非 3 个原始行（其中一条可能 500 字符占满屏幕）。
 * - 当仅剩 1 行未显示时，直接展示该行（不显示 “… +1 行” 占位）。
 */

import React from "react";
import stringWidth from "string-width";
import { Box } from "../render-port/components.ts";
import { Text } from "../render-port/components.ts";
import { theme } from "../semantic-colors.ts";
import type { Color } from "../render-port/types.ts";
import { formatCollapsedSummary } from "../constants/collapse.ts";

interface SlicingMaxSizedBoxProps {
  /** 最大字符数 */
  maxChars?: number;
  /** 最大行数（视觉行数，启用 maxColumnWidth 后以折叠后的行为准） */
  maxLines?: number;
  /** 截断方向：top 保留底部，bottom 保留顶部 */
  overflowDirection?: "top" | "bottom";
  /** 文本内容 */
  text: string;
  /**
   * 终端列宽上限（视觉列，非码点）。
   * 提供后启用宽度感知换行：长行会按此宽度折叠为多个视觉行，再按 maxLines 截断。
   * 对标 claude-code: MAX_LINES_TO_SHOW=3 + wrapWidth 感知。
   */
  maxColumnWidth?: number;
  /** 正文颜色（走 theme.* 语义 token，不传则用终端默认色）。 */
  color?: Color;
  // 原有的 `dimColor?: boolean` 已删除：它既不是 ink Text 的 prop（fork 里叫 `dim`，
  // 且与 `bold` 互斥），也没有任何调用方传过它 —— 四个调用点（ToolMessage /
  // ToolResultDisplay / ErrorMessage / CommandMessage / TaskNotificationMessage）
  // 只传 color。次要文本的暗淡应走 theme.text.secondary 灰色 token，见 src/ui/CLAUDE.md L1.3。
}

/** 统计字符串中的换行数（不需要 split 创建数组） */
function countNewlines(text: string): number {
  let count = 0;
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) === 10) count++;
  }
  return count;
}

/**
 * 宽度感知换行：把每行按 maxColumnWidth 折叠为多个视觉行。
 * 对标 claude-code utils/terminal.ts 的 wrapText。
 * 仅在提供 maxColumnWidth 时调用。
 *
 * ⚠️ 切段必须按**视觉列宽**累加，不能拿 `maxColumnWidth` 直接当码点索引去 `slice`。
 * 曾经的写法是 `trimmed.slice(pos, pos + maxColumnWidth)` 且 `pos += maxColumnWidth`，
 * 而循环条件用的是 `stringWidth(trimmed)` —— 两个量纲不一致：含 CJK 的行视觉宽度约是
 * 码点数的 2 倍，于是「88 列」切出来的一段实际宽 126 列（实测），仍大幅超宽。
 * 超宽行再交给渲染器处理时，**中间那段文本会被吃掉**：`enter_worktree` 的
 * 「此后写文件请用 <worktree 路径>」整句消失，屏幕上只剩 `…worktree；此` 然后直接接
 * `/repo/...` —— 与「折叠掉提示」是同一后果（提示看不到），只是发生在更下一层。
 *
 * 用 `Array.from` 而非 `split("")`：让 emoji / 代理对不被拆成两半（`⚠️` 是 2 个码点），
 * 单字符宽度超过上限时也要照样输出，否则窄终端下会死循环。
 */
function wrapLinesToWidth(text: string, maxColumnWidth: number): string[] {
  const rawLines = text.split("\n");
  const wrappedLines: string[] = [];

  for (const raw of rawLines) {
    const trimmed = raw.trimEnd();
    if (stringWidth(trimmed) <= maxColumnWidth) {
      wrappedLines.push(trimmed);
      continue;
    }
    let current = "";
    let currentWidth = 0;
    for (const ch of Array.from(trimmed)) {
      const chWidth = stringWidth(ch);
      // `current !== ""` 保证「单字符本身比上限还宽」时也能输出，不会无限循环。
      if (currentWidth + chWidth > maxColumnWidth && current !== "") {
        wrappedLines.push(current);
        current = ch;
        currentWidth = chWidth;
      } else {
        current += ch;
        currentWidth += chWidth;
      }
    }
    if (current !== "") wrappedLines.push(current);
  }

  return wrappedLines;
}

export const SlicingMaxSizedBox = React.memo(function SlicingMaxSizedBox({
  maxChars = 20000,
  maxLines,
  overflowDirection = "top",
  text,
  maxColumnWidth,
  color,
}: SlicingMaxSizedBoxProps) {
  let displayText = text;
  let hiddenCount = 0;
  let truncated = false;

  // 字符级截断（快速路径：ASCII 文本 text.length === 码点数，可跳过 Array.from）
  if (text.length > maxChars) {
    // 可能需要码点安全切割（只在超限时才创建 code points 数组）
    const codePoints = Array.from(text);
    const codePointLength = codePoints.length;
    if (codePointLength > maxChars) {
      truncated = true;
      if (overflowDirection === "top") {
        displayText = codePoints.slice(codePointLength - maxChars).join("");
      } else {
        displayText = codePoints.slice(0, maxChars).join("");
      }
    }
  }

  // 宽度感知换行（对标 claude-code）：先折叠长行，再按视觉行截断
  if (maxColumnWidth && maxColumnWidth > 0) {
    const wrappedLines = wrapLinesToWidth(displayText, maxColumnWidth);

    if (maxLines && wrappedLines.length > maxLines) {
      // 对标 cc: 若仅剩 1 行则直接展示，不占位
      const remaining = wrappedLines.length - maxLines;
      if (remaining === 1) {
        // 展示 maxLines + 1 行，hiddenCount = 0
        displayText = wrappedLines.slice(0, maxLines + 1).join("\n");
        truncated = false;
        hiddenCount = 0;
      } else {
        truncated = true;
        hiddenCount = remaining;
        if (overflowDirection === "top") {
          displayText = wrappedLines.slice(-maxLines).join("\n");
        } else {
          displayText = wrappedLines.slice(0, maxLines).join("\n");
        }
      }
    } else {
      displayText = wrappedLines.join("\n");
    }
  } else {
    // 无宽度感知：传统按 \n 行数截断
    const originalLineCount = countNewlines(displayText) + 1;
    let lines = displayText.split("\n");
    if (maxLines && lines.length > maxLines) {
      truncated = true;
      hiddenCount = lines.length - maxLines;
      if (overflowDirection === "top") {
        lines = lines.slice(-maxLines);
      } else {
        lines = lines.slice(0, maxLines);
      }
    } else if (truncated) {
      // 字符截断但没有行截断时，用原始行数估算
      hiddenCount = Math.max(0, originalLineCount - lines.length);
    }
    displayText = lines.join("\n");
  }

  if (!truncated) {
    hiddenCount = 0;
  }

  const lines = displayText.split("\n");
  const indicator =
    hiddenCount > 0 ? (
      <Text color={theme.status.warning}>
        {formatCollapsedSummary(hiddenCount, { hint: "ctrl+o" })}
      </Text>
    ) : null;

  return (
    <Box flexDirection="column">
      {truncated && overflowDirection === "top" && indicator}
      {lines.map((line, idx) => (
        <Text key={idx} color={color}>
          {line}
        </Text>
      ))}
      {truncated && overflowDirection === "bottom" && indicator}
    </Box>
  );
});
