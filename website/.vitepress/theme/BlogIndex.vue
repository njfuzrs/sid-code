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

/**
 * 卡片底纹档位（1~2）—— **按位置交替，不按系列**。
 *
 * ## 目的：只为打破单调，不表达任何分类
 *
 * 24 张同色卡片很单调，但颜色在这里**刻意不承载语义**：它是视觉节奏，
 * 不是分组信号。分组信号已经有两个更合适的承担者——系列徽章（文字）
 * 与上方的筛选 chip。
 *
 * ## 改过两版，两版都错在"把颜色当信息"
 *
 *   · 按系列上色（蓝/绿/紫）：站内 21/24 篇属于同一系列，于是连着 21 张同色卡，
 *     单调没解决，只是把色块变大了。
 *   · 按位置轮转四个色相（蓝/紫/绿/橙）：相邻确实不撞色，但一屏内同时出现
 *     四个色相，即使每个只有 5% 饱和度也会互相干扰，观感是"花"不是"有层次"。
 *
 * 现在是**同一色相（品牌蓝）的两档明度**交替。色值在 brand.css 的
 * `--sid-tint-1/2`（配色唯一事实源），那里也写了为什么单色相优于多色相。
 *
 * ## 为什么档位数是 2，且必须配合下面的行内偏移
 *
 * 用下标取模而不是随机：随机会让相邻两张卡有 1/2 概率撞色，撞了就出现一块
 * "双宽"的底色，看着像渲染出错。取模保证**水平相邻**必然不同档。
 *
 * 但 2 与 3 列的组合会让每一列永远是同一档（0,2,4 / 1,3,5 …），
 * 形成竖直条带——那是比单调更糟的噪音，还会被误读成"列有含义"。
 * 所以档位不能只看下标，还要按**所在行**错开一档：
 * 偶数行 0,1,0…、奇数行 1,0,1…，即棋盘式。这样水平、竖直都不撞档。
 *
 * COLS 必须与 CSS 里的封顶列数一致（见 .bi-list 的 grid-template-columns）。
 * 窄屏实际列数会降到 2 或 1，届时棋盘偏移可能失效、退化成竖直交替——
 * 那时一行只有一两张卡，观感上仍是交替而非成带，可接受。
 * 刻意不为此上 ResizeObserver：为纯装饰引入运行时布局测量不值得。
 */
const TINT_COUNT = 2;
const COLS = 3;
function tintAt(index: number): number {
  const row = Math.floor(index / COLS);
  const col = index % COLS;
  // 棋盘：(行 + 列) 的奇偶。刻意用 col 而不是 index ——
  // COLS 是奇数时 index 与 col 的奇偶每行都会翻转，(index + row) 里两个偏移
  // 恰好互相抵消，实测退化成「每列固定一档」的竖直条带（正是要避免的那种）。
  return ((row + col) % TINT_COUNT) + 1;
}

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
      <li v-for="(p, i) in rest" :key="p.url" class="bi-item">
        <!--
          data-tint 按**位置**棋盘式交替 1~2（不按系列，理由见 script 里 tintAt 的注释）。
          用 data-* 而不是 :style 绑颜色：色值留在 brand.css 里（配色唯一事实源），
          组件只表达"这是第几档"，深浅模式各自的取值不进 JS。
        -->
        <div class="bi-card" :data-tint="tintAt(i)">
          <!--
            title 属性承载被截断的内容：标题与摘要在网格里各限 2 行
            （见 .bi-title / .bi-desc 的 line-clamp），hover 能看到完整文本，
            信息没有因为截断而丢失。
          -->
          <a class="bi-card-link" :href="p.url" :title="`${p.title}\n\n${p.description}`">
            <span v-if="p.series" class="bi-badge">{{ p.series }}</span>
            <h2 class="bi-title">{{ p.title }}</h2>
            <p v-if="p.highlight" class="bi-hl">{{ p.highlight }}</p>
            <p v-if="p.description" class="bi-desc">{{ p.description }}</p>
          </a>
          <!--
            紧凑卡片的元信息只留**日期 + 时长**（外加真有引证时的引证数）。

            标签按钮在这里删掉了：卡片宽约 210px，一行放不下两三个标签，
            它们会换行占掉 2~3 行，把卡片从扁的顶成竖的——而卡片保持扁平是
            这次布局调整的目标之一。标签的两个作用都另有承担者：
              · 筛选 —— 上方的系列 chip 是受控词表，本来就比自由标签更适合收窄；
              · 检索 —— 搜索框仍然搜 tags（见 haystack()），打字即可。
            特色大卡（.bi-hero）宽度足够，标签仍然保留在那里。
          -->
          <div class="bi-foot">
            <time v-if="p.date" class="bi-date" :datetime="p.date">{{ formatDate(p.date) }}</time>
            <span class="bi-dot" aria-hidden="true">·</span>
            <span class="bi-read">约 {{ p.readingMinutes }} 分钟</span>
            <template v-if="p.evidenceFiles">
              <span class="bi-dot" aria-hidden="true">·</span>
              <span class="bi-ev">{{ p.evidenceFiles }} 处源码引证</span>
            </template>
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

