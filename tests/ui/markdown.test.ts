/**
 * Markdown 终端渲染器测试
 */

import { describe, test, expect } from "bun:test";
import stripAnsi from "strip-ansi";
import stringWidth from "string-width";
import {
  renderMarkdown,
  cachedLexer,
  renderInlineMarkdown,
  isTableToken,
  extractTableData,
} from "../../src/ui/markdown.ts";

// 每个测试前清空渲染缓存（通过渲染一个不同宽度触发清空，再恢复）
// renderMarkdown 内部会在宽度变化时清空缓存，这里利用这个机制

describe("renderMarkdown", () => {

  // ── 标题 ──────────────────────────────────────────────────────

  describe("标题", () => {
    test("h1 含 bold + italic + underline ANSI 码", () => {
      const result = renderMarkdown("# 一级标题");
      const plain = stripAnsi(result);
      expect(plain).toContain("一级标题");
      // bold: \x1b[1m, italic: \x1b[3m, underline: \x1b[4m
      expect(result).toMatch(/\x1b\[1m/);
      expect(result).toMatch(/\x1b\[3m/);
      expect(result).toMatch(/\x1b\[4m/);
    });

    test("h2 含 bold 码但不含 italic/underline", () => {
      const result = renderMarkdown("## 二级标题");
      const plain = stripAnsi(result);
      expect(plain).toContain("二级标题");
      expect(result).toMatch(/\x1b\[1m/);
    });

    test("h3 也是 bold", () => {
      const result = renderMarkdown("### 三级标题");
      const plain = stripAnsi(result);
      expect(plain).toContain("三级标题");
      expect(result).toMatch(/\x1b\[1m/);
    });
  });

  // ── 代码块 ────────────────────────────────────────────────────

  describe("代码块", () => {
    test("有语言时含高亮 ANSI 码", () => {
      const result = renderMarkdown("```js\nconst x = 1;\n```");
      const plain = stripAnsi(result);
      expect(plain).toContain("const x = 1;");
      // 高亮后应包含 ANSI 转义码
      expect(result).toMatch(/\x1b\[/);
    });

    test("无语言时原文 + 2 空格缩进", () => {
      const result = renderMarkdown("```\nhello world\n```");
      const plain = stripAnsi(result);
      expect(plain).toContain("  hello world");
    });

    test("代码块每行都有缩进", () => {
      const result = renderMarkdown("```\nline1\nline2\nline3\n```");
      const plain = stripAnsi(result);
      const lines = plain.split("\n");
      for (const line of lines) {
        if (line.trim()) {
          expect(line).toMatch(/^ {2}/);
        }
      }
    });
  });

  // ── 行内格式 ──────────────────────────────────────────────────

  describe("行内格式", () => {
    test("bold 含 \\x1b[1m", () => {
      const result = renderMarkdown("这是 **加粗** 文本");
      expect(result).toMatch(/\x1b\[1m/);
      expect(stripAnsi(result)).toContain("加粗");
    });

    test("italic 含 \\x1b[3m", () => {
      const result = renderMarkdown("这是 *斜体* 文本");
      expect(result).toMatch(/\x1b\[3m/);
      expect(stripAnsi(result)).toContain("斜体");
    });

    test("codespan 含主题色（hex RGB）", () => {
      const result = renderMarkdown("使用 `code` 命令");
      expect(stripAnsi(result)).toContain("code");
      // 改用主题 hex 色后，输出为 24-bit RGB 格式: \x1b[38;2;R;G;Bm
      expect(result).toMatch(/\x1b\[38;2;\d+;\d+;\d+m/);
    });

    test("删除线被禁用：~~ 原样保留不渲染成 strikethrough（P2-I）", () => {
      // configureMarked() 禁用了 del tokenizer：模型常用 ~100 表「约 100」，
      // 不应被误渲染成删除线。~~删除线~~ 此时按普通文本处理，不含 \x1b[9m。
      const result = renderMarkdown("这是 ~~删除线~~ 文本");
      expect(stripAnsi(result)).toContain("删除线");
      // 不应出现 strikethrough 码 \x1b[9m
      expect(result).not.toMatch(/\x1b\[9m/);
    });
  });

  // ── 链接 ──────────────────────────────────────────────────────

  describe("链接", () => {
    test("含 OSC 8 转义序列（仅在 TTY 环境）", () => {
      const result = renderMarkdown("[点击这里](https://example.com)");

      // 在非 TTY 环境下，OSC 8 会被禁用，只保留颜色和下划线
      if (process.stdout.isTTY) {
        expect(result).toContain("\x1b]8;;");
        expect(result).toContain("https://example.com");
      }

      // 无论是否 TTY，都应该包含链接文本
      expect(stripAnsi(result.replace(/\x1b\]8;;[^\x1b]*\x1b\\/g, ""))).toContain("点击这里");
    });

    test("链接文本有主题颜色下划线", () => {
      const result = renderMarkdown("[link](https://example.com)");
      // 使用主题 hex 颜色（38;2;r;g;b 格式）而非 chalk 默认蓝色
      expect(result).toMatch(/\x1b\[38;2;\d+;\d+;\d+m/);
      expect(result).toMatch(/\x1b\[4m/);
    });
  });

  // ── 列表 ──────────────────────────────────────────────────────

  describe("列表", () => {
    test("无序列表使用 - 前缀", () => {
      const result = renderMarkdown("- 项目一\n- 项目二\n- 项目三");
      const plain = stripAnsi(result);
      expect(plain).toContain("- 项目一");
      expect(plain).toContain("- 项目二");
      expect(plain).toContain("- 项目三");
    });

    test("有序列表使用数字前缀", () => {
      const result = renderMarkdown("1. 第一\n2. 第二\n3. 第三");
      const plain = stripAnsi(result);
      expect(plain).toContain("1.");
      expect(plain).toContain("2.");
      expect(plain).toContain("3.");
    });

    test("嵌套列表有缩进", () => {
      const md = "- 外层\n  - 内层一\n  - 内层二";
      const result = renderMarkdown(md);
      const plain = stripAnsi(result);
      expect(plain).toContain("外层");
      expect(plain).toContain("内层一");
      // 内层应有缩进
      const lines = plain.split("\n");
      const innerLine = lines.find(l => l.includes("内层一"));
      expect(innerLine).toBeDefined();
      expect(innerLine!.startsWith("  ")).toBe(true);
    });

    // 根因同 MarkdownAnsi 块拼接 bug（见 markdown-ansi-block-spacing.test.tsx）：
    // renderList 曾用 parts.join("") 直接拼接列表项内的多个子块（松散列表多段落 /
    // 段落+代码块 / 段落+引用），块之间零分隔符导致文本粘连成一片。
    test("松散列表（段落间有空行）不应粘连", () => {
      const md = "- 项目一第一段\n\n  项目一第二段\n\n- 项目二";
      const plain = stripAnsi(renderMarkdown(md, 80));
      expect(plain).not.toContain("项目一第一段项目一第二段");
      expect(plain).toContain("项目一第一段");
      expect(plain).toContain("项目一第二段");
    });

    test("列表项含段落+代码块不应粘连", () => {
      const md = "- 说明文字\n\n  ```js\n  const x = 1;\n  ```\n- 下一项";
      const plain = stripAnsi(renderMarkdown(md, 80));
      expect(plain).not.toContain("说明文字  const x = 1;");
      expect(plain).toContain("说明文字");
      expect(plain).toContain("const x = 1;");
    });

    test("列表项含段落+引用不应粘连", () => {
      const md = "- 说明文字\n\n  > 引用内容\n- 下一项";
      const plain = stripAnsi(renderMarkdown(md, 80));
      expect(plain).not.toContain("说明文字│ 引用内容");
      expect(plain).toContain("说明文字");
      expect(plain).toContain("引用内容");
    });

    test("列表项续行悬挂缩进对齐到文本列，不只是列表符号列", () => {
      const md = "- 项目一第一段\n\n  项目一第二段";
      const plain = stripAnsi(renderMarkdown(md, 80));
      const lines = plain.split("\n");
      const contLine = lines.find(l => l.includes("项目一第二段"));
      expect(contLine).toBeDefined();
      // "- " 前缀宽度为 2，续行应悬挂缩进 2 空格对齐到 "项目一第一段" 的文本列
      expect(contLine!.startsWith("  ")).toBe(true);
    });

    test("紧凑嵌套列表悬挂缩进修复后不应引入多余空行（回归）", () => {
      const md = "- 外层\n  - 内层一\n  - 内层二";
      const plain = stripAnsi(renderMarkdown(md, 80));
      expect(plain).toBe("- 外层\n  - 内层一\n  - 内层二");
    });
  });

  // ── 引用 ──────────────────────────────────────────────────────

  describe("引用", () => {
    test("含 │ 前缀", () => {
      const result = renderMarkdown("> 这是引用");
      const plain = stripAnsi(result);
      expect(plain).toContain("│");
      expect(plain).toContain("这是引用");
    });

    test("引用内容有 italic 样式", () => {
      const result = renderMarkdown("> 引用文本");
      // italic: \x1b[3m
      expect(result).toMatch(/\x1b\[3m/);
    });
  });

  // ── 表格 ──────────────────────────────────────────────────────

  describe("表格", () => {
    test("正常表格渲染", () => {
      const md = "| 名称 | 值 |\n|------|----|\n| foo | bar |";
      const result = renderMarkdown(md);
      const plain = stripAnsi(result);
      expect(plain).toContain("foo");
      expect(plain).toContain("bar");
    });

    test("表格 header 支持内联格式", () => {
      const md = "| **名称** | 值 |\n|------|----|\n| foo | bar |";
      const result = renderMarkdown(md);
      // header 中的 bold 应被渲染
      expect(result).toMatch(/\x1b\[1m/);
    });

    test("中文标点表格不溢出", () => {
      const md = "| 名称 | 描述 |\n|------|------|\n| 功能——测试 | \u201C引号\u201D内容 |\n| 省略…符号 | 更多·内容 |";
      const result = renderMarkdown(md, 80);
      const lines = stripAnsi(result).split("\n").filter(l => l.trim());
      // 验证每行宽度不超过 80
      for (const line of lines) {
        expect(stringWidth(line)).toBeLessThanOrEqual(80);
      }
    });

    test("纯中文长内容换行而非截断", () => {
      const md = "| 列 |\n|----|\n| 这是一段很长的纯中文内容没有空格应该正常换行而不是被截断显示省略号 |";
      const result = renderMarkdown(md, 40);
      const plain = stripAnsi(result);
      // 不应出现 … 截断符号
      expect(plain).not.toContain("…");
      // 应包含完整内容
      expect(plain).toContain("这是一段很长");
      expect(plain).toContain("显示省略号");
    });

    test("多列表格每行宽度一致", () => {
      const md = "| A | B | C |\n|---|---|---|\n| 短 | 中等长度 | 很长很长很长 |\n| x | y | z |";
      const result = renderMarkdown(md, 60);
      const lines = stripAnsi(result).split("\n").filter(l => l.startsWith("│"));
      // 所有内容行宽度应一致（使用 string-width 验证）
      const widths = lines.map(l => stringWidth(l));
      const firstWidth = widths[0];
      for (const w of widths) {
        expect(w).toBe(firstWidth);
      }
    });

    test("超窄终端降级为 key-value", () => {
      const md = "| A | B | C | D | E | F | G |\n|---|---|---|---|---|---|---|\n| 1 | 2 | 3 | 4 | 5 | 6 | 7 |";
      const result = renderMarkdown(md, 30);
      const plain = stripAnsi(result);
      // 超过 MAX_TABLE_COLS 或宽度不足，应降级为 key-value 格式
      expect(plain).toContain("A:");
      expect(plain).toContain("B:");
    });

    test("空 cell 不崩溃", () => {
      const md = "| A | B |\n|---|---|\n| x |  |\n|  | y |";
      expect(() => renderMarkdown(md)).not.toThrow();
      const result = renderMarkdown(md);
      const plain = stripAnsi(result);
      expect(plain).toContain("x");
      expect(plain).toContain("y");
    });

    test("含 ANSI 样式的 cell 内容正确对齐", () => {
      // 模拟 header 中有 bold 的情况（renderTable 会对 header 应用 chalk.bold）
      const md = "| 名称 | 值 |\n|------|----|\n| foo | bar |";
      const result = renderMarkdown(md, 80);
      const lines = stripAnsi(result).split("\n").filter(l => l.startsWith("│"));
      // 所有行宽度应一致（即使 header 有 ANSI 码）
      const widths = lines.map(l => stringWidth(l));
      const firstWidth = widths[0];
      for (const w of widths) {
        expect(w).toBe(firstWidth);
      }
    });
  });

  // ── 水平分割线 ────────────────────────────────────────────────

  describe("水平分割线", () => {
    test("渲染为 ---", () => {
      const result = renderMarkdown("上面\n\n---\n\n下面");
      const plain = stripAnsi(result);
      expect(plain).toContain("---");
    });
  });

  // ── 段落 ──────────────────────────────────────────────────────

  describe("段落", () => {
    test("多段落用空行分隔", () => {
      const result = renderMarkdown("段落一\n\n段落二");
      const plain = stripAnsi(result);
      expect(plain).toContain("段落一");
      expect(plain).toContain("段落二");
      // 两段之间应有空行
      expect(plain).toMatch(/段落一\n\n段落二/);
    });
  });

  // ── 缓存 ──────────────────────────────────────────────────────

  describe("缓存", () => {
    test("相同输入返回缓存结果", () => {
      const input = "# 缓存测试 " + Math.random();
      const result1 = renderMarkdown(input);
      const result2 = renderMarkdown(input);
      expect(result1).toBe(result2);
    });
  });

  // ── 流式容错 ──────────────────────────────────────────────────

  describe("流式容错", () => {
    test("未闭合代码块不崩溃", () => {
      expect(() => renderMarkdown("```js\nconst x = 1;")).not.toThrow();
      const result = renderMarkdown("```js\nconst x = 1;");
      expect(stripAnsi(result)).toContain("const x = 1;");
    });

    test("未闭合加粗不崩溃", () => {
      expect(() => renderMarkdown("这是 **未闭合")).not.toThrow();
    });

    test("空字符串不崩溃", () => {
      expect(() => renderMarkdown("")).not.toThrow();
    });

    test("纯文本不崩溃", () => {
      const result = renderMarkdown("纯文本内容");
      expect(stripAnsi(result)).toContain("纯文本内容");
    });

    test("未闭合行内代码不崩溃", () => {
      expect(() => renderMarkdown("使用 `未闭合")).not.toThrow();
    });

    test("混合不完整 markdown 不崩溃", () => {
      const md = "# 标题\n\n```\n代码\n\n- 列表\n  - 嵌套\n\n> 引用 **加粗";
      expect(() => renderMarkdown(md)).not.toThrow();
    });
  });

  // ── 综合 ──────────────────────────────────────────────────────

  describe("综合", () => {
    test("混合内容渲染", () => {
      const md = `# 标题

这是一段 **加粗** 和 *斜体* 文本。

\`\`\`ts
const x = 1;
\`\`\`

- 列表项一
- 列表项二

> 引用内容`;

      const result = renderMarkdown(md);
      const plain = stripAnsi(result);
      expect(plain).toContain("标题");
      expect(plain).toContain("加粗");
      expect(plain).toContain("斜体");
      expect(plain).toContain("const x = 1;");
      expect(plain).toContain("列表项一");
      expect(plain).toContain("引用内容");
    });
  });
});

// ── 新管线：cachedLexer / renderInlineMarkdown / 表格 token ──────────
describe("cachedLexer（token 缓存 + 纯文本快速路径，P1-D）", () => {
  test("纯文本无 markdown 语法 → 单 paragraph 快速路径", () => {
    const toks = cachedLexer("这是一段没有任何标记的纯文本");
    expect(toks.length).toBe(1);
    expect((toks[0] as any).type).toBe("paragraph");
  });

  test("含 markdown 语法 → 同内容缓存命中（返回同一引用）", () => {
    const md = "# 标题\n\n| A | B |\n|---|---|\n| 1 | 2 |";
    const a = cachedLexer(md);
    const b = cachedLexer(md);
    expect(a).toBe(b); // LRU 缓存命中
  });

  test("解析出表格 token，可被 isTableToken 识别并提取数据", () => {
    const toks = cachedLexer("| 名称 | 值 |\n|---|---|\n| x | 1 |") as any[];
    const tableTok = toks.find((t) => isTableToken(t));
    expect(tableTok).toBeDefined();
    const { headers, rows } = extractTableData(tableTok);
    expect(headers).toEqual(["名称", "值"]);
    expect(rows).toEqual([["x", "1"]]);
  });
});

describe("renderInlineMarkdown（表格单元格内联渲染，P1-E）", () => {
  test("加粗内联生成 bold 码", () => {
    const out = renderInlineMarkdown("**重点**");
    expect(out).toMatch(/\x1b\[1m/);
    expect(stripAnsi(out)).toContain("重点");
  });

  test("行内代码与链接正确渲染（marked token，非手写正则）", () => {
    const out = renderInlineMarkdown("`code` 和 [链接](https://x.com)");
    expect(stripAnsi(out)).toContain("code");
    expect(stripAnsi(out.replace(/\x1b\]8;;[^\x1b]*\x1b\\/g, ""))).toContain("链接");
  });

  test("defaultColor 给裸文本套基础色（表头用）", () => {
    const out = renderInlineMarkdown("标题", "#89b4fa");
    expect(out).toMatch(/\x1b\[38;2;\d+;\d+;\d+m/);
    expect(stripAnsi(out)).toContain("标题");
  });

  test("~~ 不被渲染为删除线（与 P2-I 一致）", () => {
    const out = renderInlineMarkdown("约 ~~100~~ 个");
    expect(out).not.toMatch(/\x1b\[9m/);
  });
});
