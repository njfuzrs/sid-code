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

// 创建 lowlight 实例（加载所有语言）
const lowlight = createLowlight();

// 同步创建带常用语言的实例
let lowlightWithLangs: ReturnType<typeof createLowlight> | null = null;
function getLowlight() {
  if (lowlightWithLangs) return lowlightWithLangs;
  try {
    // lowlight 3.x: common 是一个 grammars 对象
    const common = require("lowlight/lib/common.js");
    lowlightWithLangs = createLowlight(common.default || common);
    return lowlightWithLangs;
  } catch {
    // 回退：无语言支持
    return lowlight;
  }
}

/** HAST class → 终端颜色映射 */
const classToColor: Record<string, string> = {
  "hljs-keyword": "blue",
  "hljs-built_in": "cyan",
  "hljs-type": "cyan",
  "hljs-literal": "blue",
  "hljs-number": "green",
  "hljs-regexp": "red",
  "hljs-string": "green",
  "hljs-subst": "white",
  "hljs-symbol": "green",
  "hljs-class": "blue",
  "hljs-function": "yellow",
  "hljs-title": "yellow",
  "hljs-params": "white",
  "hljs-comment": "gray",
  "hljs-doctag": "green",
  "hljs-meta": "gray",
  "hljs-section": "green",
  "hljs-tag": "gray",
  "hljs-name": "blue",
  "hljs-attr": "cyan",
  "hljs-attribute": "cyan",
  "hljs-variable": "red",
  "hljs-bullet": "green",
  "hljs-code": "green",
  "hljs-emphasis": "white",
  "hljs-strong": "white",
  "hljs-formula": "green",
  "hljs-link": "blue",
  "hljs-quote": "gray",
  "hljs-selector-tag": "blue",
  "hljs-selector-id": "blue",
  "hljs-selector-class": "blue",
  "hljs-selector-attr": "cyan",
  "hljs-selector-pseudo": "cyan",
  "hljs-template-tag": "cyan",
  "hljs-template-variable": "cyan",
  "hljs-addition": "green",
  "hljs-deletion": "red",
};

/** 从 HAST Element 的 className 获取颜色 */
function getColorFromClasses(classNames: string[]): string | undefined {
  for (const cls of classNames) {
    if (classToColor[cls]) return classToColor[cls];
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

  // 有高亮：逐行渲染，每行添加 2 空格缩进
  const lines = code.split("\n");
  return (
    <Text>
      {lines.map((line, i) => (
        <React.Fragment key={i}>
          {i > 0 ? "\n" : null}
          {"  "}{highlightToReact(line, lang)}
        </React.Fragment>
      ))}
    </Text>
  );
});