/*
  ── 紧凑卡片：多列网格，一行最多 4 张 ──

  为什么从单列改成网格：文章数上去后（并入一个 21 篇的系列，站内 24 篇），
  单列会把列表拉成一条要滚很久的长带，而每张卡只用掉一小半宽度——右边全是空白。
  网格把首屏可见的卡片数翻好几倍，读者「扫一遍再挑一篇」的动作才成立
  （这一页的唯一目的）。配套改动：`blog/index.md` 加了 `aside: false`
  把右侧那 256px 让出来，理由写在那边的 frontmatter 注释里。

  为什么是 auto-fill + minmax 而不是写死 `repeat(4, 1fr)`：
  写死列数在窄屏上会挤出 4 张过窄的卡（标题每行只放得下两三个字）。
  minmax(210px, 1fr) 让浏览器按可用宽度自己决定塞几列——宽屏 4 列、
  中屏 3/2 列、窄屏 1 列，一条规则覆盖全部断点，不需要逐档写 @media。

  为什么下限是 260px 而不是更小：1280px 视口下内容区约 944px（减去 272px sidebar
  与两侧 32px padding），3 × 260 + 2 × 14(gap) = 808 ≤ 944，3 列放得下。
  曾用 210px 下限跑过 4 列，实测太挤——1280px 时每张卡只有 226px，
  「Claude Code 源码解析（十四）· 记忆与上下文持久化」这类标题两行都放不下，
  摘要更是只剩两行残句。3 列在同一视口下每张卡约 305px，标题稳定两行内。

  ⚠ 只有下限是不够的 —— **必须同时给列数封顶**，否则宽屏会一直加列：
  实测 210px 下限时 1920px 视口会算出 7 列，每张卡 214px 宽而内容高约 205px，
  宽高比接近 1:1，「扁平」就没了。所以用 grid-template-columns 的上限（3 列）
  配合 auto-fill 的下限（260px）两头夹住：宽屏保持 3 列、卡片跟着变宽（更扁），
  窄屏按下限自动降列。两条都保留才能同时满足「一行 3 张」与「宽 > 高」。

  ⚠ 卡片是**扁的**（宽 > 高），这靠两件事共同保证，缺一不可：
    · 摘要 .bi-desc 限 2 行（-webkit-line-clamp），不让长摘要把卡片顶高；
    · 不设 min-height —— 高度由内容决定，两行摘要 + 标题 + 元信息行
      在 260~450px 宽下自然落在 180~205px，比宽度小。
  单列时代摘要是不截断的（那时卡片很宽、三四行摘要也还是扁的），
  现在卡片窄了，不截断就会立起来变成竖条。
*/
.bi-list {
  list-style: none;
  margin: 0 !important;
  padding: 0 !important;
  display: grid;
  /*
    降级基线：不支持 max() 的浏览器拿到纯 auto-fill（宽屏会多于 3 列，
    但版面不破）。下一条规则给现代浏览器封顶到 3 列。
  */
  grid-template-columns: repeat(auto-fill, minmax(260px, 1fr));
  gap: 14px;
}
/*
  封顶 3 列：每列宽度取「容器的 1/3」与「260px」中较大的那个。
  容器 ≥ 808px（= 3×260 + 2×14）时按 1/3 分，恰好 3 列且卡片随容器变宽；
  容器更窄时每列退回 260px 下限，auto-fill 自然降成 2/1 列。
  用 max() 而不是写死 `repeat(3, 1fr)`：后者在窄屏会强行挤出 3 张过窄的卡。
*/
@supports (width: max(1px, 2px)) {
  .bi-list {
    grid-template-columns: repeat(auto-fill, minmax(max(260px, calc((100% - 28px) / 3)), 1fr));
  }
}
.bi-item {
  margin: 0 !important;
  padding: 0 !important;
  /*
    让卡片撑满网格单元的高度。网格里同一行的单元格等高，若卡片只按内容高度
    渲染，摘要短的那张会矮一截、底部元信息行参差不齐——比单列时更刺眼，
    因为并排放着可以直接比。
  */
  display: flex;
}
.bi-card {
  padding: 16px 18px 12px;
  /* 与 .bi-item 的 display:flex 配合：撑满单元格，并把 .bi-foot 压到卡片底部 */
  display: flex;
  flex-direction: column;
  width: 100%;
  /* 网格单元可能比内容窄，min-width:0 允许内部文本正常收缩换行而不是撑破单元格 */
  min-width: 0;
}
/* 元信息行贴卡片底：上方留白吸收摘要长短差，同一行卡片的底部行才能对齐 */
.bi-card .bi-foot {
  margin-top: auto;
  padding-top: 14px;
}

