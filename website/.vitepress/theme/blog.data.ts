/**
 * 文章列表的构建期数据源（VitePress 的 `*.data.ts` 约定）。
 *
 * `load()` 在**构建期**跑，返回值被序列化进产物，`BlogIndex.vue` 直接 import 即可，
 * 浏览器零请求、无 loading 态。与 changelog 的做法一致。
 *
 * 数据来自 `.vitepress/blog-meta.ts`（唯一事实源，config.ts 的 sidebar 也读它），
 * 所以列表页与 sidebar 永远同一份顺序、同一份标题，不会各自解析各自漂移。
 *
 * `watch` 让 dev 模式下改文章能热更新列表——不配的话新增文章要重启 dev server。
 */
import { defineLoader } from "vitepress";
import { loadBlogPosts, type BlogPost } from "../blog-meta";

declare const data: BlogPost[];
export { data };

export default defineLoader({
  watch: ["../../blog/*.md"],
  load(): BlogPost[] {
    return loadBlogPosts();
  },
});
