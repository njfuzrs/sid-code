#!/usr/bin/env bun
/**
 * 手动测试 Markdown 渲染效果
 *
 * 使用方法：
 * 1. bun run scripts/test-markdown-render.ts
 * 2. 在终端中查看渲染效果
 */

import { renderMarkdown } from "../src/ui/markdown.ts";

console.log("=".repeat(80));
console.log("Markdown 渲染测试");
console.log("=".repeat(80));
console.log();

// 测试 1：简单表格
console.log("【测试 1】简单表格");
console.log("-".repeat(80));
const simpleTable = `| 命令 | 说明 |
|------|------|
| make build | 构建项目 |
| make test | 运行测试 |
| make run | 运行程序 |`;

console.log(renderMarkdown(simpleTable, 120));
console.log();

// 测试 2：宽表格
console.log("【测试 2】宽表格");
console.log("-".repeat(80));
const wideTable = `| 层级      | 技术选型                 | 说明                                                |
|-----------|--------------------------|-----------------------------------------------------|
| 运行时    | Bun v1.3+                | 极速 JS 运行时，bun build --compile 输出单二进制可执行文件 |
| LLM SDK   | @anthropic-ai/sdk        | 默认 provider；openai / ollama 作为插件实现         |
| TUI 框架  | ink + @inkjs/ui          | 基于 React 的终端 UI；自研 Rasterizer 实现双缓冲差分渲染 |`;

console.log(renderMarkdown(wideTable, 120));
console.log();

// 测试 3：代码高亮
console.log("【测试 3】代码高亮");
console.log("-".repeat(80));
const codeBlock = `\`\`\`typescript
function highlightCode(code: string, lang?: string): string {
  try {
    if (lang && supportsLanguage(lang)) {
      return cliHighlight(code, {
        language: lang,
        ignoreIllegals: true,
        theme: codeHighlightTheme,
      });
    }
    return cliHighlight(code, {
      ignoreIllegals: true,
      theme: codeHighlightTheme,
    });
  } catch {
    return code;
  }
}
\`\`\``;

console.log(renderMarkdown(codeBlock, 120));
console.log();

// 测试 4：混合内容
console.log("【测试 4】混合内容（表格 + 代码）");
console.log("-".repeat(80));
const mixedContent = `## 技术栈

| 层级 | 技术 |
|------|------|
| 运行时 | Bun v1.3+ |
| TUI | ink + @inkjs/ui |

## 示例代码

\`\`\`bash
make build
make test
\`\`\`

使用 \`make build\` 命令构建项目。`;

console.log(renderMarkdown(mixedContent, 120));
console.log();

// 测试 5：行内代码和样式
console.log("【测试 5】行内代码和样式");
console.log("-".repeat(80));
const inlineStyles = `这是一段包含 **粗体**、*斜体*、\`行内代码\` 和 [链接](https://example.com) 的文本。

- 列表项 1
- 列表项 2 with \`code\`
- 列表项 3

> 这是一段引用文本
> 可以包含多行`;

console.log(renderMarkdown(inlineStyles, 120));
console.log();

console.log("=".repeat(80));
console.log("测试完成");
console.log("=".repeat(80));