/*
  ── 卡片底纹：同一色相的两档明度，棋盘式交替，只为打破单调 ──

  颜色在这里**不承载语义**（档位由 tintAt(index) 按位置给出，与系列无关；
  为什么不按系列、为什么是单色相两档、为什么要按行错开，
  写在 script 里 tintAt 与 brand.css 的 --sid-tint-* 注释里）。

  三条实现约束，改这段时都别破：

  1. **只染背景，不碰任何文字色，也不加边框。** 标题/摘要/元信息一律保持
     --vp-c-text-*。文字色一旦跟着卡片变，就要为每档 × 深浅模式
     单独验对比度，而收益只是装饰。现在色纹只有 1.8%/4%（深色 3.5%/7%）的
     低透明度铺色，原有文字色在其上仍 ≥ 11:1（AA 只要 4.5），
     也就是颜色完全不参与可读性。

     ⚠ 透明度刻意压到"几乎看不见"这一档，别再调深。卡片本身已经有
     描边 + 两层阴影 + hover 变色三重视觉信号，底纹是其中权重最低的一层，
     它的唯一作用是让相邻两张卡不完全一样。调深会立刻回到"眼花缭乱"。

     曾试过配一道 3px 左边框（想作为"非颜色的第二重区分"），去掉了：
     颜色既然不表达分类，就不需要第二重区分手段，那道边框纯粹是装饰，
     而 24 张卡各带一道彩色竖条比同色更花。描边仍由 --vp-c-divider
     四边均匀承担（.bi-card 那条），卡片形状不依赖颜色。

  2. **色值只在 brand.css 里**（--sid-tint-*，配色唯一事实源）。
     这里只按 data-tint 选变量，不写任何十六进制/rgba —— 与本文件顶部
     那条"不内联色值"的纪律一致，深浅模式的两套取值也就天然只有一处。

  3. **background 用 linear-gradient 叠在 --vp-c-bg-soft 之上**，
     不是直接 `background: var(--sid-tint-N)`。后者会把卡片底色**替换**成
     一个半透明色，于是卡片透出页面白底、hover 时切到 --vp-c-bg 的动画
     也会失效。用渐变作为额外一层则保留了原有的 bg-soft 基底，
     hover 规则（切 --vp-c-bg）仍然生效。
*/
.bi-card[data-tint="1"] {
  background:
    linear-gradient(var(--sid-tint-1), var(--sid-tint-1)),
    var(--vp-c-bg-soft);
}
.bi-card[data-tint="2"] {
  background:
    linear-gradient(var(--sid-tint-2), var(--sid-tint-2)),
    var(--vp-c-bg-soft);
}
/*
  hover 时把色纹去掉、只留白底 —— 与无 tint 卡片的 hover 表现一致
  （见 .bi-card:hover 那条：填充切到 --vp-c-bg，被指向的卡"更亮更浮"）。
  留着色纹会让 hover 的亮度变化被底色抵消，方向感就不一致了。
*/
.bi-card[data-tint]:hover {
  background: var(--vp-c-bg);
}
/*
  标题降到 16px（单列时代是 19px）：卡片从约 660px 宽变成约 210px，
  19px 会让「Claude Code 源码解析（十四）· 记忆与上下文持久化」这类长标题
  占掉三行，卡片直接立起来。16px + 2 行上限让它稳定在两行内。
*/
.bi-title {
  margin: 0 !important;
  padding: 0 !important;
  border: 0 !important;
  font-size: 16px;
  font-weight: 600;
  line-height: 1.45;
  color: var(--vp-c-text-1);
  transition: color 0.2s;
  /* 超过 2 行截断：标题长度参差不齐时，不限行会让同一行的卡片高度不一 */
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}
.bi-card:hover .bi-title {
  color: var(--vp-c-brand-1);
}
/*
  摘要限 2 行 —— **这是卡片保持扁平（宽 > 高）的关键一条**。

  这些 description 长度差得很远（最短约 30 字、最长约 90 字）。不截断的话
  长摘要能占掉 5 行，卡片高度冲到 250px 以上、超过 210px 的宽度，就变成竖条了；
  而且同一行里高矮不齐（网格单元等高，最高的那张决定整行）。
  两行足够判断"这篇讲什么"——真要读细节是点进去，不是在卡片上读完。

  title 属性挂在 .bi-card-link 上（见模板），截断的部分 hover 可见，信息没丢。
*/
.bi-desc {
  margin: 6px 0 0 !important;
  font-size: 13px;
  line-height: 1.6;
  color: var(--vp-c-text-2);
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}

