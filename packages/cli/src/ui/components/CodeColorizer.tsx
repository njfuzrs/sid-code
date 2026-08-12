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
import Text from "@sid-code/tui-renderer/components/Text.tsx";
import Box from "@sid-code/tui-renderer/components/Box.tsx";
import { common, createLowlight } from "lowlight";
import type { Root, Element, Text as HastText, RootContent, ElementContent } from "hast";
import { themeManager } from "../themes/theme-manager.ts";
import type { Theme } from "../themes/theme.ts";
import type { Color } from "@sid-code/tui-renderer/styles.ts";

// 顶层同步加载 lowlight（带常用语言）
const lowlight = createLowlight(common);

// ── MD2 / ST3：单行高亮缓存 ──────────────────────────────────────
// 同一行代码在「流式逐 token 重渲染」和「Ctrl+O 折叠/展开重渲染」中会被反复高亮，
// 但 (主题, 语言, 行文本) 三元组确定时高亮结果不变。用 LRU 缓存命中已高亮行，
// 把每 token O(行数 × lowlight) 的重复开销摊销为「仅新增/变化行才真正高亮」。
// React 元素是不可变的，跨渲染复用安全。
const LINE_HIGHLIGHT_CACHE_MAX = 2000;
const lineHighlightCache = new Map<string, React.ReactNode>();

function getCachedHighlight(
  line: string,
  lang: string | null,
  activeTheme: Theme,
  compute: () => React.ReactNode,
): React.ReactNode {
  // 主题名 + 语言 + 行文本 唯一确定高亮结果。
  // 分隔符用转义写法 `\x1f`（US，单元分隔符）而非裸控制字节——源码里的裸 NUL 会让 grep
  // 把整个文件当二进制静默跳过（全文件符号都搜不到），运行时行为等价。
  // 同处理见 src/query/repeated-readonly-guard.ts makeSignature。
  const key = `${activeTheme.name}\x1f${lang ?? "auto"}\x1f${line}`;
  const hit = lineHighlightCache.get(key);
  if (hit !== undefined) {
    // LRU：命中后移到末尾（最近使用）。
    lineHighlightCache.delete(key);
    lineHighlightCache.set(key, hit);
    return hit;
  }
  const result = compute();
  if (lineHighlightCache.size >= LINE_HIGHLIGHT_CACHE_MAX) {
    const oldest = lineHighlightCache.keys().next().value;
    if (oldest !== undefined) lineHighlightCache.delete(oldest);
  }
  lineHighlightCache.set(key, result);
  return result;
}

/** 测试/主题切换用：清空单行高亮缓存。 */
export function clearLineHighlightCache(): void {
  lineHighlightCache.clear();
}

/**
 * 递归将 HAST 节点转换为 Ink React 元素
 * 通过 Theme.getInkColor() 获取颜色，支持颜色继承链
 */
function renderHastNode(
  node: Root | Element | HastText | RootContent,
  activeTheme: Theme,
  inheritedColor: Color | undefined,
): React.ReactNode {
  if (node.type === "text") {
    const color = inheritedColor || activeTheme.defaultColor;
    return <Text color={color}>{(node as HastText).value}</Text>;
  }

  if (node.type === "element") {
    const el = node as Element;
    const classNames = (el.properties?.["className"] as string[]) || [];
    let elementColor: Color | undefined;

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
      <React.Fragment key={i}>{renderHastNode(child, activeTheme, colorToPass)}</React.Fragment>
    ));

    return <React.Fragment>{children}</React.Fragment>;
  }

  if (node.type === "root") {
    const root = node as Root;
    if (!root.children || root.children.length === 0) return null;
    return root.children?.map((child: RootContent, i: number) => (
      <React.Fragment key={i}>{renderHastNode(child, activeTheme, inheritedColor)}</React.Fragment>
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
  return getCachedHighlight(line, lang, activeTheme, () => {
    try {
      const tree =
        lang && lowlight.registered(lang)
          ? lowlight.highlight(lang, line)
          : lowlight.highlightAuto(line);

      const rendered = renderHastNode(tree, activeTheme, undefined);
      return rendered !== null ? rendered : line;
    } catch {
      return line;
    }
  });
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
    const tree =
      lang && lowlight.registered(lang)
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
 * 渲染语法高亮代码为 React 元素（逐行渲染，支持行号）
 *
 * 对齐 gemini-cli colorizeCode()：通过 Theme.getInkColor() 获取颜色、逐行高亮。
 *
 * 注：不做高度折叠。折叠必须由**调用方**用同步路径（SlicingMaxSizedBox /
 * DiffRenderer 的 maxLines）在渲染前裁好——工具结果一完成即进 <Static> 打印到 scrollback、
 * 此后无法重渲，靠异步测高的 MaxSizedBox 折叠会先把整份内容落 scrollback 再折叠、污染回滚区
 * 且擦不掉（详见 src/ui/CLAUDE.md L3.3 Static 安全铁律）。此处曾有一段基于 MaxSizedBox 的
 * availableHeight 折叠分支，全仓无人传参=死代码且是重蹈覆辙的陷阱，已删。
 */
export function colorizeCode({
  code,
  language = null,
  maxWidth,
  showLineNumbers = true,
  hideLineNumbers = false,
  theme: customTheme = null,
}: ColorizeCodeOptions): React.ReactNode {
  const codeToHighlight = code.replace(/\n$/, "");
  const activeTheme = customTheme || themeManager.getActiveTheme();
  const shouldShowLineNumbers = hideLineNumbers ? false : showLineNumbers;

  try {
    const lines = codeToHighlight.split(/\r?\n/);
    const padWidth = String(lines.length).length;

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
              <Text color={activeTheme.colors.Gray}>{`${index + 1}`}</Text>
            </Box>
          )}
          <Text color={activeTheme.defaultColor} wrap="wrap">
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
            alignItems="flex-start"
            justifyContent="flex-end"
          >
            <Text color={activeTheme.defaultColor}>{`${index + 1}`}</Text>
          </Box>
        )}
        <Text color={activeTheme.colors.Gray}>{line}</Text>
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
