/**
 * 全站搜索收录范围的判据单测。
 *
 * 失效形态是静默的（博客重新出现在搜索结果里，构建照样绿），
 * 所以真实索引产物的断言见下方 dist 那一组：构建产物在时才跑，
 * 不在时显式 skip 并写明原因，而不是 if 包住断言让它恒绿。
 */
import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { isExcludedFromSearch } from "../../website/.vitepress/search-scope";

describe("isExcludedFromSearch", () => {
  test("blog 目录下的文章一律排除（不依赖 frontmatter）", () => {
    expect(isExcludedFromSearch("blog/cc-07-hooks.md", {})).toBe(true);
    expect(isExcludedFromSearch("blog/index.md", undefined)).toBe(true);
    expect(isExcludedFromSearch("blog\\subagent-isolation.md", {})).toBe(true);
  });

  test("search: false 的单页排除（changelog）", () => {
    expect(isExcludedFromSearch("changelog.md", { search: false })).toBe(true);
  });

  test("用户说明文档照常收录", () => {
    for (const p of [
      "index.md",
      "start/install.md",
      "use/interactive.md",
      "extend/hooks.md",
      "team/policy.md",
      "ref/cli.md",
    ]) {
      expect(isExcludedFromSearch(p, {})).toBe(false);
    }
  });

  test("前缀带尾斜杠，不误伤同前缀的页面", () => {
    expect(isExcludedFromSearch("blogging.md", {})).toBe(false);
    expect(isExcludedFromSearch("use/blog.md", {})).toBe(false);
  });

  test("relativePath 缺失时只看 frontmatter", () => {
    expect(isExcludedFromSearch(undefined, undefined)).toBe(false);
    expect(isExcludedFromSearch(undefined, { search: false })).toBe(true);
  });
});

const chunks = join(import.meta.dir, "../../website/.vitepress/dist/assets/chunks");
const indexFile = existsSync(chunks)
  ? readdirSync(chunks).find((f) => f.startsWith("@localSearchIndexroot."))
  : undefined;

describe.skipIf(!indexFile)("构建产物里的搜索索引（需先 vitepress build）", () => {
  test("索引不含任何 /blog/ 与 /changelog 条目，且仍含用户文档", () => {
    const raw = readFileSync(join(chunks, indexFile!), "utf-8");
    expect(raw).not.toMatch(/\/blog\//);
    expect(raw).not.toMatch(/\/changelog/);
    expect(raw).toMatch(/\/use\//);
  });
});
