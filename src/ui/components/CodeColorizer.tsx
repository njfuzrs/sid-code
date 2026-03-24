/**
 * 代码高亮组件
 *
 * 用 lowlight 生成 HAST 树，转换为 Ink <Text> 组件。
 * 支持：
 * - 语法高亮（指定语言 / 自动检测）
 * - 可配置行号显示
 * - 主题系统对接（通过 Theme.getInkColor()）
 * - MaxSizedBox 高度限制
 *
 * 参考 gemini-cli/packages/cli/src/ui/utils/CodeColorizer.tsx
 */

import React from "react";
import { Text, Box } from "ink";
import { common, createLowlight } from "lowlight";
import type { Root, Element, Text as HastText, RootContent, ElementContent } from "hast";
import { themeManager } from "../themes/theme-manager.ts";
import type { Theme } from "../themes/theme.ts";
import { MaxSizedBox, MINIMUM_MAX_HEIGHT } from "./shared/MaxSizedBox.tsx";

// 顶层同步加载 lowlight（带常用语言）
const lowlight = createLowlight(common);

/**
 * 递归将 HAST 节点转换为 Ink React 元素
 * 通过 Theme.getInkColor() 获取颜色，支持颜色继承链
 */
function renderHastNode(
  node: Root | Element | HastText | RootContent,
  activeTheme: Theme,
  inheritedColor: string | undefined,
): React.ReactNode {
  if (node.type === "text") {
    const color = inheritedColor || activeTheme.defaultColor;
    return <Text color={color}>{(node as HastText).value}</Text>;
  }

  if (node.type === "element") {
    const el = node as Element;
    const classNames = (el.properties?.["className"] as string[]) || [];
    let elementColor: string | undefined;

    // 从后往前查找，优先使用更具体的类名
    for (let i = classNames.length - 1; i >= 0; i--) {
      const color = activeTheme.getInkColor(classNames[i]);
      if (color) {
        elementColor = color;
        break;
      }
    }

    const colorToPass = elementColor || inheritedColor;

    const children = el.children?.map((child: ElementContent, i: number) => (
      <React.Fragment key={i}>
        {renderHastNode(child, activeTheme, colorToPass)}
      </React.Fragment>
    ));

    return <React.Fragment>{children}</React.Fragment>;
  }

  if (node.type === "root") {
    const root = node as Root;
    if (!root.children || root.children.length === 0) return null;
    return root.children?.map((child: RootContent, i: number) => (
      <React.Fragment key={i}>
        {renderHastNode(child, activeTheme, inheritedColor)}
      </React.Fragment>
    ));
  }

  return null;
}

/** 检查语言是否支持 */
export function supportsLanguage(lang: string): boolean {
  try {
    return lowlight.registered(lang);
  } catch {
    return false;
  }
}

/**
 * 高亮单行代码并返回 React 元素
 * 通过 Theme 对象获取颜色映射
 */
function highlightAndRenderLine(
  line: string,
  lang: string | null,
  activeTheme: Theme,
): React.ReactNode {
  try {
    const tree = lang && lowlight.registered(lang)
      ? lowlight.highlight(lang, line)
      : lowlight.highlightAuto(line);

    const rendered = renderHastNode(tree, activeTheme, undefined);
    return rendered !== null ? rendered : line;
  } catch {
    return line;
  }
}

/**
 * 高亮单行代码（导出版本，供 DiffRenderer 使用）
 */
export function colorizeLine(
  line: string,
  language: string | null,
  customTheme?: Theme,
): React.ReactNode {
  const activeTheme = customTheme || themeManager.getActiveTheme();
  return highlightAndRenderLine(line, language, activeTheme);
}

/** 高亮代码并返回 React 元素（整块高亮，保持多行语法上下文） */
export function highlightToReact(code: string, lang?: string): React.ReactNode {
  try {
    const activeTheme = themeManager.getActiveTheme();
    const tree = lang && lowlight.registered(lang)
      ? lowlight.highlight(lang, code)
      : lowlight.highlightAuto(code);

    const rendered = renderHastNode(tree, activeTheme, undefined);
    return rendered !== null ? rendered : <Text>{code}</Text>;
  } catch {
    return <Text>{code}</Text>;
  }
}

