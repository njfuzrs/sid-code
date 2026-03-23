#!/usr/bin/env bun
/**
 * 在实际 TUI 环境中测试表格渲染
 * 启动一个简单的 Ink 应用，显示测试表格
 */

import React, { useState, useEffect } from "react";
import { render, Box, Text, useInput } from "ink";
import { renderMarkdownToReact } from "../src/ui/markdown.ts";

const testMarkdown = `
# 表格渲染测试

## 简单表格

| 命令 | 说明 |
|------|------|
| make build | 构建项目 |
| make test | 运行测试 |

## 宽表格

| 层级 | 技术选型 | 说明 |
|------|----------|------|
| 运行时 | Bun v1.3+ | 极速 JS 运行时，bun build --compile 输出单二进制可执行文件 |
| CLI | node:util parseArgs | 原生参数解析，无需第三方依赖 |

## 样式表格

| 功能 | 状态 | 说明 |
|------|------|------|
| **加粗** | ✅ | 支持加粗 |
| *斜体* | ✅ | 支持斜体 |
| [链接](https://example.com) | ✅ | 支持链接 |

按 q 退出
`;

const TestApp = () => {
  const [termWidth, setTermWidth] = useState(process.stdout.columns || 120);

  useEffect(() => {
    const handleResize = () => {
      setTermWidth(process.stdout.columns || 120);
    };
    process.stdout.on("resize", handleResize);
    return () => {
      process.stdout.off("resize", handleResize);
    };
  }, []);

  useInput((input, key) => {
    if (input === "q" || key.escape) {
      process.exit(0);
    }
  });

  return (
    <Box flexDirection="column" padding={1}>
      <Text dimColor>终端宽度: {termWidth}</Text>
      <Text dimColor>{"─".repeat(Math.min(termWidth - 2, 80))}</Text>
      {renderMarkdownToReact(testMarkdown, termWidth - 4)}
    </Box>
  );
};

render(<TestApp />);
