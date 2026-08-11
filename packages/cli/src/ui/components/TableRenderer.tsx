/**
 * 表格渲染器（完全参考 gemini-cli 实现）
 * 使用 Ink 内置的 StyledChar API 处理 ANSI 字符串，确保宽度计算准确
 */

import React, { useMemo } from "react";
import Text from "../../ink/components/Text.tsx";
import Box from "../../ink/components/Box.tsx";
import type { StyledChar } from "../../ink/_vendor/styled-chars.ts";
import { toStyledCharacters, styledCharsWidth, wrapStyledChars, widestLineFromStyledChars, wordBreakStyledChars } from "../../ink/_vendor/styled-chars.ts";
import { styledCharsToString } from "@alcalzone/ansi-tokenize";
import { theme } from "../semantic-colors.ts";
import { renderInlineMarkdown } from "../markdown.ts";

interface TableRendererProps {
  headers: string[];
  rows: string[][];
  terminalWidth: number;
}

const MIN_COLUMN_WIDTH = 5;
const COLUMN_PADDING = 2;
const TABLE_MARGIN = 2;

/**
 * 将 markdown 文本转换为 StyledChar 数组
 * 走 marked 内联 lexer（renderInlineMarkdown）生成 ANSI，再用 Ink 的
 * toStyledCharacters 解析（P1-E：不再依赖手写正则 parseMarkdownToANSI）。
 */
const parseMarkdownToStyledChars = (
  text: string,
  defaultColor?: string,
): StyledChar[] => {
  const ansi = renderInlineMarkdown(text, defaultColor);
  return toStyledCharacters(ansi);
};

/**
 * 计算 StyledChar 数组的宽度信息
 */
const calculateWidths = (styledChars: StyledChar[]) => {
  const contentWidth = styledCharsWidth(styledChars);
  const words: StyledChar[][] = wordBreakStyledChars(styledChars);
  const maxWordWidth = widestLineFromStyledChars(words);
  return { contentWidth, maxWordWidth };
};

/** 预处理后的行数据（缓存文本和宽度） */
interface ProcessedLine {
  text: string;
  width: number;
}

