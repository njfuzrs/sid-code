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
 */

import React, { useMemo } from "react";
import Box from "../../ink/components/Box.tsx";
import { Ansi as AnsiRaw } from "../../ink/Ansi.tsx";
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
  /** 渲染宽度 */
  terminalWidth: number;
  /** false 时显示原始 markdown 语法高亮，不渲染结构 */
  renderMarkdown?: boolean;
}

const CODE_BLOCK_PREFIX_PADDING = 1;

const MarkdownAnsiInternal: React.FC<MarkdownAnsiProps> = ({
  text,
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
    // 累积同一 flush 区间内的块，flush 时统一用 "\n\n" 拼接（与 renderTokens
    // 的 blocks.join("\n\n") 语义一致）。此前直接 += 拼接会丢失块间换行，
    // 导致标题/段落/分割线之间的文本连成一片。
    let ansiParts: string[] = [];

    const flushAnsi = () => {
      const joined = ansiParts.join("\n\n").trim();
      if (joined) {
        out.push(
          <Ansi key={`ansi-${out.length}`}>{joined}</Ansi>,
        );
      }
      ansiParts = [];
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
        // 代码块单独走 colorizeCode：语法高亮 + 行号。
        flushAnsi();
        out.push(
          <RenderCodeBlock
            key={`code-${out.length}`}
            code={token.text ?? ""}
            lang={token.lang || null}
            terminalWidth={terminalWidth}
            hideLineNumbers={settings.hideLineNumbers}
          />,
        );
      } else {
        // 非表格/非代码：单独渲染后按块收集，flush 时统一插入块间距。
        const rendered = formatTokenToAnsi(token, terminalWidth);
        if (rendered) ansiParts.push(rendered);
      }
    }
    flushAnsi();
    return out;
  }, [
    renderMarkdown,
    text,
    terminalWidth,
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
  terminalWidth: number;
  hideLineNumbers: boolean;
}

const RenderCodeBlockInternal: React.FC<RenderCodeBlockProps> = ({
  code,
  lang,
  terminalWidth,
  hideLineNumbers,
}) => {
  const colorized = colorizeCode({
    code: code,
    language: lang,
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
