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
 * ── 筛选为什么按 series 而不按 tags ──
 *   tags 是自由词，做筛选器会随文章数膨胀（实测 2 篇文章已产出 5 个标签，其中
 *   没有一个能有效收窄：3 个只对应 1 篇、2 个对应全部）。series 是受控词表，
 *   个数由内容规划决定而不是由文章数决定。完整论证在 blog-meta.ts 的 SERIES 注释里。
 *
 * ── 筛选为什么不做成路由 ──
 *   做成 /blog/series/xxx 需要为每个系列生成一个静态页，且系列改名会留下死链。
 *   ref 内存态足够，且不产生 URL 垃圾。
 *
 * ── 布局为什么分「特色大卡 + 紧凑列表」两层 ──
 *   平铺等宽卡片在文章数上去后会变成一堵没有重点的墙。第一篇（最新，或人工标
 *   featured）用大卡承载更多信息，其余用紧凑条目。文章数 ≤2 时不分层——
 *   2 篇里挑 1 篇当"特色"，剩下那 1 篇会显得像被降级了。
 */
import { computed, ref } from "vue";
import { data as blog } from "./blog.data";

const posts = computed(() => blog.posts);
const seriesList = computed(() => blog.series);

/** 当前只看某个系列（null = 全部）。点一下筛选，再点取消。 */
const activeSeries = ref<string | null>(null);

/** 本页搜索关键词（只搜标题/摘要/系列/标签/highlight，不搜正文——正文由全站搜索负责） */
const query = ref("");

/**
 * 筛选器是否显示。
 *
 * 门槛：至少 2 个系列、至少 4 篇文章。任一不满足就整条不渲染。
 * 理由：只有 1 个系列时那个按钮等价于「全部」；文章太少时任何收窄都等于直接点文章。
 * 用门槛而不是"等以后想起来再加"——量级到了自动出现，不需要回来改代码。
 */
const showFilter = computed(() => seriesList.value.length >= 2 && posts.value.length >= 4);

/** 搜索框是否显示：文章少于 6 篇时肉眼扫比打字快 */
const showSearch = computed(() => posts.value.length >= 6);

/** 是否启用「特色大卡 + 紧凑列表」双层结构，见顶部说明 */
const useFeatured = computed(() => posts.value.length >= 3);

function haystack(p: (typeof blog.posts)[number]): string {
  return [p.title, p.description, p.highlight, p.series, ...p.tags].join(" ").toLowerCase();
}

const filtered = computed(() => {
  const terms = query.value.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const s = activeSeries.value;
  return posts.value.filter((p) => {
    if (s && p.series !== s) return false;
    if (!terms.length) return true;
    const hay = haystack(p);
    // 多词之间是 AND：搜「cache 实测」应当两个词都命中，而不是命中任一
    return terms.every((t) => hay.includes(t));
  });
});

const isFiltering = computed(() => !!activeSeries.value || !!query.value.trim());

/** 特色文章：只在未筛选且文章数够时启用，筛选结果里不该有"特色"这个概念 */
const featured = computed(() =>
  useFeatured.value && !isFiltering.value
    ? (filtered.value.find((p) => p.featured) ?? filtered.value[0] ?? null)
    : null,
);

/** 除特色文章之外的其余条目 */
const rest = computed(() =>
  featured.value ? filtered.value.filter((p) => p.url !== featured.value!.url) : filtered.value,
);

/** 当前选中系列的一句话说明，筛选后显示 */
const activeBlurb = computed(
  () => seriesList.value.find((s) => s.name === activeSeries.value)?.blurb ?? "",
);

function toggleSeries(name: string) {
  activeSeries.value = activeSeries.value === name ? null : name;
}

