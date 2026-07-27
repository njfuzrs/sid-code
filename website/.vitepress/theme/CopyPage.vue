<script setup lang="ts">
/**
 * T-3.11「复制整页」按钮。
 *
 * 复制的是**原始 markdown 源文**，不是渲染后的 HTML/innerText。
 * 理由：用户复制整页的真实目的是贴给 agent（§4.2.4 实测 CC 官方文档也是这么做的），
 * markdown 才是 agent 友好的形态——表格结构完整、无样式噪音、代码块边界清晰。
 *
 * 数据由 config.ts 的 transformPageData 在构建期注入 frontmatter.rawMarkdown，
 * 前端零请求。拿不到数据（虚拟页 / 读文件失败）则整个按钮不渲染，
 * 而不是渲染一个点了没反应的按钮。
 */
import { computed, ref } from "vue";
import { useData } from "vitepress";

const { page, frontmatter } = useData();

const raw = computed<string>(() => frontmatter.value?.rawMarkdown ?? "");
const state = ref<"idle" | "done" | "fail">("idle");

const label = computed(() =>
  state.value === "done" ? "已复制" : state.value === "fail" ? "复制失败" : "复制整页",
);

async function copy() {
  const text = raw.value;
  if (!text) return;
  try {
    // navigator.clipboard 需要安全上下文（https 或 localhost）。当前站点是 IP + http
    // 部署（备案后才上域名/证书），所以必须保留 execCommand 回退，否则线上点了没反应。
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
    } else {
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.setAttribute("readonly", "");
      // 不用 display:none —— 那样选不中，execCommand 会失败
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      ta.style.top = "0";
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand("copy");
      document.body.removeChild(ta);
      if (!ok) throw new Error("execCommand copy 返回 false");
    }
    state.value = "done";
  } catch {
    state.value = "fail";
  }
  setTimeout(() => (state.value = "idle"), 2000);
}
</script>

<template>
  <button
    v-if="raw"
    class="copy-page"
    type="button"
    :data-state="state"
    :title="`复制本页 markdown 源文（${raw.length} 字符），可直接贴给 AI`"
    :aria-label="`复制整页 markdown 源文：${page.title}`"
    @click="copy"
  >
    <span aria-hidden="true">{{ state === "done" ? "✓" : "⧉" }}</span>
    {{ label }}
  </button>
</template>

<style scoped>
.copy-page {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  margin-bottom: 20px;
  padding: 4px 12px;
  border: 1px solid var(--vp-c-divider);
  border-radius: 6px;
  background: var(--vp-c-bg-soft);
  color: var(--vp-c-text-2);
  font-size: 13px;
  line-height: 22px;
  cursor: pointer;
  transition:
    color 0.2s,
    border-color 0.2s;
}

.copy-page:hover {
  color: var(--vp-c-brand-1);
  border-color: var(--vp-c-brand-1);
}

/* 键盘可达：焦点态必须可见（依赖 hover 的按钮对键盘用户等于不存在） */
.copy-page:focus-visible {
  outline: 2px solid var(--vp-c-brand-1);
  outline-offset: 2px;
}

.copy-page[data-state="done"] {
  color: var(--vp-c-brand-1);
  border-color: var(--vp-c-brand-1);
}

.copy-page[data-state="fail"] {
  color: var(--vp-c-danger-1);
  border-color: var(--vp-c-danger-1);
}
</style>
