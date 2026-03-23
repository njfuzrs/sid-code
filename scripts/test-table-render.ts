#!/usr/bin/env bun
/**
 * 测试表格渲染效果
 * 直接在终端输出渲染后的表格，用于验证边框对齐和样式
 */

import { renderMarkdown } from "../src/ui/markdown.ts";

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
| [链接](https://example.com) | ✅ | 支持 \`[text](url)\` |
`,
  },
];

console.log("=".repeat(80));
console.log("表格渲染测试");
console.log("=".repeat(80));
console.log();

for (const testCase of testCases) {
  console.log(`\n### ${testCase.name}\n`);
  const rendered = renderMarkdown(testCase.markdown, 120);
  console.log(rendered);
  console.log("\n" + "-".repeat(80) + "\n");
}

console.log("测试完成！");
console.log("\n检查要点：");
console.log("1. 表格右侧边框是否完整对齐（所有行的右侧 │ 应该在同一列）");
console.log("2. 代码高亮颜色是否泄漏到表格边框");
console.log("3. 表格内的 markdown 样式（加粗、斜体等）是否正确渲染");
console.log("4. 长文本是否正确换行，边框是否对齐");
