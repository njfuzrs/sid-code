<script setup lang="ts">
/**
 * 文章页顶部的元信息行（日期 · 阅读时长 · 标签）。
 *
 * ── 为什么不写进每篇 markdown ──
 *   写进正文等于每篇都要手抄一遍格式，且阅读时长得人工估。这里从 frontmatter
 *   （date/tags）+ 构建期算好的 readingMinutes 自动渲染，作者只需在 frontmatter
 *   写 date 与 tags 两个字段。
 *
 * ── 只在 /blog/ 下渲染 ──
 *   通过 v-if 判路径。挂载点是默认主题的 doc-before 插槽（与 CopyPage 同一个），
 *   文档页不该出现"约 N 分钟"这种博客语义的东西。
 *   注意排除 /blog/ 列表页自身：那页没有 date，渲染出来是一行空壳。
 */
import { computed } from "vue";
import { useData, useRoute } from "vitepress";
import { data as posts } from "./blog.data";

const { frontmatter } = useData();
const route = useRoute();

/** 是否是一篇文章（在 /blog/ 下，且不是列表页本身） */
const isPost = computed(() => {
  const p = route.path;
  return p.startsWith("/blog/") && p !== "/blog/" && p !== "/blog";
});

/**
 * 阅读时长从构建期数据里按 url 取，不在前端重算。
 * 前端重算拿不到 markdown 源（只有渲染后的 DOM），口径会和列表页不一致。
 */
const readingMinutes = computed(() => {
  const path = route.path.replace(/\.html$/, "").replace(/\/$/, "");
  return posts.find((p) => p.url === path)?.readingMinutes ?? 0;
});

const date = computed<string>(() => frontmatter.value?.date ?? "");
const tags = computed<string[]>(() =>
  Array.isArray(frontmatter.value?.tags) ? frontmatter.value.tags : [],
);

function formatDate(iso: string): string {
  const m = String(iso).match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return String(iso);
  return `${m[1]} 年 ${Number(m[2])} 月 ${Number(m[3])} 日`;
}
</script>

<template>
  <div v-if="isPost && (date || readingMinutes)" class="bm">
    <time v-if="date" class="bm-date" :datetime="date">{{ formatDate(date) }}</time>
    <template v-if="date && readingMinutes">
      <span class="bm-sep" aria-hidden="true">·</span>
    </template>
    <span v-if="readingMinutes" class="bm-read">约 {{ readingMinutes }} 分钟读完</span>
    <span v-if="tags.length" class="bm-tags">
      <span v-for="t in tags" :key="t" class="bm-tag">{{ t }}</span>
    </span>
  </div>
</template>

<style scoped>
.bm {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px;
  margin: -6px 0 22px;
  padding-bottom: 14px;
  border-bottom: 1px solid var(--vp-c-divider);
  font-size: 13px;
  color: var(--vp-c-text-3);
}
.bm-date,
.bm-read {
  font-family: var(--vp-font-family-mono);
}
.bm-sep {
  color: var(--vp-c-divider);
}
.bm-tags {
  display: inline-flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-left: auto;
}
.bm-tag {
  padding: 1px 9px;
  border-radius: 6px;
  border: 1px solid var(--vp-c-divider);
  background: var(--vp-c-bg-soft);
  color: var(--vp-c-text-3);
  font-size: 11.5px;
}

@media (max-width: 640px) {
  .bm-tags {
    margin-left: 0;
  }
}
</style>
