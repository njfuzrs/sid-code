<script setup lang="ts">
/**
 * /blog/ 列表页。
 *
 * ── 视觉约束（与 Changelog.vue 同一套纪律）──
 *   全部颜色走 brand.css 的 --sid-* / --vp-* 变量，不内联任何十六进制色值。
 *   内联色值是"官网和某个页面像两个产品"的根因，也让深浅色模式必然有一边不对。
 *
 * ── 为什么列表是构建期数据而不是运行时 fetch ──
 *   数据来自 blog.data.ts（构建期 load），烧进产物。浏览器零请求、无白屏。
 *   代价是新增文章要重新构建站点——而文章本来就是随站点一起发布的，没有额外负担。
 *
 * ── 标签筛选为什么不做成路由 ──
 *   标签是纯客户端的轻量收窄（当前文章量级下就是几条），做成 /blog/tag/xxx 需要
 *   为每个标签生成一个静态页，且标签改名会留下死链。ref 内存态足够，且不产生 URL 垃圾。
 */
import { computed, ref } from "vue";
import { data as posts } from "./blog.data";

/** 当前只看某个标签（null = 全部）。点一下筛选，再点取消。 */
const activeTag = ref<string | null>(null);

/** 全部标签及其文章数，按文章数倒序（多的在前，更可能是读者想找的主题） */
const tags = computed(() => {
  const m = new Map<string, number>();
  for (const p of posts) {
    for (const t of p.tags) m.set(t, (m.get(t) ?? 0) + 1);
  }
  return [...m.entries()]
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
});

const filtered = computed(() =>
  activeTag.value ? posts.filter((p) => p.tags.includes(activeTag.value!)) : posts,
);

function toggleTag(t: string) {
  activeTag.value = activeTag.value === t ? null : t;
}

/** 2026-07-31 → 2026 年 7 月 31 日；无日期则不显示日期块 */
function formatDate(iso: string): string {
  const m = iso.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return iso;
  return `${m[1]} 年 ${Number(m[2])} 月 ${Number(m[3])} 日`;
}
</script>

<template>
  <div class="bi">
    <!-- 标签筛选：只有存在标签时才渲染，避免留一条空工具栏 -->
    <div v-if="tags.length" class="bi-tags" role="group" aria-label="按标签筛选文章">
      <button
        type="button"
        class="bi-tag"
        :class="{ 'is-active': activeTag === null }"
        :aria-pressed="activeTag === null"
        @click="activeTag = null"
      >
        全部<i>{{ posts.length }}</i>
      </button>
      <button
        v-for="t in tags"
        :key="t.name"
        type="button"
        class="bi-tag"
        :class="{ 'is-active': activeTag === t.name }"
        :aria-pressed="activeTag === t.name"
        @click="toggleTag(t.name)"
      >
        {{ t.name }}<i>{{ t.count }}</i>
      </button>
    </div>

    <p v-if="!posts.length" class="bi-empty">还没有文章。</p>
    <p v-else-if="!filtered.length" class="bi-empty">
      没有带这个标签的文章。
      <button type="button" class="bi-link" @click="activeTag = null">看全部</button>
    </p>

    <!-- 文章卡片：整块可点（a 包住全部内容），不做"标题是链接、卡片其余部分不是"那种半可点 -->
    <ul class="bi-list">
      <li v-for="p in filtered" :key="p.url" class="bi-item">
        <a class="bi-card" :href="p.url">
          <h2 class="bi-title">{{ p.title }}</h2>
          <p v-if="p.description" class="bi-desc">{{ p.description }}</p>
          <div class="bi-foot">
            <time v-if="p.date" class="bi-date" :datetime="p.date">{{ formatDate(p.date) }}</time>
            <span class="bi-dot" aria-hidden="true">·</span>
            <span class="bi-read">约 {{ p.readingMinutes }} 分钟</span>
            <span v-if="p.tags.length" class="bi-chips">
              <span v-for="t in p.tags" :key="t" class="bi-chip">{{ t }}</span>
            </span>
          </div>
        </a>
      </li>
    </ul>
  </div>
</template>

<style scoped>
.bi {
  margin-top: 8px;
}

