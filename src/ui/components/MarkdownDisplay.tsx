/**
 * Markdown 显示组件
 *
 * 逐行状态机解析器，支持流式渲染和高度限制。
 * 参考 gemini-cli/packages/cli/src/ui/utils/MarkdownDisplay.tsx
 */

import React from "react";
import Text from "../../ink/components/Text.js";
import Box from "../../ink/components/Box.js";
import { theme } from "../semantic-colors.ts";
import { colorizeCode } from "./CodeColorizer.tsx";
import { TableRenderer } from "./TableRenderer.tsx";
import { RenderInline } from "./InlineMarkdownRenderer.tsx";
import { useSettings } from "../contexts/SettingsContext.tsx";

interface MarkdownDisplayProps {
  text: string;
  isPending: boolean;
  availableTerminalHeight?: number;
  terminalWidth: number;
  renderMarkdown?: boolean;
}

// 常量
const EMPTY_LINE_HEIGHT = 1;
const CODE_BLOCK_PREFIX_PADDING = 1;
const LIST_ITEM_PREFIX_PADDING = 1;
const LIST_ITEM_TEXT_FLEX_GROW = 1;

const MarkdownDisplayInternal: React.FC<MarkdownDisplayProps> = ({
  text,
  isPending,
  availableTerminalHeight,
  terminalWidth,
  renderMarkdown = true,
}) => {
  const settings = useSettings();
  const responseColor = theme.text.response ?? theme.text.primary;

  if (!text) return <></>;

  // 原始 Markdown 模式 - 显示语法高亮的 Markdown 而不渲染
  if (!renderMarkdown) {
    const colorizedMarkdown = colorizeCode({
      code: text,
      language: "markdown",
      maxWidth: terminalWidth - CODE_BLOCK_PREFIX_PADDING,
      hideLineNumbers: true,
    });
    return (
      <Box paddingLeft={CODE_BLOCK_PREFIX_PADDING} flexDirection="column">
        {colorizedMarkdown}
      </Box>
    );
  }

  const lines = text.split(/\r?\n/);
  const headerRegex = /^ *(#{1,4}) +(.*)/;
  const codeFenceRegex = /^ *(`{3,}|~{3,}) *(\w*?) *$/;
  const ulItemRegex = /^([ \t]*)([-*+]) +(.*)/;
  const olItemRegex = /^([ \t]*)(\d+)\. +(.*)/;
  const hrRegex = /^ *([-*_] *){3,} *$/;
  const tableRowRegex = /^\s*\|(.+)\|\s*$/;
  const tableSeparatorRegex = /^\s*\|?\s*(:?-+:?)\s*(\|\s*(:?-+:?)\s*)+\|?\s*$/;

  const contentBlocks: React.ReactNode[] = [];
  let inCodeBlock = false;
  let lastLineEmpty = true;
  let codeBlockContent: string[] = [];
  let codeBlockLang: string | null = null;
  let codeBlockFence = "";
  let inTable = false;
  let tableRows: string[][] = [];
  let tableHeaders: string[] = [];

  function addContentBlock(block: React.ReactNode) {
    if (block) {
      contentBlocks.push(block);
      lastLineEmpty = false;
    }
  }

  lines.forEach((line, index) => {
    const key = `line-${index}`;

    if (inCodeBlock) {
      const fenceMatch = line.match(codeFenceRegex);
      if (
        fenceMatch &&
        fenceMatch[1].startsWith(codeBlockFence[0]) &&
        fenceMatch[1].length >= codeBlockFence.length
      ) {
        addContentBlock(
          <RenderCodeBlock
            key={key}
            content={codeBlockContent}
            lang={codeBlockLang}
            isPending={isPending}
            availableTerminalHeight={availableTerminalHeight}
            terminalWidth={terminalWidth}
          />,
        );
        inCodeBlock = false;
        codeBlockContent = [];
        codeBlockLang = null;
        codeBlockFence = "";
      } else {
        codeBlockContent.push(line);
      }
      return;
    }

    const codeFenceMatch = line.match(codeFenceRegex);
    const headerMatch = line.match(headerRegex);
    const ulMatch = line.match(ulItemRegex);
    const olMatch = line.match(olItemRegex);
    const hrMatch = line.match(hrRegex);
    const tableRowMatch = line.match(tableRowRegex);
    const tableSeparatorMatch = line.match(tableSeparatorRegex);

    if (codeFenceMatch) {
      inCodeBlock = true;
      codeBlockFence = codeFenceMatch[1];
      codeBlockLang = codeFenceMatch[2] || null;
    } else if (tableRowMatch && !inTable) {
      // 潜在的表格开始 - 检查下一行是否为分隔符
      if (
        index + 1 < lines.length &&
        lines[index + 1].match(tableSeparatorRegex)
      ) {
        inTable = true;
        tableHeaders = tableRowMatch[1].split("|").map((cell) => cell.trim());
        tableRows = [];
      } else {
        // 不是表格，作为普通文本处理
        addContentBlock(
          <Box key={key}>
            <Text wrap="wrap" color={responseColor}>
              <RenderInline text={line} defaultColor={responseColor} />
            </Text>
          </Box>,
        );
      }
    } else if (inTable && tableSeparatorMatch) {
      // 跳过分隔符行 - 已处理
    } else if (inTable && tableRowMatch) {
      // 添加表格行
      const cells = tableRowMatch[1].split("|").map((cell) => cell.trim());
      // 确保行的列数与标题相同
      while (cells.length < tableHeaders.length) {
        cells.push("");
      }
      if (cells.length > tableHeaders.length) {
        cells.length = tableHeaders.length;
      }
      tableRows.push(cells);
    } else if (inTable && !tableRowMatch) {
      // 表格结束
      if (tableHeaders.length > 0 && tableRows.length > 0) {
        addContentBlock(
          <TableRenderer
            key={`table-${contentBlocks.length}`}
            headers={tableHeaders}
            rows={tableRows}
            terminalWidth={terminalWidth}
          />,
        );
      }
      inTable = false;
      tableRows = [];
      tableHeaders = [];

      // 将当前行作为普通行处理
      if (line.trim().length > 0) {
        addContentBlock(
          <Box key={key}>
            <Text wrap="wrap" color={responseColor}>
              <RenderInline text={line} defaultColor={responseColor} />
            </Text>
          </Box>,
        );
      }
    } else if (hrMatch) {
      addContentBlock(
        <Box key={key}>
          <Text dimColor>---</Text>
        </Box>,
      );
    } else if (headerMatch) {
      const level = headerMatch[1].length;
      const headerText = headerMatch[2];
      let headerNode: React.ReactNode = null;
      switch (level) {
        case 1:
          headerNode = (
            <Text bold color={theme.text.link}>
              <RenderInline text={headerText} defaultColor={theme.text.link} />
            </Text>
          );
          break;
        case 2:
          headerNode = (
            <Text bold color={theme.text.link}>
              <RenderInline text={headerText} defaultColor={theme.text.link} />
            </Text>
          );
          break;
        case 3:
          headerNode = (
            <Text bold color={responseColor}>
              <RenderInline text={headerText} defaultColor={responseColor} />
            </Text>
          );
          break;
        case 4:
          headerNode = (
            <Text italic color={theme.text.secondary}>
              <RenderInline
                text={headerText}
                defaultColor={theme.text.secondary}
              />
            </Text>
          );
          break;
        default:
          headerNode = (
            <Text color={responseColor}>
              <RenderInline text={headerText} defaultColor={responseColor} />
            </Text>
          );
          break;
      }
      if (headerNode) addContentBlock(<Box key={key}>{headerNode}</Box>);
    } else if (ulMatch) {
      const leadingWhitespace = ulMatch[1];
      const marker = ulMatch[2];
      const itemText = ulMatch[3];
      addContentBlock(
        <RenderListItem
          key={key}
          itemText={itemText}
          type="ul"
          marker={marker}
          leadingWhitespace={leadingWhitespace}
        />,
      );
    } else if (olMatch) {
      const leadingWhitespace = olMatch[1];
      const marker = olMatch[2];
      const itemText = olMatch[3];
      addContentBlock(
        <RenderListItem
          key={key}
          itemText={itemText}
          type="ol"
          marker={marker}
          leadingWhitespace={leadingWhitespace}
        />,
      );
    } else {
      if (line.trim().length === 0 && !inCodeBlock) {
        if (!lastLineEmpty) {
          contentBlocks.push(
            <Box key={`spacer-${index}`} height={EMPTY_LINE_HEIGHT} />,
          );
          lastLineEmpty = true;
        }
      } else {
        addContentBlock(
          <Box key={key}>
            <Text wrap="wrap" color={responseColor}>
              <RenderInline text={line} defaultColor={responseColor} />
            </Text>
          </Box>,
        );
      }
    }
  });

  if (inCodeBlock) {
    addContentBlock(
      <RenderCodeBlock
        key="line-eof"
        content={codeBlockContent}
        lang={codeBlockLang}
        isPending={isPending}
        availableTerminalHeight={availableTerminalHeight}
        terminalWidth={terminalWidth}
      />,
    );
  }

  // 处理末尾的表格
  if (inTable && tableHeaders.length > 0 && tableRows.length > 0) {
    addContentBlock(
      <TableRenderer
        key={`table-${contentBlocks.length}`}
        headers={tableHeaders}
        rows={tableRows}
        terminalWidth={terminalWidth}
      />,
    );
  }

  return <>{contentBlocks}</>;
};

// 辅助组件

interface RenderCodeBlockProps {
  content: string[];
  lang: string | null;
  isPending: boolean;
  availableTerminalHeight?: number;
  terminalWidth: number;
}

const RenderCodeBlockInternal: React.FC<RenderCodeBlockProps> = ({
  content,
  lang,
  isPending,
  availableTerminalHeight,
  terminalWidth,
}) => {
  const settings = useSettings();
  const MIN_LINES_FOR_MESSAGE = 1;
  const RESERVED_LINES = 2;

  // 流式代码块截断：避免在非 alternate buffer 模式下触发闪烁
  if (isPending && availableTerminalHeight !== undefined) {
    const MAX_CODE_LINES_WHEN_PENDING = Math.max(
      0,
      availableTerminalHeight - RESERVED_LINES,
    );

    if (content.length > MAX_CODE_LINES_WHEN_PENDING) {
      if (MAX_CODE_LINES_WHEN_PENDING < MIN_LINES_FOR_MESSAGE) {
        return (
          <Box paddingLeft={CODE_BLOCK_PREFIX_PADDING}>
            <Text color={theme.text.secondary}>
              ... code is being written ...
            </Text>
          </Box>
        );
      }
      const truncatedContent = content.slice(0, MAX_CODE_LINES_WHEN_PENDING);
      const colorizedTruncatedCode = colorizeCode({
        code: truncatedContent.join("\n"),
        language: lang,
        availableHeight: availableTerminalHeight,
        maxWidth: terminalWidth - CODE_BLOCK_PREFIX_PADDING,
        hideLineNumbers: settings.hideLineNumbers,
      });
      return (
        <Box paddingLeft={CODE_BLOCK_PREFIX_PADDING} flexDirection="column">
          {colorizedTruncatedCode}
          <Text color={theme.text.secondary}>... generating more ...</Text>
        </Box>
      );
    }
  }

  const fullContent = content.join("\n");
  const colorizedCode = colorizeCode({
    code: fullContent,
    language: lang,
    availableHeight: availableTerminalHeight,
    maxWidth: terminalWidth - CODE_BLOCK_PREFIX_PADDING,
    hideLineNumbers: settings.hideLineNumbers,
  });

  return (
    <Box
      paddingLeft={CODE_BLOCK_PREFIX_PADDING}
      flexDirection="column"
      width={terminalWidth}
      flexShrink={0}
    >
      {colorizedCode}
    </Box>
  );
};

const RenderCodeBlock = React.memo(RenderCodeBlockInternal);

interface RenderListItemProps {
  itemText: string;
  type: "ul" | "ol";
  marker: string;
  leadingWhitespace?: string;
}

const RenderListItemInternal: React.FC<RenderListItemProps> = ({
  itemText,
  type,
  marker,
  leadingWhitespace = "",
}) => {
  const prefix = type === "ol" ? `${marker}. ` : `${marker} `;
  const prefixWidth = prefix.length;
  // 考虑前导空白（缩进级别）加上标准前缀填充
  const indentation = leadingWhitespace.length;
  const listResponseColor = theme.text.response ?? theme.text.primary;

  return (
    <Box
      paddingLeft={indentation + LIST_ITEM_PREFIX_PADDING}
      flexDirection="row"
    >
      <Box width={prefixWidth} flexShrink={0}>
        <Text color={listResponseColor}>{prefix}</Text>
      </Box>
      <Box flexGrow={LIST_ITEM_TEXT_FLEX_GROW}>
        <Text wrap="wrap" color={listResponseColor}>
          <RenderInline text={itemText} defaultColor={listResponseColor} />
        </Text>
      </Box>
    </Box>
  );
};

const RenderListItem = React.memo(RenderListItemInternal);

export const MarkdownDisplay = React.memo(MarkdownDisplayInternal);
