/**
 * MarkdownAnsi —— 对标 claude-code Markdown.tsx 的「marked AST + ANSI 整块输出」渲染器。
 *
 * 取代旧的 MarkdownDisplay（逐行手写正则状态机 + 每行一个 <Box><Text>）：
 * - 块级解析走 cachedLexer（marked GFM AST + token 缓存），不再手写逐行正则（P0-B/P1-D）。
 * - 非表格 token 累积成单个 ANSI 字符串 → 单个 <Ansi>，吃 RawAnsi 快路径，
 *   不再每行一个 Yoga 节点（P2-F）。
 * - 表格 token 分流到 <TableRenderer>（React flex 布局，精细列宽 + 降级），
 *   不再靠「当前行 |...| + 下一行 separator」逐行误判（P1-C）。
 * - 代码块走 colorizeCode（语法高亮 + 行号 + 高度截断），与旧组件一致。
 * - 内联样式由 marked token → renderInline 统一生成，不再手写正则递归（P1-E）。
 * - 块间距用 <Box gap={1}> 统一提供，不再手工塞 spacer Box（P2-J）。
 *
 * 与旧组件行为对齐点：
 * - renderMarkdown=false（原始模式）：整段按 markdown 语言高亮显示，不渲染结构。
 * - isPending + availableTerminalHeight：仅代码块在流式时按高度截断（首屏防闪烁）。
 */

import React, { useMemo } from "react";
import Box from "../../ink/components/Box.js";
import Text from "../../ink/components/Text.js";
import { Ansi as AnsiRaw } from "../../ink/Ansi.js";
import { theme } from "../semantic-colors.ts";
import { colorizeCode } from "./CodeColorizer.tsx";
import { TableRenderer } from "./TableRenderer.tsx";
import { useSettings } from "../contexts/SettingsContext.tsx";
import {
  cachedLexer,
  formatTokenToAnsi,
  isTableToken,
  extractTableData,
} from "../markdown.ts";

// 渲染底座的 Ansi 经 react-compiler 编译后丢失了 props 类型（签名为 (t0)），
// JSX children 无法通过类型检查。这里补一个类型别名，仅约束我们用到的 props。
const Ansi = AnsiRaw as unknown as React.FC<{ children: string; dimColor?: boolean }>;

interface MarkdownAnsiProps {
  text: string;
  /** 是否为流式中内容（影响代码块高度截断） */
  isPending?: boolean;
  /** 可用终端高度（仅代码块流式截断用） */
  availableTerminalHeight?: number;
  /** 渲染宽度 */
  terminalWidth: number;
  /** false 时显示原始 markdown 语法高亮，不渲染结构 */
  renderMarkdown?: boolean;
}

const CODE_BLOCK_PREFIX_PADDING = 1;

