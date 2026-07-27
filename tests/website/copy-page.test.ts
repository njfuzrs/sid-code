/**
 * T-3.11「复制整页」的数据路径单测。
 *
 * 验收标准是"点击后剪贴板是 md 源文"。点击行为本身要真实浏览器才能验，
 * 这里锁住的是**能被单测锁住的那部分**——喂给剪贴板的字符串到底是什么：
 *   ① frontmatter 被剥掉（那是给构建器看的元数据，贴给 agent 属噪音）
 *   ② 剩下的是 markdown 源文，不是渲染后的 HTML
 *   ③ 正文里的 `---`（水平线 / 表格分隔）不会被误当 frontmatter 边界
 *
 * 按钮的交互（复制成功态、http 下的 execCommand 回退）不在本文件覆盖范围内，
 * 需人工或浏览器验证——这一点如实记在这里，免得看到"有测试"就以为全覆盖了。
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { stripFrontmatter } from "../../website/.vitepress/raw-markdown.ts";

const ROOT = resolve(import.meta.dir, "..", "..");

describe("stripFrontmatter · 剥离 frontmatter", () => {
  test("剥掉开头的 frontmatter 块，保留正文", () => {
    const src = ["---", "title: 内置工具", "description: 全部工具", "---", "", "# 内置工具", "", "正文"].join("\n");
    const out = stripFrontmatter(src);
    expect(out).toBe("# 内置工具\n\n正文");
    expect(out).not.toContain("title:");
    expect(out).not.toContain("description:");
  });

  test("无 frontmatter 时原样返回", () => {
    const src = "# 直接是标题\n\n正文";
    expect(stripFrontmatter(src)).toBe(src);
  });

  test("正文里的 --- 不被误当 frontmatter 边界", () => {
    // 这是最容易写错的一处：markdown 的水平线和表格分隔行都长得像 frontmatter 分隔符。
    const src = ["# 标题", "", "上半段", "", "---", "", "下半段"].join("\n");
    // 不以 --- 开头 → 整体不该被当作带 frontmatter 的文件
    expect(stripFrontmatter(src)).toBe(src);
    expect(stripFrontmatter(src)).toContain("上半段");
  });

  test("frontmatter 之后正文含 --- 时只剥第一段", () => {
    const src = ["---", "title: T", "---", "", "# 标题", "", "---", "", "尾部"].join("\n");
    const out = stripFrontmatter(src);
    expect(out).not.toContain("title: T");
    expect(out).toContain("# 标题");
    expect(out).toContain("---"); // 正文里的水平线必须留着
    expect(out).toContain("尾部");
  });

  test("只有未闭合的 --- 时原样返回（不吞掉全文）", () => {
    const src = "---\n没有闭合分隔符的内容";
    expect(stripFrontmatter(src)).toBe(src);
  });
});

describe("复制整页的实际产出（拿真实站内页面验）", () => {
  const pages = ["ref/tools.md", "ref/cli.md", "start/install.md"];

  for (const rel of pages) {
    test(`${rel}：产出是 markdown 源文而非渲染 HTML`, () => {
      const raw = readFileSync(join(ROOT, "website", rel), "utf8");
      const out = stripFrontmatter(raw);

      expect(out.length).toBeGreaterThan(0);
      // frontmatter 字段不该出现在复制内容里
      expect(out).not.toMatch(/^---/);
      expect(out).not.toContain("\ntitle: ");
      // 是 markdown：有 # 标题
      expect(out).toMatch(/^#\s/m);
      // 不是渲染后的 HTML
      expect(out).not.toContain("<table");
      expect(out).not.toContain("<td");
      expect(out).not.toContain('class="vp-doc"');
    });
  }

  test("参考页复制出来保留 markdown 表格结构（agent 友好的关键）", () => {
    const out = stripFrontmatter(readFileSync(join(ROOT, "website/ref/tools.md"), "utf8"));
    // 表头 + 分隔行 + 至少一行数据，管道符结构完整
    expect(out).toContain("| 工具名 | 用途 |");
    expect(out).toMatch(/\|---\|/);
    expect(out).toContain("| `bash` |");
  });

  test("主题层与 config 用的是同一个 stripFrontmatter（不存在两份实现）", () => {
    // 早期版本把函数内联在 config.ts 里，测试便无从下手。这里锁住"已抽成共享模块"。
    const cfg = readFileSync(join(ROOT, "website/.vitepress/config.ts"), "utf8");
    expect(cfg).toContain('from "./raw-markdown"');
    expect(cfg).toContain("transformPageData");
    // 按钮组件读的是 config 注入的 frontmatter.rawMarkdown
    const btn = readFileSync(join(ROOT, "website/.vitepress/theme/CopyPage.vue"), "utf8");
    expect(btn).toContain("rawMarkdown");
    expect(cfg).toContain("rawMarkdown");
  });

  test("按钮保留 http 场景的 execCommand 回退（站点当前是 IP + http 部署）", () => {
    // navigator.clipboard 需要安全上下文；当前站点备案前是 http，缺回退等于线上点了没反应。
    const btn = readFileSync(join(ROOT, "website/.vitepress/theme/CopyPage.vue"), "utf8");
    expect(btn).toContain("isSecureContext");
    expect(btn).toContain("execCommand");
  });
});