function reset() {
  activeSeries.value = null;
  query.value = "";
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
    <!--
      这里曾有一条四格统计条（篇文章 / 分钟读完全部 / 个系列 / 处源码引证）。删掉了。

      删的理由是它服务的是作者的自豪感，不是读者的下一步动作。读者进这一页只有
      一个目的：挑一篇文章读。而"2 篇文章""1 个系列"这种量级下的聚合数字不参与
      这个决定 —— 站内只有 2 篇时"2 篇文章"是句废话，"33 分钟读完全部"更是把
      一个没人会执行的动作（一次读完全站）摆成了主要指标。

      每篇文章自己的时长与引证数仍然在**卡片上**（.bi-foot 那一行）。那里有用：
      它回答"这一篇现在值不值得点"，是逐篇的决策依据，不是全站的规模炫耀。

      量级上来后想再加，判据不是"数字变大了"，而是"这个数字能改变读者点哪一篇"。
    -->

    <!-- ── 筛选区：系列按钮 + 可选搜索框；门槛不到不渲染，避免留一条无用工具栏 ── -->
    <div v-if="showFilter || showSearch" class="bi-filter">
      <div v-if="showSearch" class="bi-search">
        <input
          v-model="query"
          type="search"
          class="bi-input"
          placeholder="在文章标题、摘要、标签里搜索…"
          aria-label="在博客文章里搜索"
          autocomplete="off"
        />
      </div>

      <div v-if="showFilter" class="bi-chips" role="group" aria-label="按系列筛选文章">
        <button
          type="button"
          class="bi-chip"
          :class="{ 'is-active': activeSeries === null }"
          :aria-pressed="activeSeries === null"
          @click="activeSeries = null"
        >
          全部<span class="bi-n">{{ posts.length }}</span>
        </button>
        <button
          v-for="s in seriesList"
          :key="s.name"
          type="button"
          class="bi-chip"
          :class="{ 'is-active': activeSeries === s.name }"
          :aria-pressed="activeSeries === s.name"
          @click="toggleSeries(s.name)"
        >
          {{ s.name }}<span class="bi-n">{{ s.count }}</span>
        </button>
        <button v-if="isFiltering" type="button" class="bi-clear" @click="reset">清除</button>
      </div>

      <p v-if="activeBlurb" class="bi-blurb">{{ activeBlurb }}</p>
    </div>

    <!--
      筛选结果播报：aria-live 让屏幕阅读器用户知道点了按钮之后剩几条。
      纯视觉用户从列表本身就能看出来，所以这一行对他们隐藏（sr-only），
      不占版面也不重复信息。
    -->
    <p class="bi-sr" role="status" aria-live="polite">
      {{ isFiltering ? `筛选后共 ${filtered.length} 篇文章` : `共 ${posts.length} 篇文章` }}
    </p>

    <p v-if="!posts.length" class="bi-empty">还没有文章。</p>
    <p v-else-if="!filtered.length" class="bi-empty">
      没有匹配的文章。
      <button type="button" class="bi-link" @click="reset">清除筛选</button>
    </p>

    <!-- ── 特色文章：大卡，摘要给足，硬数据摆在标题下方 ── -->
    <article v-if="featured" class="bi-hero">
      <a class="bi-hero-link" :href="featured.url">
        <span class="bi-kicker">
          <span v-if="featured.series" class="bi-badge">{{ featured.series }}</span>
          <span class="bi-kicker-tip">最新</span>
        </span>
        <h2 class="bi-hero-title">{{ featured.title }}</h2>
        <p v-if="featured.highlight" class="bi-hl">{{ featured.highlight }}</p>
        <p v-if="featured.description" class="bi-hero-desc">{{ featured.description }}</p>
      </a>
      <div class="bi-foot">
        <time v-if="featured.date" class="bi-date" :datetime="featured.date">
          {{ formatDate(featured.date) }}
        </time>
        <span class="bi-dot" aria-hidden="true">·</span>
        <span class="bi-read">约 {{ featured.readingMinutes }} 分钟</span>
        <template v-if="featured.evidenceFiles">
          <span class="bi-dot" aria-hidden="true">·</span>
          <span class="bi-ev">{{ featured.evidenceFiles }} 处源码引证</span>
        </template>
        <span v-if="featured.tags.length" class="bi-tags">
          <!--
            标签在链接**外面**：它们是筛选控件（button），不是导航。
            放进 <a> 里会变成"看起来能筛、点了跳走"——同形不同行为的 affordance 说谎。
            整卡可点由 .bi-hero-link::after 铺满卡片实现，见样式区说明。
          -->
          <button
            v-for="t in featured.tags"
            :key="t"
            type="button"
            class="bi-tag"
            @click="query = t"
          >
            {{ t }}
          </button>
        </span>
      </div>
    </article>

    <!-- ── 其余文章：紧凑条目 ── -->
    <ul v-if="rest.length" class="bi-list">
      <li v-for="p in rest" :key="p.url" class="bi-item">
        <div class="bi-card">
          <a class="bi-card-link" :href="p.url">
            <span v-if="p.series" class="bi-badge">{{ p.series }}</span>
            <h2 class="bi-title">{{ p.title }}</h2>
            <p v-if="p.highlight" class="bi-hl">{{ p.highlight }}</p>
            <p v-if="p.description" class="bi-desc">{{ p.description }}</p>
          </a>
          <div class="bi-foot">
            <time v-if="p.date" class="bi-date" :datetime="p.date">{{ formatDate(p.date) }}</time>
            <span class="bi-dot" aria-hidden="true">·</span>
            <span class="bi-read">约 {{ p.readingMinutes }} 分钟</span>
            <template v-if="p.evidenceFiles">
              <span class="bi-dot" aria-hidden="true">·</span>
              <span class="bi-ev">{{ p.evidenceFiles }} 处源码引证</span>
            </template>
            <span v-if="p.tags.length" class="bi-tags">
              <button v-for="t in p.tags" :key="t" type="button" class="bi-tag" @click="query = t">
                {{ t }}
              </button>
            </span>
          </div>
        </div>
      </li>
    </ul>
  </div>
</template>

<style scoped>
.bi {
  margin-top: 8px;
}

/* ── 筛选区 ── */
.bi-filter {
  margin-bottom: 22px;
}
.bi-search {
  margin-bottom: 10px;
}
.bi-input {
  width: 100%;
  padding: 8px 12px;
  border: 1px solid var(--vp-c-divider);
  border-radius: 8px;
  background: var(--vp-c-bg-soft);
  color: var(--vp-c-text-1);
  font-size: 14px;
  transition: border-color 0.15s;
}
.bi-input:focus {
  outline: none;
  border-color: var(--vp-c-brand-1);
}
.bi-chips {
  display: flex;
  flex-wrap: wrap;
  gap: 7px;
}
/* 系列筛选按钮做成药丸形：形状差异标记"这是开关"，与卡片上的圆角矩形标签区分开 */
.bi-chip {
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
.bi-n {
  font-family: var(--vp-font-family-mono);
  font-size: 11px;
  color: var(--vp-c-text-3);
}
.bi-chip:hover {
  border-color: var(--vp-c-brand-1);
  color: var(--vp-c-brand-1);
}
/* 选中态不只靠颜色：加粗 + 实心底，色觉障碍用户也能分辨 */
.bi-chip.is-active {
  background: var(--vp-c-brand-soft);
  border-color: var(--vp-c-brand-1);
  color: var(--vp-c-brand-1);
  font-weight: 600;
}
.bi-chip.is-active .bi-n {
  color: var(--vp-c-brand-1);
}
.bi-clear {
  padding: 3px 12px;
  border: 1px dashed var(--vp-c-divider);
  border-radius: 999px;
  background: transparent;
  color: var(--vp-c-text-3);
  font-size: 12.5px;
  cursor: pointer;
}
.bi-clear:hover {
  color: var(--vp-c-brand-1);
  border-color: var(--vp-c-brand-1);
}
.bi-blurb {
  margin: 10px 0 0 !important;
  font-size: 13px;
  line-height: 1.7;
  color: var(--vp-c-text-3);
}

.bi-chip:focus-visible,
.bi-clear:focus-visible,
.bi-tag:focus-visible,
.bi-link:focus-visible {
  outline: 2px solid var(--vp-c-brand-1);
  outline-offset: 2px;
}

/* 筛选结果播报：对屏幕阅读器可见，视觉上隐藏（不能用 display:none——那样读屏也读不到） */
.bi-sr {
  position: absolute;
  width: 1px;
  height: 1px;
  margin: -1px !important;
  padding: 0 !important;
  overflow: hidden;
  clip: rect(0 0 0 0);
  white-space: nowrap;
  border: 0;
}

/*
  ── 卡片通用：色差由卡片自己产生，不靠给页面换底色 ──

  卡片填充用 --vp-c-bg-soft，比页面的 --vp-c-bg 深一档。这是**全站已有**的
  "浮层比底色深一档"约定：/changelog 的版本卡、文章页的「相关文章」条目、
  本页的筛选药丸与标签，用的都是同一个变量。所以博客列表页和它们天然同款。

  曾经反过来做：卡片涂纯白 --sid-panel、把页面底色换成灰。那等于为了一个组件
  改掉整页的背景规律，结果是全站每页都「灰 sidebar + 白内容区」，只有这一页
  左右全灰，像另一个站。完整复盘见 brand.css 里那段注释。

  层次靠三样东西叠出来，而不是靠一个大色块：
    · 深一档的填充   —— 与白底分离
    · 1px 描边       —— 给出确定的边界
    · 极淡的投影     —— 让它读起来是"浮在纸上"

  hover 时填充反而变**浅**（切到 --vp-c-bg，即页面白底），这是有意的：
  被指向的那张卡浮得更高、离页面更远，配合 translateY 与品牌色描边，
  方向感是一致的（越靠近鼠标越亮、越浮）。
*/
.bi-hero,
.bi-card {
  position: relative;
  border: 1px solid var(--vp-c-divider);
  border-radius: 12px;
  background: var(--vp-c-bg-soft);
  /*
    投影必须自己撑住卡片形状，不能指望填充。
    浅色下 --vp-c-bg-soft(#fbfcfe) 与页面 --vp-c-bg(#fff) 只差约 1.5%，
    肉眼近乎无差 —— 这正是上一版忍不住去改页面底色的起因。
    两层阴影分工：1px 那层压出边缘、10px 那层给出离纸高度。
  */
  box-shadow:
    0 1px 2px rgba(15, 20, 32, 0.06),
    0 4px 10px rgba(15, 20, 32, 0.04);
  transition:
    border-color 0.2s,
    background 0.2s,
    box-shadow 0.2s,
    transform 0.2s;
}
.bi-hero:hover,
.bi-card:hover {
  border-color: var(--vp-c-brand-1);
  background: var(--vp-c-bg);
  box-shadow: 0 6px 20px var(--sid-brand-glow);
  transform: translateY(-2px);
}
/*
  深色模式反过来：填充够用，投影不够用。
  --vp-c-bg-soft(#1a2130) 对页面 #151b28 是肉眼可辨的一档，卡片本身立得住；
  而黑色投影打在深底上几乎不可见，所以压深、只保留一层贴边的。
*/
.dark .bi-hero,
.dark .bi-card {
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.4);
}

/*
  整卡可点：<a> 用 ::after 铺满整张卡当点击区，而不是把所有内容包进 <a>。
  这样卡片底部的标签能是真正的 <button>（点了筛选，不跳转），同时整卡依然可点。
  原实现把标签包在 <a> 里，视觉上和筛选按钮同形却行为不同。
  ::after 的 z-index 低于标签的 z-index，所以点标签不会穿透到链接。
*/
.bi-hero-link,
.bi-card-link {
  display: block;
  text-decoration: none !important;
  color: inherit;
}
.bi-hero-link::after,
.bi-card-link::after {
  content: "";
  position: absolute;
  inset: 0;
  border-radius: 12px;
  z-index: 0;
}
.bi-hero-link:focus-visible::after,
.bi-card-link:focus-visible::after {
  outline: 2px solid var(--vp-c-brand-1);
  outline-offset: 2px;
}

/* ── 特色大卡 ── */
.bi-hero {
  padding: 26px 26px 18px;
  margin-bottom: 16px;
}
.bi-kicker {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 10px;
}
.bi-kicker-tip {
  font-family: var(--vp-font-family-mono);
  font-size: 11px;
  letter-spacing: 0.04em;
  color: var(--vp-c-text-3);
}
.bi-hero-title {
  margin: 0 !important;
  padding: 0 !important;
  border: 0 !important;
  font-size: 25px;
  font-weight: 700;
  line-height: 1.4;
  letter-spacing: -0.01em;
  color: var(--vp-c-text-1);
  transition: color 0.2s;
}
.bi-hero:hover .bi-hero-title {
  color: var(--vp-c-brand-1);
}
.bi-hero-desc {
  margin: 10px 0 0 !important;
  font-size: 15px;
  line-height: 1.75;
  color: var(--vp-c-text-2);
}

/* ── 紧凑卡片 ── */
.bi-list {
  list-style: none;
  margin: 0 !important;
  padding: 0 !important;
}
.bi-item {
  margin: 0 0 12px !important;
  padding: 0 !important;
}
.bi-card {
  padding: 18px 22px 14px;
}
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
  margin: 8px 0 0 !important;
  font-size: 14px;
  line-height: 1.7;
  color: var(--vp-c-text-2);
}