/** colorizeCode 选项 */
export interface ColorizeCodeOptions {
  /** 代码文本 */
  code: string;
  /** 语言（null 时自动检测） */
  language?: string | null;
  /** 可用高度（用于 MaxSizedBox 截断） */
  availableHeight?: number;
  /** 最大可用宽度 */
  maxWidth?: number;
  /** 是否显示行号（默认 true） */
  showLineNumbers?: boolean;
  /** 是否隐藏行号（优先于 showLineNumbers） */
  hideLineNumbers?: boolean;
  /** 自定义主题（不传则使用当前活动主题） */
  theme?: Theme | null;
}

/**
 * 渲染语法高亮代码为 React 元素（逐行渲染，支持行号和高度限制）
 *
 * 对齐 gemini-cli colorizeCode()：
 * - 通过 Theme.getInkColor() 获取颜色
 * - MaxSizedBox 高度限制
 * - 超出 availableHeight 时预先裁剪行数避免无用高亮
 */
export function colorizeCode({
  code,
  language = null,
  availableHeight,
  maxWidth,
  showLineNumbers = true,
  hideLineNumbers = false,
  theme: customTheme = null,
}: ColorizeCodeOptions): React.ReactNode {
  const codeToHighlight = code.replace(/\n$/, "");
  const activeTheme = customTheme || themeManager.getActiveTheme();
  const shouldShowLineNumbers = hideLineNumbers ? false : showLineNumbers;

  try {
    let lines = codeToHighlight.split(/\r?\n/);
    const padWidth = String(lines.length).length;
    let hiddenLinesCount = 0;

    // 超出可用高度时预先裁剪，避免高亮不可见的行
    if (availableHeight !== undefined) {
      const effectiveHeight = Math.max(availableHeight, MINIMUM_MAX_HEIGHT);
      if (lines.length > effectiveHeight) {
        const sliceIndex = lines.length - effectiveHeight;
        hiddenLinesCount = sliceIndex;
        lines = lines.slice(sliceIndex);
      }
    }

    const renderedLines = lines.map((line, index) => {
      const contentToRender = highlightAndRenderLine(line, language ?? null, activeTheme);

      return (
        <Box key={index} minHeight={1}>
          {shouldShowLineNumbers && (
            <Box
              minWidth={padWidth + 1}
              flexShrink={0}
              paddingRight={1}
              alignItems="flex-start"
              justifyContent="flex-end"
            >
              <Text color={activeTheme.colors.Gray}>
                {`${index + 1 + hiddenLinesCount}`}
              </Text>
            </Box>
          )}
          <Text color={activeTheme.defaultColor} wrap="wrap">
            {contentToRender}
          </Text>
        </Box>
      );
    });

    if (availableHeight !== undefined) {
      return (
        <MaxSizedBox
          maxHeight={availableHeight}
          maxWidth={maxWidth}
          additionalHiddenLinesCount={hiddenLinesCount}
          overflowDirection="top"
        >
          {renderedLines}
        </MaxSizedBox>
      );
    }

    return (
      <Box flexDirection="column" width={maxWidth}>
        {renderedLines}
      </Box>
    );
  } catch {
    // 回退：纯文本 + 行号
    const lines = codeToHighlight.split(/\r?\n/);
    const padWidth = String(lines.length).length;
    const fallbackLines = lines.map((line, index) => (
      <Box key={index} minHeight={1}>
        {shouldShowLineNumbers && (
          <Box
            minWidth={padWidth + 1}
            flexShrink={0}
            paddingRight={1}
            alignItems="flex-start"
            justifyContent="flex-end"
          >
            <Text color={activeTheme.defaultColor}>{`${index + 1}`}</Text>
          </Box>
        )}
        <Text color={activeTheme.colors.Gray}>{line}</Text>
      </Box>
    ));

    if (availableHeight !== undefined) {
      return (
        <MaxSizedBox
          maxHeight={availableHeight}
          maxWidth={maxWidth}
          overflowDirection="top"
        >
          {fallbackLines}
        </MaxSizedBox>
      );
    }

    return (
      <Box flexDirection="column" width={maxWidth}>
        {fallbackLines}
      </Box>
    );
  }
}

interface CodeBlockProps {
  code: string;
  lang?: string;
  showLineNumbers?: boolean;
}

/** 代码块组件：带缩进、语法高亮和可选行号 */
export const CodeBlock = React.memo(function CodeBlock({
  code,
  lang,
  showLineNumbers = true,
}: CodeBlockProps) {
  return (
    <Box paddingLeft={1} flexDirection="column">
      {colorizeCode({
        code,
        language: lang,
        showLineNumbers,
      })}
    </Box>
  );
});
