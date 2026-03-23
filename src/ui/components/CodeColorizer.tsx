/**
 * 代码高亮组件
 *
 * 用 lowlight 生成 HAST 树，转换为 Ink <Text> 组件。
 * 支持：
 * - 语法高亮（指定语言 / 自动检测）
 * - 可配置行号显示
 * - 语义颜色 token
 *
 * 参考 gemini-cli/packages/cli/src/ui/utils/CodeColorizer.tsx
 */

import React from "react";
import { Text, Box } from "ink";
import { createLowlight } from "lowlight";
import type { Element, Text as HastText, RootContent, ElementContent } from "hast";
import { theme } from "../semantic-colors.ts";

// 延迟初始化带常用语言的 lowlight 实例
let lowlightInstance: ReturnType<typeof createLowlight> | null = null;
function getLowlight() {
  if (lowlightInstance) return lowlightInstance;
  try {
    // lowlight 3.x: common 是一个 grammars 对象
    const common = require("lowlight/lib/common.js");
    lowlightInstance = createLowlight(common.default || common);
    return lowlightInstance;
  } catch {
    // 回退：创建无语言支持的实例（registered() 始终返回 false）
    lowlightInstance = createLowlight();
    return lowlightInstance;
  }
}

/** HAST class → 终端颜色映射（使用语义颜色 token） */
function getClassToColor(): Record<string, string> {
  return {
    "hljs-keyword": theme.ui.active,
    "hljs-built_in": theme.ui.active,
    "hljs-type": theme.ui.active,
    "hljs-literal": theme.ui.active,
    "hljs-number": theme.status.success,
    "hljs-regexp": theme.status.error,
    "hljs-string": theme.status.success,
    "hljs-subst": theme.text.primary,
    "hljs-symbol": theme.status.success,
    "hljs-class": theme.ui.active,
    "hljs-function": theme.status.warning,
    "hljs-title": theme.status.warning,
    "hljs-params": theme.text.primary,
    "hljs-comment": theme.ui.comment,
    "hljs-doctag": theme.status.success,
    "hljs-meta": theme.ui.comment,
    "hljs-section": theme.status.success,
    "hljs-tag": theme.ui.comment,
    "hljs-name": theme.ui.active,
    "hljs-attr": theme.ui.active,
    "hljs-attribute": theme.ui.active,
    "hljs-variable": theme.status.error,
    "hljs-bullet": theme.status.success,
    "hljs-code": theme.status.success,
    "hljs-emphasis": theme.text.primary,
    "hljs-strong": theme.text.primary,
    "hljs-formula": theme.status.success,
    "hljs-link": theme.text.link,
    "hljs-quote": theme.ui.comment,
    "hljs-selector-tag": theme.ui.active,
    "hljs-selector-id": theme.ui.active,
    "hljs-selector-class": theme.ui.active,
    "hljs-selector-attr": theme.ui.active,
    "hljs-selector-pseudo": theme.ui.active,
    "hljs-template-tag": theme.ui.active,
    "hljs-template-variable": theme.ui.active,
    "hljs-addition": theme.background.diff.added,
    "hljs-deletion": theme.background.diff.removed,
  };
}

/** 从 HAST Element 的 className 获取颜色 */
function getColorFromClasses(classNames: string[]): string | undefined {
  const colorMap = getClassToColor();
  for (const cls of classNames) {
    if (colorMap[cls]) return colorMap[cls];
  }
  return undefined;
}

