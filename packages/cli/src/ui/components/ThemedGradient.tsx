/**
 * 主题渐变文本组件
 *
 * 使用当前主题的渐变色渲染文本。
 * 如果主题定义了 gradient 颜色数组（≥2），使用 tinygradient 渲染渐变；
 * 如果只有 1 个颜色，使用单色；
 * 否则回退到 accent 色。
 *
 * 参考 gemini-cli ThemedGradient.tsx
 */

import React from "react";
import Text from "@sid-code/tui-renderer/components/Text.tsx";
import type { Props as TextProps } from "@sid-code/tui-renderer/components/Text.tsx";
import tinycolor from "tinycolor2";
import tinygradient from "tinygradient";
import type { Color } from "@sid-code/tui-renderer/styles.ts";
import { theme } from "../semantic-colors.ts";

/**
 * 将渐变色应用到多行文本的每个字符
 */
function applyGradient(text: string, colors: string[]): React.ReactNode {
  // 收集所有可见字符的位置
  const lines = text.split("\n");
  const chars: { char: string; line: number; col: number }[] = [];

  for (let l = 0; l < lines.length; l++) {
    for (let c = 0; c < lines[l].length; c++) {
      if (lines[l][c] !== " ") {
        chars.push({ char: lines[l][c], line: l, col: c });
      }
    }
  }

  if (chars.length === 0) {
    return <Text>{text}</Text>;
  }

  // 生成渐变色
  const gradient = tinygradient(colors.map((c) => tinycolor(c)));
  const gradientColors = gradient.rgb(Math.max(chars.length, 2));

  // 为每个可见字符分配颜色
  const colorMap = new Map<string, Color>();
  chars.forEach((ch, i) => {
    colorMap.set(`${ch.line}-${ch.col}`, gradientColors[i].toHexString() as Color);
  });

  // 渲染每行
  return (
    <>
      {lines.map((line, lineIdx) => (
        <React.Fragment key={lineIdx}>
          {lineIdx > 0 && "\n"}
          {line.split("").map((char, colIdx) => {
            const color = colorMap.get(`${lineIdx}-${colIdx}`);
            if (color) {
              return (
                <Text key={colIdx} color={color}>
                  {char}
                </Text>
              );
            }
            return <Text key={colIdx}>{char}</Text>;
          })}
        </React.Fragment>
      ))}
    </>
  );
}

export const ThemedGradient: React.FC<TextProps & { children: string }> = ({
  children,
  ...props
}) => {
  const gradient = theme.ui.gradient;

  if (gradient && gradient.length >= 2) {
    return <Text {...props}>{applyGradient(children, gradient)}</Text>;
  }

  if (gradient && gradient.length === 1) {
    return (
      <Text color={gradient[0]} {...props}>
        {children}
      </Text>
    );
  }

  // 回退到 accent 色
  return (
    <Text color={theme.text.accent} {...props}>
      {children}
    </Text>
  );
};
