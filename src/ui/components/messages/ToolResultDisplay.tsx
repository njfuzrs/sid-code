/**
 * 工具结果展示组件
 *
 * 根据结果类型分发到不同的渲染方式：
 * - Diff → DiffRenderer
 * - 错误 → 红色文本
 * - ANSI 输出 → AnsiOutputText
 * - JSON → pretty-print
 * - Markdown → MarkdownAnsi
 * - 长文本 → SlicingMaxSizedBox 截断
 * - 短文本 → 直接显示
 *
 * 参考 gemini-cli/packages/cli/src/ui/components/messages/ToolResultDisplay.tsx
 */

import React from 'react';
import { DiffRenderer } from '../DiffRenderer.tsx';
import { MarkdownAnsi } from '../MarkdownAnsi.tsx';
import { AnsiOutputText } from '../AnsiOutput.tsx';
import { SlicingMaxSizedBox } from '../SlicingMaxSizedBox.tsx';
import { useUIState, useExpandedMaxLines } from '../../contexts/UIStateContext.tsx';
import type { AnsiOutput } from '../../types/ansi.ts';

/** 最大结果字符数（超过此值预先截断，避免性能问题） */
const MAXIMUM_RESULT_DISPLAY_CHARACTERS = 20_000;

/**
 * 默认最大显示行数（视觉行）。
 * 对标 claude-code: MAX_LINES_TO_SHOW = 3。
 * 之前是 20，导致工具结果占满屏幕。
 */
const DEFAULT_MAX_LINES = 3;

/** 宽度感知换行留出的安全边距（对标 cc PADDING_TO_PREVENT_OVERFLOW=10） */
const WRAP_WIDTH_PADDING = 8;

/** 尝试解析 JSON 字符串 */
function tryParseJSON(str: string): object | null {
  try {
    const trimmed = str.trim();
    if (
      (trimmed.startsWith('{') && trimmed.endsWith('}')) ||
      (trimmed.startsWith('[') && trimmed.endsWith(']'))
    ) {
      return JSON.parse(trimmed) as object;
    }
  } catch {
    // 不是有效 JSON
  }
  return null;
}

/**
 * 检测字符串是否包含 ANSI 转义序列
 * 简单检测 ESC[ 序列
 */
