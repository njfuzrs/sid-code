#!/usr/bin/env bun
/**
 * 测试表格渲染效果（React 版本）
 * 使用 Ink 的 render() 函数在终端输出，验证实际 TUI 效果
 */

import React from "react";
import { render, Box, Text } from "ink";
import { renderMarkdownToReact } from "../src/ui/markdown.ts";

const testCases = [
  {
    name: "简单表格（2列3行）",
    markdown: `
| 命令 | 说明 |
|------|------|
| make build | 构建项目 |
| make test | 运行测试 |
| make run | 运行程序 |
`,
  },
  {
    name: "宽表格（3列，带中文和长文本）",
    markdown: `
| 层级 | 技术选型 | 说明 |
|------|----------|------|
| 运行时 | Bun v1.3+ | 极速 JS 运行时，bun build --compile 输出单二进制可执行文件 |
| CLI | node:util parseArgs | 原生参数解析，无需第三方依赖 |
| LLM | @anthropic-ai/sdk | Anthropic SDK，支持流式响应和工具调用 |
`,
  },
  {
    name: "表格 + 代码混合",
    markdown: `
使用 \`make build\` 命令构建项目。

| 命令 | 说明 |
|------|------|
| **make build** | 构建项目 |
| *make test* | 运行测试 |

\`\`\`typescript
function test() {
  console.log("hello");
}
\`\`\`
`,
  },
  {
    name: "包含 markdown 样式的表格",
    markdown: `
| 功能 | 状态 | 说明 |
|------|------|------|
| **加粗** | ✅ | 支持 \`**text**\` |
| *斜体* | ✅ | 支持 \`*text*\` |
| ~~删除线~~ | ✅ | 支持 \`~~text~~\` |
| 链接 | ✅ | 支持 \`[text](url)\` |
`,
  },
];

async function runTest(testCase: { name: string; markdown: string }) {
  return new Promise<void>((resolve) => {
    const TestComponent = () => {
      const title = `\n### ${testCase.name}\n`;
      const separator = "\n" + "-".repeat(80) + "\n";

      return React.createElement(
        Box,
        { flexDirection: "column" as const },
        React.createElement(Text, { bold: true }, title),
        renderMarkdownToReact(testCase.markdown, 120),
        React.createElement(Text, { dimColor: true }, separator)
      );
    };

    const { unmount } = render(React.createElement(TestComponent));

    // 等待渲染完成后卸载
    setTimeout(() => {
      unmount();
      resolve();
    }, 100);
  });
}

async function main() {
  console.log("=".repeat(80));
  console.log("表格渲染测试（React 版本）");
  console.log("=".repeat(80));

  for (const testCase of testCases) {
    await runTest(testCase);
  }

  console.log("\n测试完成！");
  console.log("\n检查要点：");
  console.log("1. 表格右侧边框是否完整对齐（所有行的右侧 │ 应该在同一列）");
  console.log("2. 代码高亮颜色是否泄漏到表格边框");
  console.log("3. 表格内的 markdown 样式（加粗、斜体等）是否正确渲染");
  console.log("4. 长文本是否正确换行，边框是否对齐");
}

main().catch(console.error);
