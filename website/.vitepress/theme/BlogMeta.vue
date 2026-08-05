<script setup lang="ts">
/**
 * 文章页顶部的元信息行 + 系列导航（挂在 doc-before 插槽）。
 *
 * ── 为什么不写进每篇 markdown ──
 *   写进正文等于每篇都要手抄一遍格式，且阅读时长得人工估。这里从 frontmatter
 *   （date/tags）+ 构建期算好的 readingMinutes / series 自动渲染，作者只需在
 *   frontmatter 写 date、series、tags 几个字段。
 *
 * ── 只在 /blog/ 下渲染 ──
 *   通过 v-if 判路径。挂载点是默认主题的 doc-before 插槽（与 CopyPage 同一个），
 *   文档页不该出现"约 N 分钟"这种博客语义的东西。
 *   注意排除 /blog/ 列表页自身：那页没有 date，渲染出来是一行空壳。
 *
 * ── 系列导航为什么不能靠默认主题的 prev/next ──
 *   默认 docFooter 的上一页/下一页走 sidebar 顺序，而 sidebar 是**日期倒序**
 *   （见 config.ts 的 BLOG_SIDEBAR）。也就是说默认的"下一页"其实是**上一篇更旧的**，
 *   与"系列里的下一篇"方向相反。系列是有阅读顺序的（前置知识在前），
 *   必须单独按 series 内的日期升序算，数据来自 blog-meta.ts 的 seriesPrev/seriesNext。
 */
import { computed } from "vue";
import { useData, useRoute } from "vitepress";
import { data as blog } from "./blog.data";

const { frontmatter } = useData();
const route = useRoute();

/** 是否是一篇文章（在 /blog/ 下，且不是列表页本身） */
const isPost = computed(() => {
  const p = route.path;
  return p.startsWith("/blog/") && p !== "/blog/" && p !== "/blog";
});

/**
 * 当前文章的构建期元数据（按 url 取）。
 *
 * 阅读时长/系列/引证数都不在前端重算：前端拿不到 markdown 源（只有渲染后的 DOM），
 * 口径会和列表页不一致；引证数还需要校验仓库里文件是否存在，那只有构建期做得到。
 */
const post = computed(() => {
  const path = route.path.replace(/\.html$/, "").replace(/\/$/, "");
  return blog.posts.find((p) => p.url === path) ?? null;
});

const readingMinutes = computed(() => post.value?.readingMinutes ?? 0);
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
    <!-- ── 元信息行 ── -->
    <div class="bm-row">
      <a v-if="post?.series" class="bm-badge" href="/blog/" :title="`查看${post.series}系列全部文章`">
        {{ post.series }}
        <span v-if="post.seriesTotal > 1" class="bm-seq">
          {{ post.seriesIndex }}/{{ post.seriesTotal }}
        </span>
      </a>
      <time v-if="date" class="bm-date" :datetime="date">{{ formatDate(date) }}</time>
      <template v-if="date && readingMinutes">
        <span class="bm-sep" aria-hidden="true">·</span>
      </template>
      <span v-if="readingMinutes" class="bm-read">约 {{ readingMinutes }} 分钟读完</span>
      <template v-if="post?.evidenceFiles">
        <span class="bm-sep" aria-hidden="true">·</span>
        <span class="bm-ev" title="本文引用、且经存在性校验的源码文件数（去重）">
          {{ post.evidenceFiles }} 处源码引证
        </span>
      </template>
      <span v-if="tags.length" class="bm-tags">
        <span v-for="t in tags" :key="t" class="bm-tag">{{ t }}</span>
      </span>
    </div>

    <!--
      系列内的上一篇/下一篇。只在系列有多篇时渲染——单篇系列显示一条
      "第 1 篇 / 共 1 篇"且两侧都没有链接的导航条，是纯噪音。
    -->
    <nav
      v-if="post && post.seriesTotal > 1 && (post.seriesPrev || post.seriesNext)"
      class="bm-nav"
      :aria-label="`${post.series}系列内导航`"
    >
      <a v-if="post.seriesPrev" class="bm-nav-item" :href="post.seriesPrev.url">
        <span class="bm-nav-label">← 系列上一篇</span>
        <span class="bm-nav-title">{{ post.seriesPrev.title }}</span>
      </a>
      <a
        v-if="post.seriesNext"
        class="bm-nav-item bm-nav-next"
        :href="post.seriesNext.url"
      >
        <span class="bm-nav-label">系列下一篇 →</span>
        <span class="bm-nav-title">{{ post.seriesNext.title }}</span>
      </a>
    </nav>
  </div>
</template>

<style scoped>
.bm {
  margin: -6px 0 22px;
}
.bm-row {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px;
  padding-bottom: 14px;
  border-bottom: 1px solid var(--vp-c-divider);
  font-size: 13px;
  color: var(--vp-c-text-3);
}
.bm-badge {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 1px 9px;
  border-radius: 6px;
  background: var(--vp-c-brand-soft);
  color: var(--vp-c-brand-1) !important;
  font-size: 11.5px;
  font-weight: 600;
  text-decoration: none !important;
}
.bm-seq {
  font-family: var(--vp-font-family-mono);
  font-weight: 400;
  opacity: 0.75;
}
.bm-date,
.bm-read,
.bm-ev {
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
  border-radius: 8px;
  border: 1px solid var(--vp-c-divider);
  background: var(--vp-c-bg-soft);
  color: var(--vp-c-text-3);
  font-size: 11.5px;
}

/* ── 系列导航 ── */
.bm-nav {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
  margin-top: 14px;
}
.bm-nav-item {
  flex: 1 1 220px;
  display: flex;
  flex-direction: column;
  gap: 3px;
  padding: 10px 14px;
  border: 1px solid var(--vp-c-divider);
  border-radius: 10px;
  background: var(--vp-c-bg-soft);
  text-decoration: none !important;
  transition:
    border-color 0.2s,
    background 0.2s;
}
.bm-nav-item:hover {
  border-color: var(--vp-c-brand-1);
  background: var(--vp-c-bg);
}
/* 只有一侧存在时也不该占满整行的一半，靠右对齐让方向感成立 */
.bm-nav-next {
  align-items: flex-end;
  text-align: right;
  margin-left: auto;
}
.bm-nav-label {
  font-family: var(--vp-font-family-mono);
  font-size: 11px;
  color: var(--vp-c-text-3);
}
.bm-nav-title {
  font-size: 13.5px;
  line-height: 1.5;
  color: var(--vp-c-brand-1);
}

@media (prefers-reduced-motion: reduce) {
  .bm-nav-item {
    transition: none;
  }
}

@media (max-width: 640px) {
  .bm-tags {
    margin-left: 0;
  }
  .bm-nav-next {
    align-items: flex-start;
    text-align: left;
    margin-left: 0;
  }
}
</style>
