/**
 * 工具结果展示组件
 *
 * 根据结果类型分发到不同的渲染方式：
 * - Diff → DiffRenderer（含折叠：新建文件/大改动默认折叠，ctrl+o 阶梯展开）
 * - 错误 → 红色文本
 * - ANSI 输出 → AnsiOutputText
 * - JSON → pretty-print
 * - Markdown → MarkdownAnsi
 * - 长文本 → SlicingMaxSizedBox 截断
 * - 短文本 → 直接显示
 *
 * 参考 gemini-cli/packages/cli/src/ui/components/messages/ToolResultDisplay.tsx
 */

import React from "react";
import { DiffRenderer } from "../DiffRenderer.tsx";
import { MarkdownAnsi } from "../MarkdownAnsi.tsx";
import { AnsiOutputText } from "../AnsiOutput.tsx";
import { SlicingMaxSizedBox } from "../SlicingMaxSizedBox.tsx";
import { useUIState, useExpandedMaxLines } from "../../contexts/UIStateContext.tsx";
import type { AnsiOutput } from "../../types/ansi.ts";

/** 最大结果字符数（超过此值预先截断，避免性能问题） */
const MAXIMUM_RESULT_DISPLAY_CHARACTERS = 20_000;

/**
 * 默认最大显示行数（视觉行）。
 * 对标 claude-code: MAX_LINES_TO_SHOW = 3。
 * 之前是 20，导致工具结果占满屏幕。
 */
const DEFAULT_MAX_LINES = 3;

/**
 * diff 折叠档（level 0）的可视行基线。
 *
 * 比普通文本结果（3 行）宽松：diff / 新建文件预览更需要上下文，3 行几乎不可读；
 * 也避免把常见的小改动（如 5~10 行 edit）折叠成「3 行 + 展开提示」反而更难看。
 * MaxSizedBox 只在内容**超过**此高度时才折叠，因此小 diff 仍完整展示、
 * 只有新建整文件 / 大改动这类真正超长的才折叠——与 claude-code 的观感一致。
 */
const DIFF_COLLAPSE_MAX_LINES = 16;

/** 宽度感知换行留出的安全边距（对标 cc PADDING_TO_PREVENT_OVERFLOW=10） */
const WRAP_WIDTH_PADDING = 8;

/** 尝试解析 JSON 字符串 */
function tryParseJSON(str: string): object | null {
  try {
    const trimmed = str.trim();
    if (
      (trimmed.startsWith("{") && trimmed.endsWith("}")) ||
      (trimmed.startsWith("[") && trimmed.endsWith("]"))
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
  return lines.map((line) => [
    {
      text: line,
      bold: false,
      italic: false,
      underline: false,
      dim: false,
      inverse: false,
      fg: undefined,
      bg: undefined,
    },
  ]);
}

export interface ToolResultDisplayProps {
  resultDisplay: string | undefined;
  terminalWidth: number;
  renderOutputAsMarkdown?: boolean;
  maxLines?: number;
  overflowDirection?: "top" | "bottom";
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
  overflowDirection = "top",
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
  // diff 专用折叠档：基线更宽松（DIFF_COLLAPSE_MAX_LINES），阶梯与普通文本共用同一 expandLevel。
  // 全展开档同样返回 undefined（不折叠）。
  const effectiveDiffMaxLines = useExpandedMaxLines(Math.max(maxLines, DIFF_COLLAPSE_MAX_LINES));

  // 宽度感知换行 / diff 折叠框宽度：终端宽度减去边距（树枝缩进 + 容器 padding），最小 20 列。
  // 提前到分支之前计算，diff 折叠框与文本截断框共用。
  const maxColumnWidth = Math.max(terminalWidth - WRAP_WIDTH_PADDING, 20);

  const hasPatch = !!structuredPatch?.length;
  // 有结构化 diff 时,即使 resultDisplay 为空(或仅摘要)也要渲染 diff;否则无内容才退出
  if (!resultDisplay && !hasPatch) return null;

  // 结构化 diff 优先:直接喂 DiffRenderer 的 structuredPatch,绕过文本正则解析。
  // maxLines 把折叠交给 DiffRenderer 内部**同步**裁剪——这是 Static 安全的关键：
  // 工具结果一完成即被 <Static> 一次性打印进 scrollback，无法再重渲。若改用异步测高的
  // MaxSizedBox（ResizeObserver 首帧 contentHeight=0 → 判定不溢出 → 整份内容先落 scrollback
  // 再折叠），大文件会污染回滚区且擦不掉。DiffRenderer 在渲染前按 maxLines 保留头部（新建
  // 文件看开头最有用）、底部留统一折叠 footer，一次成型。
  if (isDiff && hasPatch) {
    return (
      <DiffRenderer
        structuredPatch={structuredPatch}
        filename={filename}
        terminalWidth={terminalWidth}
        maxLines={effectiveDiffMaxLines}
      />
    );
  }

  if (!resultDisplay) return null;

  // 0. 预先截断超长内容，避免性能问题
  let content = resultDisplay;
  if (content.length > MAXIMUM_RESULT_DISPLAY_CHARACTERS) {
    if (overflowDirection === "bottom") {
      content = content.slice(0, MAXIMUM_RESULT_DISPLAY_CHARACTERS) + "...";
    } else {
      content = "..." + content.slice(-MAXIMUM_RESULT_DISPLAY_CHARACTERS);
    }
  }

  // 1. Diff 内容 → DiffRenderer（同样接折叠，maxLines 走 DiffRenderer 内部同步裁剪）
  if (isDiff) {
    return (
      <DiffRenderer
        diffContent={content}
        filename={filename}
        terminalWidth={terminalWidth}
        maxLines={effectiveDiffMaxLines}
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
    return <AnsiOutputText data={ansiData} width={terminalWidth} maxLines={effectiveMaxLines} />;
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
    // 工具结果是已完成内容，MarkdownAnsi 自身不做行数折叠。
    // 为避免长 markdown 结果占满屏幕：未全展开且超出 effectiveMaxLines 时，
    // 降级为纯文本走 SlicingMaxSizedBox 截断（保证 ctrl+o 可阶梯展开）；
    // 全展开（effectiveMaxLines===undefined）或内容本身不超限时，完整渲染 markdown。
    const exceedsLimit =
      effectiveMaxLines !== undefined && content.split("\n").length > effectiveMaxLines;
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
      <MarkdownAnsi text={content} terminalWidth={terminalWidth} renderMarkdown={renderMarkdown} />
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
