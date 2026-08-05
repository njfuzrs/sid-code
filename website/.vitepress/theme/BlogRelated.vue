<script setup lang="ts">
/**
 * 文章末尾的「相关文章」（挂在 doc-after 插槽，只在 /blog/ 的文章页渲染）。
 *
 * ── 为什么挂 doc-after 而不是 doc-footer-before ──
 *   doc-footer-before 在默认主题的上一页/下一页**之上**。相关文章比"站点顺序里的
 *   相邻页"更贴近读者此刻的意图（他刚读完一个主题），应该排在更靠前的位置；
 *   但它又必须在正文之后。doc-after 正好是"正文结束、页脚导航之前"这个位置。
 *
 * ── 排序口径 ──
 *   同系列优先，其次按共享标签数。完整算法与"为什么不做语义相似度"写在
 *   blog-meta.ts 的 computeRelated 里，这里只渲染。
 *
 * ── 为什么整块可能不渲染 ──
 *   只有一篇文章时没有任何相关项，渲染出一个空标题比不渲染更差。
 */
import { computed } from "vue";
import { useRoute } from "vitepress";
import { data as blog } from "./blog.data";

const route = useRoute();

const isPost = computed(() => {
  const p = route.path;
  return p.startsWith("/blog/") && p !== "/blog/" && p !== "/blog";
});

const post = computed(() => {
  const path = route.path.replace(/\.html$/, "").replace(/\/$/, "");
  return blog.posts.find((p) => p.url === path) ?? null;
});

const related = computed(() => post.value?.related ?? []);
</script>

<template>
  <aside v-if="isPost && related.length" class="br" aria-labelledby="br-h">
    <h2 id="br-h" class="br-h">相关文章</h2>
    <ul class="br-list">
      <li v-for="r in related" :key="r.url" class="br-item">
        <a class="br-link" :href="r.url">
          <span class="br-title">{{ r.title }}</span>
          <span class="br-reason">{{ r.reason }}</span>
        </a>
      </li>
    </ul>
  </aside>
</template>

<style scoped>
.br {
  margin: 36px 0 0;
  padding-top: 20px;
  border-top: 1px solid var(--vp-c-divider);
}
/* 用 h2 是为了语义（它是文章后的一个区块标题），但不要 vp-doc 给 h2 的大字号与分隔线 */
.br-h {
  margin: 0 0 12px !important;
  padding: 0 !important;
  border: 0 !important;
  font-size: 14px;
  font-weight: 600;
  letter-spacing: 0.02em;
  color: var(--vp-c-text-2);
}
.br-list {
  list-style: none;
  margin: 0 !important;
  padding: 0 !important;
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.br-item {
  margin: 0 !important;
  padding: 0 !important;
}
.br-link {
  display: flex;
  align-items: baseline;
  gap: 10px;
  padding: 10px 14px;
  border: 1px solid var(--vp-c-divider);
  border-radius: 10px;
  background: var(--vp-c-bg-soft);
  text-decoration: none !important;
  transition:
    border-color 0.2s,
    background 0.2s;
}
.br-link:hover {
  border-color: var(--vp-c-brand-1);
  background: var(--vp-c-bg);
}
.br-title {
  flex: 1;
  font-size: 14px;
  line-height: 1.6;
  color: var(--vp-c-brand-1);
}
/* 「为什么推这条」说出来：不写理由的推荐位读者无从判断值不值得点 */
.br-reason {
  flex: none;
  font-family: var(--vp-font-family-mono);
  font-size: 11px;
  color: var(--vp-c-text-3);
}

@media (prefers-reduced-motion: reduce) {
  .br-link {
    transition: none;
  }
}

@media (max-width: 640px) {
  .br-link {
    flex-direction: column;
    gap: 3px;
  }
}
</style>
