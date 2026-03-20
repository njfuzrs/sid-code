/**
 * 代码高亮组件
 *
 * 用 lowlight 生成 HAST 树，转换为 Ink <Text> 组件。
 * 复用 markdown.ts 现有主题定义的颜色映射。
 */

import React from "react";
import { Text } from "ink";
import { createLowlight } from "lowlight";
import type { Element, Text as HastText, RootContent } from "hast";
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

/** 递归将 HAST 节点转换为 Ink React 元素 */
function renderHastNode(node: RootContent, key: number): React.ReactNode {
  if (node.type === "text") {
    return (node as HastText).value;
  }

  if (node.type === "element") {
    const el = node as Element;
    const classNames = (el.properties?.className as string[]) || [];
    const color = getColorFromClasses(classNames);
    const children = el.children.map((child, i) => renderHastNode(child as RootContent, i));

    // hljs-emphasis → italic, hljs-strong → bold
    const isEmphasis = classNames.includes("hljs-emphasis");
    const isStrong = classNames.includes("hljs-strong");

    if (color || isEmphasis || isStrong) {
      return (
        <Text key={key} color={color} italic={isEmphasis || undefined} bold={isStrong || undefined}>
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

/** 高亮代码并返回 React 元素 */
export function highlightToReact(code: string, lang?: string): React.ReactNode {
  if (!lang) {
    return <Text>{code}</Text>;
  }

  try {
    const ll = getLowlight();
    if (!ll.registered(lang)) {
      return <Text>{code}</Text>;
    }

    const tree = ll.highlight(lang, code);
    const children = tree.children.map((child, i) => renderHastNode(child as RootContent, i));
    return <>{children}</>;
  } catch {
    return <Text>{code}</Text>;
  }
}

interface CodeBlockProps {
  code: string;
  lang?: string;
}

/** 代码块组件：带缩进和语法高亮 */
export const CodeBlock = React.memo(function CodeBlock({ code, lang }: CodeBlockProps) {
  // 先检查语言支持，避免无用的高亮计算
  if (!lang || !supportsLanguage(lang)) {
    const indented = code.split("\n").map(line => "  " + line).join("\n");
    return <Text>{indented}</Text>;
  }

  // 整块高亮（保持多行语法上下文），然后按行添加缩进
  const highlighted = highlightToReact(code, lang);
  return (
    <Text>
      {"  "}{highlighted}
    </Text>
  );
});