/* 系列徽章：实心 soft 底，和标签（描边）区分，标记"这是分类归属"不是可点标签 */
.bi-badge {
  display: inline-block;
  padding: 1px 9px;
  margin-bottom: 8px;
  border-radius: 6px;
  background: var(--vp-c-brand-soft);
  color: var(--vp-c-brand-1);
  font-size: 11.5px;
  font-weight: 600;
}
.bi-hero .bi-badge {
  margin-bottom: 0;
}

/* 硬数据行：mono + 品牌色，是这些文章最强的点击理由，视觉重量排在摘要之上 */
.bi-hl {
  margin: 8px 0 0 !important;
  font-family: var(--vp-font-family-mono);
  font-size: 12.5px;
  line-height: 1.6;
  color: var(--vp-c-brand-1);
}

/* ── 卡片底部元信息 ── */
.bi-foot {
  position: relative;
  z-index: 1;
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px;
  margin-top: 14px;
  font-size: 12.5px;
  color: var(--vp-c-text-3);
}
.bi-date,
.bi-read,
.bi-ev {
  font-family: var(--vp-font-family-mono);
}
.bi-dot {
  color: var(--vp-c-divider);
}
.bi-tags {
  display: inline-flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-left: auto;
}
/*
  标签是可点的搜索快捷方式，圆角 8px（不是筛选器那种 999px 药丸）。

  填充刻意用 transparent 而不是 --vp-c-bg-soft：标签在**卡片里面**，而卡片
  自身就是 --vp-c-bg-soft，两者同色的话标签只剩一圈描边、看着像渲染残留。
  透明底让它在默认态与 hover 态（卡片切到白底）下都始终与卡片有一档差，
  靠描边界定形状，不跟着卡片底色一起漂。
*/
.bi-tag {
  padding: 1px 9px;
  border-radius: 8px;
  border: 1px solid var(--vp-c-divider);
  background: transparent;
  color: var(--vp-c-text-3);
  font-size: 11.5px;
  cursor: pointer;
  transition:
    color 0.15s,
    border-color 0.15s,
    background 0.15s;
}
.bi-tag:hover {
  color: var(--vp-c-brand-1);
  border-color: var(--vp-c-brand-1);
  background: var(--vp-c-brand-soft);
}

.bi-empty {
  padding: 22px 0;
  color: var(--vp-c-text-3);
  font-size: 14px;
}
.bi-link {
  padding: 1px 8px;
  border: 1px solid var(--vp-c-divider);
  border-radius: 8px;
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
  .bi-hero,
  .bi-card,
  .bi-title,
  .bi-hero-title,
  .bi-chip,
  .bi-tag,
  .bi-input {
    transition: none;
  }
  .bi-hero:hover,
  .bi-card:hover {
    transform: none;
  }
}

@media (max-width: 640px) {
  .bi-hero {
    padding: 20px 18px 14px;
  }
  .bi-hero-title {
    font-size: 21px;
  }
  .bi-card {
    padding: 16px 16px 12px;
  }
  .bi-tags {
    margin-left: 0;
  }
}
</style>