function containsAnsiEscapes(str: string): boolean {
  // eslint-disable-next-line no-control-regex
  return /\x1b\[/.test(str);
}

/**
 * 将包含 ANSI 转义码的字符串解析为 AnsiOutput 结构
 * 简化版：按行分割，每行作为单个 token
 */
function parseAnsiString(str: string): AnsiOutput {
  const lines = str.split(/\r?\n/);
  return lines.map(line => [{
    text: line,
    bold: false,
    italic: false,
    underline: false,
    dim: false,
    inverse: false,
    fg: '',
    bg: '',
  }]);
}

export interface ToolResultDisplayProps {
  resultDisplay: string | undefined;
  terminalWidth: number;
  renderOutputAsMarkdown?: boolean;
  maxLines?: number;
  overflowDirection?: 'top' | 'bottom';
  /** 是否为 diff 内容 */
  isDiff?: boolean;
  /** 文件名（用于 diff 语法高亮） */
  filename?: string;
  /** 结构化 diff(edit/write):优先于 resultDisplay 文本渲染 */
  structuredPatch?: import("diff").StructuredPatchHunk[];
  /** 是否为错误结果 */
  isError?: boolean;
}

export const ToolResultDisplay: React.FC<ToolResultDisplayProps> = ({
  resultDisplay,
  terminalWidth,
  renderOutputAsMarkdown = false,
  maxLines = DEFAULT_MAX_LINES,
  overflowDirection = 'top',
  isDiff = false,
  filename,
  structuredPatch,
  isError = false,
}) => {
  const { renderMarkdown } = useUIState();
  // TO4：阶梯式展开。expandLevel → maxLines 映射收口到 useExpandedMaxLines hook
  // （与命令输出、错误正文共享同一套 ctrl+o 阶梯展开语义）。
  // base 取调用方传入的 maxLines（折叠档基线），全展开档返回 undefined（不截断）。
  const effectiveMaxLines = useExpandedMaxLines(maxLines);

  const hasPatch = !!structuredPatch?.length;
  // 有结构化 diff 时,即使 resultDisplay 为空(或仅摘要)也要渲染 diff;否则无内容才退出
  if (!resultDisplay && !hasPatch) return null;

  // 结构化 diff 优先:直接喂 DiffRenderer 的 structuredPatch,绕过文本正则解析
  if (isDiff && hasPatch) {
    return (
      <DiffRenderer
        structuredPatch={structuredPatch}
        filename={filename}
        terminalWidth={terminalWidth}
      />
    );
  }

  if (!resultDisplay) return null;

  // 宽度感知换行：对标 claude-code 的 wrapWidth 计算
  // 终端宽度减去边距（树枝缩进 + 容器 padding），最小 20 列
  const maxColumnWidth = Math.max(terminalWidth - WRAP_WIDTH_PADDING, 20);

  // 0. 预先截断超长内容，避免性能问题
  let content = resultDisplay;
  if (content.length > MAXIMUM_RESULT_DISPLAY_CHARACTERS) {
    if (overflowDirection === 'bottom') {
      content = content.slice(0, MAXIMUM_RESULT_DISPLAY_CHARACTERS) + '...';
    } else {
      content = '...' + content.slice(-MAXIMUM_RESULT_DISPLAY_CHARACTERS);
    }
  }

  // 1. Diff 内容 → DiffRenderer
  if (isDiff) {
    return (
      <DiffRenderer
        diffContent={content}
        filename={filename}
        terminalWidth={terminalWidth}
      />
    );
  }

  // 2. 错误结果 → 红色文本 + 截断
  if (isError) {
    return (
      <SlicingMaxSizedBox
        text={content}
        maxLines={effectiveMaxLines}
        overflowDirection="bottom"
        maxColumnWidth={maxColumnWidth}
      />
    );
  }

  // 3. ANSI 输出 → AnsiOutputText
  if (containsAnsiEscapes(content)) {
    const ansiData = parseAnsiString(content);
    return (
      <AnsiOutputText
        data={ansiData}
        width={terminalWidth}
        maxLines={effectiveMaxLines}
      />
    );
  }

  // 4. JSON 字符串 → pretty-print
  const prettyJSON = tryParseJSON(content);
  if (prettyJSON) {
    const formatted = JSON.stringify(prettyJSON, null, 2);
    return (
      <SlicingMaxSizedBox
        text={formatted}
        maxLines={effectiveMaxLines}
        overflowDirection={overflowDirection}
        maxColumnWidth={maxColumnWidth}
      />
    );
  }

  // 5. Markdown 渲染
  if (renderOutputAsMarkdown) {
    // MarkdownAnsi 仅在 isPending 时按 availableTerminalHeight 截断，
    // 工具结果是已完成内容（isPending=false），其自身不做行数折叠。
    // 为避免长 markdown 结果占满屏幕：未全展开且超出 effectiveMaxLines 时，
    // 降级为纯文本走 SlicingMaxSizedBox 截断（保证 ctrl+o 可阶梯展开）；
    // 全展开（effectiveMaxLines===undefined）或内容本身不超限时，完整渲染 markdown。
    const exceedsLimit =
      effectiveMaxLines !== undefined &&
      content.split('\n').length > effectiveMaxLines;
    if (exceedsLimit) {
      return (
        <SlicingMaxSizedBox
          text={content}
          maxLines={effectiveMaxLines}
          overflowDirection={overflowDirection}
          maxColumnWidth={maxColumnWidth}
        />
      );
    }
    return (
      <MarkdownAnsi
        text={content}
        terminalWidth={terminalWidth}
        renderMarkdown={renderMarkdown}
        isPending={false}
      />
    );
  }

  // 6. 普通文本 → SlicingMaxSizedBox 统一截断
  return (
    <SlicingMaxSizedBox
      text={content}
      maxLines={effectiveMaxLines}
      overflowDirection={overflowDirection}
      maxColumnWidth={maxColumnWidth}
    />
  );
};
