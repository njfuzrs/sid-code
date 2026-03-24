/**
 * 输入语法高亮
 *
 * 参考 gemini-cli parseInputForHighlighting()
 * 高亮 /命令、@文件路径、!shell 前缀
 */

import React from "react";
import { Text } from "ink";
import { theme } from "../semantic-colors.ts";

/** 高亮片段类型 */
interface HighlightSegment {
  text: string;
  type: "normal" | "slash" | "at" | "shell" | "path";
}

/**
 * 解析输入文本，返回高亮片段列表
 */
export function parseInputForHighlighting(text: string): HighlightSegment[] {
  if (!text) return [];

  const segments: HighlightSegment[] = [];

  // /命令 高亮
  if (text.startsWith("/")) {
    const spaceIdx = text.indexOf(" ");
    if (spaceIdx === -1) {
      segments.push({ text, type: "slash" });
      return segments;
    }
    segments.push({ text: text.slice(0, spaceIdx), type: "slash" });
    // 剩余部分继续解析
    parseRemainingText(text.slice(spaceIdx), segments);
    return segments;
  }

  // !shell 高亮
  if (text.startsWith("!")) {
    segments.push({ text: "!", type: "shell" });
    if (text.length > 1) {
      segments.push({ text: text.slice(1), type: "normal" });
    }
    return segments;
  }

  // 普通文本：解析 @ 引用
  parseRemainingText(text, segments);
  return segments;
}

/** 解析剩余文本中的 @ 引用 */
function parseRemainingText(text: string, segments: HighlightSegment[]): void {
  let i = 0;
  let normalStart = 0;

  while (i < text.length) {
    if (text[i] === "@" && (i === 0 || text[i - 1] === " ")) {
      // 收集 @ 前的普通文本
      if (i > normalStart) {
        segments.push({ text: text.slice(normalStart, i), type: "normal" });
      }

      // 找到 @ 引用的结束位置（空格或行尾）
      let end = i + 1;
      while (end < text.length && text[end] !== " ") end++;

      segments.push({ text: text.slice(i, end), type: "at" });
      normalStart = end;
      i = end;
    } else {
      i++;
    }
  }

  // 剩余普通文本
  if (normalStart < text.length) {
    segments.push({ text: text.slice(normalStart), type: "normal" });
  }
}

/** 渲染高亮片段 */
export function renderHighlightedSegments(segments: HighlightSegment[]): React.ReactNode[] {
  return segments.map((seg, i) => {
    switch (seg.type) {
      case "slash":
        return <Text key={i} color={theme.text.accent} bold>{seg.text}</Text>;
      case "at":
        return <Text key={i} color={theme.text.link}>{seg.text}</Text>;
      case "shell":
        return <Text key={i} color={theme.status.warning} bold>{seg.text}</Text>;
      case "path":
        return <Text key={i} color={theme.text.link} underline>{seg.text}</Text>;
      default:
        return <Text key={i}>{seg.text}</Text>;
    }
  });
}