/* ── 标签筛选 ── */
.bi-tags {
  display: flex;
  flex-wrap: wrap;
  gap: 7px;
  margin-bottom: 26px;
}
.bi-tag {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 3px 12px;
  border: 1px solid var(--vp-c-divider);
  border-radius: 999px;
  background: var(--vp-c-bg-soft);
  color: var(--vp-c-text-2);
  font-size: 12.5px;
  cursor: pointer;
  transition:
    color 0.15s,
    border-color 0.15s,
    background 0.15s;
}
.bi-tag i {
  font-family: var(--vp-font-family-mono);
  font-style: normal;
  font-size: 11px;
  color: var(--vp-c-text-3);
}
.bi-tag:hover {
  border-color: var(--vp-c-brand-1);
  color: var(--vp-c-brand-1);
}
/* 选中态不只靠颜色：加粗 + 实心底，色觉障碍用户也能分辨 */
.bi-tag.is-active {
  background: var(--vp-c-brand-soft);
  border-color: var(--vp-c-brand-1);
  color: var(--vp-c-brand-1);
  font-weight: 600;
}
.bi-tag.is-active i {
  color: var(--vp-c-brand-1);
}
.bi-tag:focus-visible,
.bi-link:focus-visible {
  outline: 2px solid var(--vp-c-brand-1);
  outline-offset: 2px;
}

/* ── 文章列表 ── */
.bi-list {
  list-style: none;
  margin: 0 !important;
  padding: 0 !important;
}
.bi-item {
  margin: 0 0 14px !important;
  padding: 0 !important;
}

.bi-card {
  display: block;
  padding: 20px 22px;
  border: 1px solid var(--vp-c-divider);
  border-radius: 12px;
  background: var(--vp-c-bg);
  text-decoration: none !important;
  transition:
    border-color 0.2s,
    background 0.2s,
    transform 0.2s;
}
.bi-card:hover {
  border-color: var(--vp-c-brand-1);
  background: var(--vp-c-bg-soft);
  transform: translateY(-1px);
}
.bi-card:focus-visible {
  outline: 2px solid var(--vp-c-brand-1);
  outline-offset: 2px;
}

/* 覆盖 vp-doc 给 h2 的上边距与下分隔线：这里的 h2 是卡片标题，不是章节标题 */
.bi-title {
  margin: 0 !important;
  padding: 0 !important;
  border: 0 !important;
  font-size: 19px;
  font-weight: 600;
  line-height: 1.5;
  color: var(--vp-c-text-1);
  transition: color 0.2s;
}
.bi-card:hover .bi-title {
  color: var(--vp-c-brand-1);
}

.bi-desc {
  margin: 9px 0 0 !important;
  font-size: 14px;
  line-height: 1.7;
  color: var(--vp-c-text-2);
}

.bi-foot {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px;
  margin-top: 14px;
  font-size: 12.5px;
  color: var(--vp-c-text-3);
}
.bi-date,
.bi-read {
  font-family: var(--vp-font-family-mono);
}
.bi-dot {
  color: var(--vp-c-divider);
}
.bi-chips {
  display: inline-flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-left: auto;
}
.bi-chip {
  padding: 1px 9px;
  border-radius: 6px;
  border: 1px solid var(--vp-c-divider);
  background: var(--vp-c-bg-soft);
  color: var(--vp-c-text-3);
  font-size: 11.5px;
}

.bi-empty {
  padding: 22px 0;
  color: var(--vp-c-text-3);
  font-size: 14px;
}
.bi-link {
  padding: 1px 8px;
  border: 1px solid var(--vp-c-divider);
  border-radius: 6px;
  background: var(--vp-c-bg-soft);
  color: var(--vp-c-text-2);
  font-size: inherit;
  cursor: pointer;
}
.bi-link:hover {
  color: var(--vp-c-brand-1);
  border-color: var(--vp-c-brand-1);
}

@media (prefers-reduced-motion: reduce) {
  .bi-card,
  .bi-title,
  .bi-tag {
    transition: none;
  }
  .bi-card:hover {
    transform: none;
  }
}

@media (max-width: 640px) {
  .bi-card {
    padding: 16px 16px;
  }
  .bi-chips {
    margin-left: 0;
  }
}
</style>
