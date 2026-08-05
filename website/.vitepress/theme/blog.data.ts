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
 *
 * ## 为什么统计值也在这里算好
 *
 * `stats`（文章数 / 累计时长 / 系列数 / 引证数）与 `series`（受控词表 + 各系列文章数）
 * 都是**纯派生值**，构建期算一次烧进产物，前端只渲染。放前端 computed 也能跑，
 * 但引证数需要 `existsSync` 校验仓库文件——那只有构建期做得到（见 blog-meta.ts
 * 的 countEvidenceFiles）。既然一半必须在构建期，另一半也一起，省得两处口径分裂。
 */
import { defineLoader } from "vitepress";
import {
  SERIES,
  computeBlogStats,
  loadBlogPosts,
  type BlogPost,
  type BlogStats,
} from "../blog-meta";

/** 列表页/文章页要用的全部构建期数据 */
export interface BlogData {
  posts: BlogPost[];
  stats: BlogStats;
  /** 受控系列词表，只保留**已有文章**的系列，并带上文章数 */
  series: { name: string; blurb: string; count: number }[];
}

declare const data: BlogData;
export { data };

export default defineLoader({
  watch: ["../../blog/*.md"],
  load(): BlogData {
    const posts = loadBlogPosts();
    return {
      posts,
      stats: computeBlogStats(posts),
      // 只输出有文章的系列：规划里登记了 6 个，已发布只覆盖其中一部分。
      // 把空系列也渲染成筛选按钮，点了必然是空列表——一个永远筛不出东西的按钮
      // 比没有这个按钮更糟。顺序沿用 SERIES 的 order（不按文章数排，见 blog-meta.ts）。
      series: SERIES.filter((s) => posts.some((p) => p.series === s.name)).map((s) => ({
        name: s.name,
        blurb: s.blurb,
        count: posts.filter((p) => p.series === s.name).length,
      })),
    };
  },
});