/** 递归将 HAST 节点转换为 Ink React 元素（传递继承颜色） */
function renderHastNode(
  node: RootContent | ElementContent,
  key: number,
  inheritedColor?: string,
): React.ReactNode {
  if (node.type === "text") {
    // 关键修复：始终用 <Text> 包裹，确保颜色不泄漏到外层
    const color = inheritedColor || theme.text.primary;
    return <Text key={key} color={color}>{(node as HastText).value}</Text>;
  }

  if (node.type === "element") {
    const el = node as Element;
    const classNames = (el.properties?.className as string[]) || [];
    const elementColor = getColorFromClasses(classNames);

    // 继承颜色：当前元素有颜色则用自己的，否则继承父级
    const colorToPass = elementColor || inheritedColor;

    const children = el.children.map((child, i) =>
      renderHastNode(child as RootContent, i, colorToPass),
    );

    // hljs-emphasis → italic, hljs-strong → bold
    const isEmphasis = classNames.includes("hljs-emphasis");
    const isStrong = classNames.includes("hljs-strong");

    if (isEmphasis || isStrong) {
      return (
        <Text key={key} italic={isEmphasis || undefined} bold={isStrong || undefined}>
          {children}
        </Text>
      );
    }

    return <React.Fragment key={key}>{children}</React.Fragment>;
  }

  return null;
}

/** 检查语言是否支持 */
export function supportsLanguage(lang: string): boolean {
  try {
    const ll = getLowlight();
    return ll.registered(lang);
  } catch {
    return false;
  }
}

/**
 * 高亮单行代码并返回 React 元素
 * 支持指定语言和自动检测
 */
function highlightLine(line: string, lang: string | null): React.ReactNode {
  try {
    const ll = getLowlight();
    const tree = lang && ll.registered(lang)
      ? ll.highlight(lang, line)
      : ll.highlightAuto(line);

    const children = tree.children.map((child, i) =>
      renderHastNode(child as RootContent, i, undefined),
    );
    return children.length > 0 ? <>{children}</> : line;
  } catch {
    return line;
  }
}

/** 高亮代码并返回 React 元素（整块高亮，保持多行语法上下文） */
export function highlightToReact(code: string, lang?: string): React.ReactNode {
  try {
    const ll = getLowlight();
    const tree = lang && ll.registered(lang)
      ? ll.highlight(lang, code)
      : ll.highlightAuto(code);

    const children = tree.children.map((child, i) =>
      renderHastNode(child as RootContent, i, undefined),
    );
    return children.length > 0 ? <>{children}</> : <Text>{code}</Text>;
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
  /** 最大可用宽度 */
  maxWidth?: number;
  /** 是否显示行号 */
  showLineNumbers?: boolean;
  /** 是否隐藏行号（优先于 showLineNumbers） */
  hideLineNumbers?: boolean;
}

/**
 * 渲染语法高亮代码为 React 元素（逐行渲染，支持行号）
 *
 * 参考 gemini-cli 的 colorizeCode()：
 * - 逐行高亮（支持指定语言 / 自动检测）
 * - 可配置行号显示
 * - 每行独立 <Box> 避免 Ink 渲染问题
 */
export function colorizeCode({
  code,
  language = null,
  maxWidth,
  showLineNumbers = true,
  hideLineNumbers = false,
}: ColorizeCodeOptions): React.ReactNode {
  const codeToHighlight = code.replace(/\n$/, "");
  const shouldShowLineNumbers = hideLineNumbers ? false : showLineNumbers;

  try {
    const lines = codeToHighlight.split(/\r?\n/);
    const padWidth = String(lines.length).length;

    const renderedLines = lines.map((line, index) => {
      const contentToRender = highlightLine(line, language ?? null);

      return (
        <Box key={index} minHeight={1}>
          {shouldShowLineNumbers && (
            <Box
              minWidth={padWidth + 1}
              flexShrink={0}
              paddingRight={1}
            >
              <Text color={theme.ui.comment}>
                {`${String(index + 1).padStart(padWidth)}`}
              </Text>
            </Box>
          )}
          <Text wrap="wrap">
            {contentToRender}
          </Text>
        </Box>
      );
    });

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
          >
            <Text color={theme.ui.comment}>{`${String(index + 1).padStart(padWidth)}`}</Text>
          </Box>
        )}
        <Text>{line}</Text>
      </Box>
    ));

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