const MarkdownAnsiInternal: React.FC<MarkdownAnsiProps> = ({
  text,
  isPending = false,
  availableTerminalHeight,
  terminalWidth,
  renderMarkdown = true,
}) => {
  const settings = useSettings();

  // 原始 markdown 模式：整段按 markdown 语言高亮，不渲染结构（与旧组件一致）。
  const rawBlock = useMemo(() => {
    if (renderMarkdown || !text) return null;
    return colorizeCode({
      code: text,
      language: "markdown",
      maxWidth: terminalWidth - CODE_BLOCK_PREFIX_PADDING,
      hideLineNumbers: true,
    });
  }, [renderMarkdown, text, terminalWidth]);

  // 渲染结构：token 流式分块 —— 表格分流到 <TableRenderer>，
  // 其余 token 累积成 ANSI 串 flush 成单个 <Ansi>，块间用 gap={1} 分隔。
  const blocks = useMemo(() => {
    if (!renderMarkdown || !text) return [];

    const tokens = cachedLexer(text) as any[];
    const out: React.ReactNode[] = [];
    let ansiBuffer = "";

    const flushAnsi = () => {
      if (ansiBuffer.trim()) {
        out.push(
          <Ansi key={`ansi-${out.length}`}>{ansiBuffer.trim()}</Ansi>,
        );
      }
      ansiBuffer = "";
    };

    for (const token of tokens) {
      if (isTableToken(token)) {
        flushAnsi();
        const { headers, rows } = extractTableData(token);
        out.push(
          <TableRenderer
            key={`table-${out.length}`}
            headers={headers}
            rows={rows}
            terminalWidth={terminalWidth}
          />,
        );
      } else if (token.type === "code") {
        // 代码块单独走 colorizeCode：语法高亮 + 行号 + 流式高度截断。
        flushAnsi();
        out.push(
          <RenderCodeBlock
            key={`code-${out.length}`}
            code={token.text ?? ""}
            lang={token.lang || null}
            isPending={isPending}
            availableTerminalHeight={availableTerminalHeight}
            terminalWidth={terminalWidth}
            hideLineNumbers={settings.hideLineNumbers}
          />,
        );
      } else {
        // 非表格/非代码：累积 ANSI（一个 token 一段，块间用 \n 分隔由下个 flush 处理）。
        ansiBuffer += formatTokenToAnsi(token, terminalWidth);
      }
    }
    flushAnsi();
    return out;
  }, [
    renderMarkdown,
    text,
    terminalWidth,
    isPending,
    availableTerminalHeight,
    settings.hideLineNumbers,
  ]);

  if (!text) return null;

  if (!renderMarkdown) {
    return (
      <Box paddingLeft={CODE_BLOCK_PREFIX_PADDING} flexDirection="column">
        {rawBlock}
      </Box>
    );
  }

  if (blocks.length === 0) return null;

  // 块间距统一由 gap={1} 提供（P2-J），不再手工塞 spacer Box。
  return (
    <Box flexDirection="column" gap={1}>
      {blocks}
    </Box>
  );
};

interface RenderCodeBlockProps {
  code: string;
  lang: string | null;
  isPending: boolean;
  availableTerminalHeight?: number;
  terminalWidth: number;
  hideLineNumbers: boolean;
}

const RenderCodeBlockInternal: React.FC<RenderCodeBlockProps> = ({
  code,
  lang,
  isPending,
  availableTerminalHeight,
  terminalWidth,
  hideLineNumbers,
}) => {
  const MIN_LINES_FOR_MESSAGE = 1;
  const RESERVED_LINES = 2;
  const content = code.split("\n");

  // 流式代码块截断：避免在非 alternate buffer 模式下触发闪烁（与旧组件一致）。
  if (isPending && availableTerminalHeight !== undefined) {
    const maxCodeLines = Math.max(0, availableTerminalHeight - RESERVED_LINES);
    if (content.length > maxCodeLines) {
      if (maxCodeLines < MIN_LINES_FOR_MESSAGE) {
        return (
          <Box paddingLeft={CODE_BLOCK_PREFIX_PADDING}>
            <Text color={theme.text.secondary}>... code is being written ...</Text>
          </Box>
        );
      }
      const truncated = content.slice(0, maxCodeLines).join("\n");
      const colorized = colorizeCode({
        code: truncated,
        language: lang,
        availableHeight: availableTerminalHeight,
        maxWidth: terminalWidth - CODE_BLOCK_PREFIX_PADDING,
        hideLineNumbers,
      });
      return (
        <Box paddingLeft={CODE_BLOCK_PREFIX_PADDING} flexDirection="column">
          {colorized}
          <Text color={theme.text.secondary}>... generating more ...</Text>
        </Box>
      );
    }
  }

  const colorized = colorizeCode({
    code: code,
    language: lang,
    availableHeight: availableTerminalHeight,
    maxWidth: terminalWidth - CODE_BLOCK_PREFIX_PADDING,
    hideLineNumbers,
  });

  return (
    <Box
      paddingLeft={CODE_BLOCK_PREFIX_PADDING}
      flexDirection="column"
      width={terminalWidth}
      flexShrink={0}
    >
      {colorized}
    </Box>
  );
};

const RenderCodeBlock = React.memo(RenderCodeBlockInternal);

export const MarkdownAnsi = React.memo(MarkdownAnsiInternal);
