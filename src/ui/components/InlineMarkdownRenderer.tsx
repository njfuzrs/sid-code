/**
 * 行内 Markdown 渲染器
 *
 * 将行内 Markdown 文本转换为 ANSI 字符串并渲染为 <Text>。
 * 参考 gemini-cli/packages/cli/src/ui/utils/InlineMarkdownRenderer.tsx
 */

import React from "react";
import { Text } from "ink";
import { parseMarkdownToANSI, stripUnsafeCharacters } from "../../utils/markdownParsingUtils.ts";

interface RenderInlineProps {
  text: string;
  defaultColor?: string;
}

const RenderInlineInternal: React.FC<RenderInlineProps> = ({
  text: rawText,
  defaultColor,
}) => {
  const text = stripUnsafeCharacters(rawText);
  const ansiText = parseMarkdownToANSI(text, defaultColor);

  return <Text>{ansiText}</Text>;
};

export const RenderInline = React.memo(RenderInlineInternal);
