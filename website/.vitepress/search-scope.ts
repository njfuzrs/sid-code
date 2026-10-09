/**
 * 全站搜索的收录范围：哪些页面**不**进本地搜索索引。
 *
 * 全站搜索的读者是「想查怎么用 sid-code」的用户，只收录用户说明文档
 * （start/ use/ extend/ team/ ref/ 等）。两类内容刻意排除：
 *
 *   · /blog/ 整个目录：机制解析与工程实测，篇幅长、术语密，「搜 hook」「搜权限」
 *     时会命中大量文章正文，把真正的用法文档挤到后面，干扰用户视线。
 *     博客有自己的列表页与系列导航，不靠全站搜索被发现。
 *   · frontmatter 标了 `search: false` 的单页：目前是 /changelog（自带只搜版本
 *     变更的独立搜索框）与 /blog/ 列表页。
 *
 * 用目录前缀而不是给每篇文章加 `search: false`：新写的博客默认就不进索引，
 * 不依赖作者记得加一行 frontmatter —— 漏加的失效形态是静默的（搜索结果里
 * 又冒出博客，没有任何东西报错）。
 *
 * 单独成文件是为了能在 bun 单测里直接断言判据（config.ts 带 vitepress 运行时依赖）。
 */

/** 整个目录不进全站索引的路径前缀（相对 srcDir，带尾斜杠防误伤同前缀的页面） */
export const SEARCH_EXCLUDED_DIRS = ["blog/"] as const;

/**
 * @param relativePath vitepress 的 `env.relativePath`，如 `blog/cc-07-hooks.md`
 * @param frontmatter  md.render 之后回填到 env 上的 frontmatter（渲染前恒为 undefined）
 */
export function isExcludedFromSearch(
  relativePath: string | undefined,
  frontmatter: Record<string, unknown> | undefined,
): boolean {
  if (frontmatter?.search === false) return true;
  if (!relativePath) return false;
  const p = relativePath.replace(/\\/g, "/");
  return SEARCH_EXCLUDED_DIRS.some((dir) => p.startsWith(dir));
}