export const TableRenderer: React.FC<TableRendererProps> = ({
  headers,
  rows,
  terminalWidth,
}) => {
  // 1. 将所有单元格转换为 StyledChar 数组
  const styledHeaders = useMemo(
    () => headers.map((header) => parseMarkdownToStyledChars(header, theme.text.link)),
    [headers],
  );

  const styledRows = useMemo(
    () => rows.map((row) => row.map((cell) => parseMarkdownToStyledChars(cell, theme.text.primary))),
    [rows],
  );

  // 2. 计算列宽并换行
  const { wrappedHeaders, wrappedRows, adjustedWidths } = useMemo(() => {
    const numColumns = Math.max(
      styledHeaders.length,
      ...styledRows.map((row) => row.length),
    );

    // 计算每列的最小/最大宽度约束
    const constraints = Array.from({ length: numColumns }).map((_, colIndex) => {
      const headerStyledChars = styledHeaders[colIndex] || [];
      let { contentWidth: maxContentWidth, maxWordWidth } = calculateWidths(headerStyledChars);

      styledRows.forEach((row) => {
        const cellStyledChars = row[colIndex] || [];
        const { contentWidth: cellWidth, maxWordWidth: cellWordWidth } = calculateWidths(cellStyledChars);
        maxContentWidth = Math.max(maxContentWidth, cellWidth);
        maxWordWidth = Math.max(maxWordWidth, cellWordWidth);
      });

      const minWidth = maxWordWidth;
      const maxWidth = Math.max(minWidth, maxContentWidth);
      return { minWidth, maxWidth };
    });

    // 计算可用空间：终端宽度 - 边框 - padding
    const fixedOverhead = numColumns + 1 + numColumns * COLUMN_PADDING;
    const availableWidth = Math.max(0, terminalWidth - fixedOverhead - TABLE_MARGIN);

    // 分配列宽
    const totalMinWidth = constraints.reduce((sum, c) => sum + c.minWidth, 0);
    let finalContentWidths: number[];

    if (totalMinWidth > availableWidth) {
      // 空间不足，按比例压缩（保护短列）
      const shortColumns = constraints.filter((c) => c.maxWidth <= MIN_COLUMN_WIDTH);
      const totalShortColumnWidth = shortColumns.reduce((sum, c) => sum + c.minWidth, 0);
      const finalTotalShortColumnWidth = totalShortColumnWidth >= availableWidth ? 0 : totalShortColumnWidth;
      const scale = (availableWidth - finalTotalShortColumnWidth) / (totalMinWidth - finalTotalShortColumnWidth) || 0;

      finalContentWidths = constraints.map((c) => {
        if (c.maxWidth <= MIN_COLUMN_WIDTH && finalTotalShortColumnWidth > 0) {
          return c.minWidth;
        }
        return Math.floor(c.minWidth * scale);
      });
    } else {
      // 空间充足，按比例分配剩余空间
      const surplus = availableWidth - totalMinWidth;
      const totalGrowthNeed = constraints.reduce((sum, c) => sum + (c.maxWidth - c.minWidth), 0);

      if (totalGrowthNeed === 0) {
        finalContentWidths = constraints.map((c) => c.minWidth);
      } else {
        finalContentWidths = constraints.map((c) => {
          const growthNeed = c.maxWidth - c.minWidth;
          const share = growthNeed / totalGrowthNeed;
          const extra = Math.floor(surplus * share);
          return Math.min(c.maxWidth, c.minWidth + extra);
        });
      }
    }

    // 换行并计算实际宽度
    const actualColumnWidths = new Array(numColumns).fill(0);

    const wrapAndProcessRow = (row: StyledChar[][]) => {
      const rowResult: ProcessedLine[][] = [];
      for (let colIndex = 0; colIndex < numColumns; colIndex++) {
        const cellStyledChars = row[colIndex] || [];
        const allocatedWidth = finalContentWidths[colIndex];
        const contentWidth = Math.max(1, allocatedWidth);

        const wrappedStyledLines = wrapStyledChars(cellStyledChars, contentWidth);
        const maxLineWidth = widestLineFromStyledChars(wrappedStyledLines);
        actualColumnWidths[colIndex] = Math.max(actualColumnWidths[colIndex], maxLineWidth);

        const lines = wrappedStyledLines.map((line) => ({
          text: styledCharsToString(line),
          width: styledCharsWidth(line),
        }));
        rowResult.push(lines);
      }
      return rowResult;
    };

    const wrappedHeaders = wrapAndProcessRow(styledHeaders);
    const wrappedRows = styledRows.map((row) => wrapAndProcessRow(row));

    // 最终宽度 = 实际内容宽度 + padding
    const adjustedWidths = actualColumnWidths.map((w) => w + COLUMN_PADDING);

    // 参考 gemini-cli：不做超宽降级，始终保持表格格式
    // 超宽时通过列宽压缩 + 自动换行处理，保证流式渲染中格式不突变
    return { wrappedHeaders, wrappedRows, adjustedWidths };
  }, [styledHeaders, styledRows, terminalWidth]);

  // 3. 渲染辅助函数

  /** 渲染单元格 */
  const renderCell = (
    content: ProcessedLine,
    width: number,
    isHeader = false,
  ): React.ReactNode => {
    const contentWidth = Math.max(0, width - COLUMN_PADDING);
    const displayWidth = content.width;
    const paddingNeeded = Math.max(0, contentWidth - displayWidth);

    // 注意：content.text 已经包含 ANSI 颜色码（由 renderInlineMarkdown 生成）
    // 不要在外层 <Text> 设置 color 属性，否则会覆盖内部颜色
    return (
      <Text>
        {isHeader ? (
          <Text bold>{content.text}</Text>
        ) : (
          <Text>{content.text}</Text>
        )}
        {" ".repeat(paddingNeeded)}
      </Text>
    );
  };

  /** 渲染边框 */
  const renderBorder = (type: "top" | "middle" | "bottom"): React.ReactNode => {
    const chars = {
      top: { left: "┌", middle: "┬", right: "┐", horizontal: "─" },
      middle: { left: "├", middle: "┼", right: "┤", horizontal: "─" },
      bottom: { left: "└", middle: "┴", right: "┘", horizontal: "─" },
    };

    const char = chars[type];
    const borderParts = adjustedWidths.map((w) => char.horizontal.repeat(w));
    const border = char.left + borderParts.join(char.middle) + char.right;

    return <Text color={theme.border.default}>{border}</Text>;
  };

  /** 渲染单行（可能包含多个换行后的子行） */
  const renderVisualRow = (
    cells: ProcessedLine[],
    isHeader = false,
  ): React.ReactNode => {
    const renderedCells = cells.map((cell, index) => {
      const width = adjustedWidths[index] || 0;
      return renderCell(cell, width, isHeader);
    });

    return (
      <Box flexDirection="row">
        <Text color={theme.border.default}>│</Text>
        {renderedCells.map((cell, index) => (
          <React.Fragment key={index}>
            <Box paddingX={1}>{cell}</Box>
            {index < renderedCells.length - 1 && (
              <Text color={theme.border.default}>│</Text>
            )}
          </React.Fragment>
        ))}
        <Text color={theme.border.default}>│</Text>
      </Box>
    );
  };

  /** 渲染数据行（处理多行单元格） */
  const renderDataRow = (
    wrappedCells: ProcessedLine[][],
    rowIndex: number,
    isHeader = false,
  ): React.ReactNode => {
    const key = rowIndex === -1 ? "header" : `${rowIndex}`;
    const maxHeight = Math.max(...wrappedCells.map((lines) => lines.length), 1);

    const visualRows: React.ReactNode[] = [];
    for (let i = 0; i < maxHeight; i++) {
      const visualRowCells = wrappedCells.map(
        (lines) => lines[i] || { text: "", width: 0 },
      );
      visualRows.push(
        <React.Fragment key={`${key}-${i}`}>
          {renderVisualRow(visualRowCells, isHeader)}
        </React.Fragment>,
      );
    }

    return <React.Fragment key={rowIndex}>{visualRows}</React.Fragment>;
  };

  // 4. 渲染完整表格
  return (
    <Box flexDirection="column" marginY={1}>
      {/* 顶部边框 */}
      {renderBorder("top")}

      {/* 表头 */}
      {renderDataRow(wrappedHeaders, -1, true)}

      {/* 表头分隔线 */}
      {renderBorder("middle")}

      {/* 数据行（行间有分隔线） */}
      {wrappedRows.map((row, index) => (
        <React.Fragment key={`row-${index}`}>
          {renderDataRow(row, index)}
          {index < wrappedRows.length - 1 && renderBorder("middle")}
        </React.Fragment>
      ))}

      {/* 底部边框 */}
      {renderBorder("bottom")}
    </Box>
  );
};
