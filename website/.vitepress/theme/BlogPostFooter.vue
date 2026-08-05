<script setup lang="ts">
/**
 * 文章页脚 —— **整个底部只有这一块**（挂 doc-footer-before，只在 /blog/ 的文章页渲染）。
 *
 * ── 为什么合并成一个组件 ──
 *   这里曾经是三块独立区域叠在一起：元信息盒 + 系列导航双卡 + 「相关文章」列表，
 *   下面还跟着默认主题的「最后更新」和「上一页/下一页」双卡。五块。
 *   问题不只是长，是**同一个目标出现三次**：只有两篇文章时，
 *   系列上一篇、相关文章、默认 pager 的「下一页」全都指向同一个 URL——
 *   读者面对三个视觉权重相当的框，不知道该点哪个，而点哪个都一样。
 *   现在合成一块：一行元信息 + 最多两条「继续读」链接，按 url 去重。
 *
 * ── 为什么元信息在正文之后而不是标题下方 ──
 *   日期/时长这些在 /blog/ 列表页卡片上已经出现过，读者是看过卡片才点进来的。
 *   压在标题正下方等于让人在读第一句正文前先扫一遍已知信息，破坏沉浸感。
 *   放在正文之后它变成"读完了，这是这篇的坐标"，是补充而非拦路。
 *   历史：原 BlogMeta.vue 挂 doc-before，2026-08-05 下移并与 BlogRelated 合并。
 *
 * ── 为什么挂 doc-after 而不是 doc-footer-before ──
 *   doc-footer-before 在 VPDocFooter **内部**，而整个 VPDocFooter 挂在
 *   `v-if="showFooter"`（= editLink || lastUpdated || prev || next）上。
 *   下面说的那两块一关，这四项在文章页全为假，footer 连带插槽一起不渲染——
 *   实测挂 doc-footer-before 时文章底部整块消失。doc-after 在 footer 之外、
 *   无条件渲染；文章页既然已经没有 pager，也就不存在"掉到页脚导航下面"的问题。
 *
 * ── 默认主题的「最后更新」与「上一页/下一页」去哪了 ──
 *   在 config.ts 的 transformPageData 里按路径关掉了（仅 /blog/ 文章页）：
 *   「最后更新」与这里的发布日期是同一件事的两种口径，并列显示只会让人疑惑哪个算；
 *   pager 走 sidebar 的**日期倒序**，它的"下一页"其实是更旧的一篇，
 *   与本组件按阅读顺序算的"系列下一篇"方向相反——两者并存必然有一个在骗人。
 *
 * ── 数据为什么不在前端算 ──
 *   阅读时长/系列/相关都取构建期结果：前端拿不到 markdown 源（只有渲染后的 DOM），
 *   口径会和列表页不一致。系列顺序尤其不能靠 sidebar 推——见上一段。
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

const post = computed(() => {
  const path = route.path.replace(/\.html$/, "").replace(/\/$/, "");
  return blog.posts.find((p) => p.url === path) ?? null;
});

const date = computed<string>(() => frontmatter.value?.date ?? "");

/**
 * 「继续读」——系列内的前后篇与相关文章**合并去重**后的一个列表。
 *
 * 顺序即优先级：系列下一篇（读者正在走的那条路的下一步）→ 系列上一篇
 * → 其它相关文章。按 url 去重是这次合并的核心：两篇文章的站点里，
 * 系列邻篇和"相关文章"必然是同一篇，不去重就是把一条链接说三遍。
 * 截到 2 条——底部的作用是给一个出口，不是再放一个列表页。
 */
const continueReading = computed(() => {
  const p = post.value;
  if (!p) return [];
  const out: { url: string; title: string; label: string }[] = [];
  const seen = new Set<string>();
  const push = (
    item: { url: string; title: string } | null,
    label: string,
  ) => {
    if (!item || seen.has(item.url)) return;
    seen.add(item.url);
    out.push({ url: item.url, title: item.title, label });
  };

  push(p.seriesNext, "系列下一篇");
  push(p.seriesPrev, "系列上一篇");
  for (const r of p.related) push(r, r.reason);

  return out.slice(0, 2);
});

function formatDate(iso: string): string {
  const m = String(iso).match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return String(iso);
  return `${m[1]} 年 ${Number(m[2])} 月 ${Number(m[3])} 日`;
}
</script>

<template>
  <div v-if="isPost && post" class="pf">
    <!--
      一行元信息。系列序号留着（2/2 这种进度感在文末有用），
      标签与「N 处源码引证」不留：前者在列表页可点可筛，这里点不了；
      后者是挑文章时的可信度信号，读完之后已经由正文本身兑现了。
    -->
    <p class="pf-meta">
      <span v-if="post.series" class="pf-series">
        {{ post.series }}
        <span v-if="post.seriesTotal > 1">{{ post.seriesIndex }}/{{ post.seriesTotal }}</span>
      </span>
      <span v-if="post.series && date" class="pf-sep" aria-hidden="true">·</span>
      <time v-if="date" :datetime="date">{{ formatDate(date) }}</time>
      <template v-if="date && post.readingMinutes">
        <span class="pf-sep" aria-hidden="true">·</span>
      </template>
      <span v-if="post.readingMinutes">约 {{ post.readingMinutes }} 分钟读完</span>
    </p>

    <!-- 继续读：纯文本行，不用卡片。卡片会把它抬到与正文同级的视觉权重上去 -->
    <ul v-if="continueReading.length" class="pf-next">
      <li v-for="c in continueReading" :key="c.url">
        <a :href="c.url">
          <span class="pf-label">{{ c.label }}</span>
          <span class="pf-title">{{ c.title }}</span>
        </a>
      </li>
    </ul>
  </div>
</template>

<style scoped>
.pf {
  margin: 40px 0 0;
  padding-top: 18px;
  border-top: 1px solid var(--vp-c-divider);
}
.pf-meta {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 7px;
  margin: 0 !important;
  font-family: var(--vp-font-family-mono);
  font-size: 12.5px;
  line-height: 1.6;
  color: var(--vp-c-text-3);
}
.pf-series {
  display: inline-flex;
  gap: 5px;
  color: var(--vp-c-text-2);
}
.pf-sep {
  color: var(--vp-c-divider);
}

.pf-next {
  list-style: none;
  margin: 12px 0 0 !important;
  padding: 0 !important;
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.pf-next li {
  margin: 0 !important;
  padding: 0 !important;
}
.pf-next a {
  display: flex;
  align-items: baseline;
  gap: 10px;
  font-weight: 400;
  text-decoration: none !important;
}
.pf-next a:hover .pf-title {
  text-decoration: underline;
}
/* 方向/理由标签固定宽度，让多行的标题左边缘对齐成一列 */
.pf-label {
  flex: none;
  min-width: 6.5em;
  font-family: var(--vp-font-family-mono);
  font-size: 11.5px;
  color: var(--vp-c-text-3);
}
.pf-title {
  font-size: 14px;
  line-height: 1.6;
  color: var(--vp-c-brand-1);
}

@media (max-width: 640px) {
  .pf-next a {
    flex-direction: column;
    gap: 2px;
  }
  .pf-label {
    min-width: 0;
  }
}
</style>