/*
  系列徽章：实心 soft 底，和标签（描边）区分，标记"这是分类归属"不是可点标签。

  ── 为什么用中性色而不是品牌色 ──

  这里曾是 --vp-c-brand-soft 底 + --vp-c-brand-1 文字，主次是反的：
  卡片上唯一该抢眼的是**标题**（读者扫列表就是在扫标题），而标题用的是中性
  --vp-c-text-1。彩色文字放在中性文字旁边永远更跳——于是先看见的是
  「Claude Code 源码解析」这个徽章，标题反而退成背景。而徽章的信息价值明确
  低于标题：系列在上方筛选 chip 里已经出现过，卡片上它只是个归属标记。

  改成中性底（--vp-c-default-soft）+ 次级文字色（--vp-c-text-2）：
  形状还在（能读出属于哪个系列），但不再与标题争视线。
  刻意不只是"把品牌色调浅"——低饱和的蓝仍然是彩色，在一屏 23 张卡上
  仍旧是 23 个彩色斑点。要让它退到次要层，得整个离开彩色。
*/
.bi-badge {
  display: inline-block;
  padding: 1px 9px;
  margin-bottom: 8px;
  border-radius: 6px;
  background: var(--vp-c-default-soft);
  color: var(--vp-c-text-2);
  font-size: 11.5px;
  font-weight: 500;
}
.bi-hero .bi-badge {
  margin-bottom: 0;
}
/*
  紧凑卡片里的徽章限单行并省略：系列名长度不受控（「Claude Code 源码解析」
  已经 11 个字符），在 260px 宽下它会换成两行，把徽章从"一枚标记"变成一个色块。
  max-width:100% + ellipsis 让它最多占满一行、超出用 … 收尾。

  徽章底色**刻意不跟着 data-tint 变**：卡片已经铺了一层蓝色纹，
  徽章再涂一遍同色就会与背景糊在一起、失去"一枚标记"的形状。
  用中性的 --vp-c-default-soft 反而让它在任何 tint 档位上都保持一档差
  —— 这也是它作为非颜色区分手段（读得出系列名）能成立的前提。
*/
.bi-card .bi-badge {
  max-width: 100%;
  margin-bottom: 6px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/*
  硬数据行：mono 字体承担"这是实测数字"的语气，**不靠颜色**。

  ── 为什么从品牌色改成中性色 ──

  原来是 --vp-c-brand-1（与徽章同色），理由写的是"这些文章最强的点击理由，
  视觉重量排在摘要之上"。前半句仍然成立，后半句的实现方式错了：
  它把重量加到了**标题之上**。一张卡上有 mono 蓝字 + 蓝徽章 + 中性标题时，
  眼睛先去的是两处蓝色，标题反而最后被读到——而读者扫列表扫的是标题。

  现在靠**字体**而不是颜色区分层次：mono 在一片 sans 里已经足够显眼
  （全站都用这个手法，见 brand.css 里"mono 承担技术感"那条），
  颜色退回 --vp-c-text-2 与摘要同级。这样卡片上的视觉顺序回到
  标题 → 硬数据 / 摘要 → 元信息，与信息价值一致。
*/
.bi-hl {
  margin: 6px 0 0 !important;
  font-family: var(--vp-font-family-mono);
  font-size: 12px;
  line-height: 1.55;
  color: var(--vp-c-text-2);
}
/*
  紧凑卡片里的 highlight 也限 1 行：它是 mono 字体、内容偏长
  （如「引言 + 20 章 · 约 13.5 小时 · 基于 2026-03-31 源码快照」），
  在 210px 宽下不截断会占 3 行，比摘要更容易把卡片顶成竖条。
  特色大卡不受此限（.bi-hero 宽度足够，那里完整显示）。
*/
.bi-card .bi-hl {
  display: -webkit-box;
  -webkit-line-clamp: 1;
  -webkit-box-orient: vertical;
  overflow: hidden;
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
