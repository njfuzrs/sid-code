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

/*
 * ── 这里曾有一个 tintAt(index)：按棋盘给相邻卡片交替两档蓝色底纹 ──
 *
 * 删了，连同 brand.css 的 --sid-tint-1/2。它服务的目标是"24 张同色卡很单调"，
 * 但手段是让一组**同质**的卡片有两种底色，于是读者会去找这个差别代表什么
 * ——而它刻意不代表任何东西（当时的注释里就写着"颜色不承载语义"）。
 * 颜色差是最强的视觉信号之一，用它做纯装饰，读者必然先把它当信息读一遍再丢掉。
 *
 * 单调改由**表面本身有性格**解决：暖白纸感的卡面 + 每张卡一枚暖琥珀徽章，
 * 而不是靠卡片之间互不相同。同质内容长得一样是对的。
 * 色值与完整论证在 brand.css 的 --sid-card-* 那段（配色唯一事实源）。
 */

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
        <!-- 所有卡片同一档表面色。曾有 :data-tint 按位置交替两档底纹，已删（见 script 顶部） -->
        <div class="bi-card">
          <!--
            紧凑卡片上只留四样：系列徽章、标题、摘要、日期 + 时长。

            ── 删掉了 highlight（.bi-hl）与引证数（.bi-ev）──

            两者都是"硬数据"，当初放上来的理由是"这是最强的点击理由"。在这个
            宽度下不成立：它们和摘要争的是同一块地方，而摘要是唯一能回答
            "这篇讲什么"的东西。highlight 是 mono 字体、内容偏长（如「引言 +
            20 章 · 约 13.5 小时 · 基于 2026-03-31 源码快照」），原先被压到
            1 行只剩残句；摘要则被压到 2 行、p90 的 86 字连一半都放不下。
            砍掉这两行、把省下的高度还给摘要（现在 4 行），卡片才真的在说
            "这篇讲什么"，而不是摆三行各自都不完整的信息。
            两者在特色大卡（.bi-hero）里保留 —— 那里宽度足够，不存在争抢。

            title 属性承载被截断的内容（标题限 2 行、摘要限 4 行，见各自的
            line-clamp），hover 能看到完整文本，信息没有因为截断而丢失。
          -->
          <a class="bi-card-link" :href="p.url" :title="`${p.title}\n\n${p.description}`">
            <span v-if="p.series" class="bi-badge">{{ p.series }}</span>
            <h2 class="bi-title">{{ p.title }}</h2>
            <p v-if="p.description" class="bi-desc">{{ p.description }}</p>
          </a>
          <!--
            标签按钮也不在这里：卡片宽约 305px，一行放不下两三个标签，
            它们会换行占掉 2~3 行，把卡片从扁的顶成竖的。标签的两个作用都另有
            承担者：筛选交给上方的系列 chip（受控词表，本就比自由标签更适合收窄），
            检索交给搜索框（仍然搜 tags，见 haystack()）。
            特色大卡（.bi-hero）宽度足够，标签仍然保留在那里。
          -->
          <div class="bi-foot">
            <time v-if="p.date" class="bi-date" :datetime="p.date">{{ formatDate(p.date) }}</time>
            <span class="bi-dot" aria-hidden="true">·</span>
            <span class="bi-read">约 {{ p.readingMinutes }} 分钟</span>
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
  ── 卡片通用：浅色下**纯白**卡面，靠描边 + 投影立住 ──

  填充用 --sid-card（浅色 = --sid-panel #fff，即页面底色本身；深色 = #1a2130）。

  ## 为什么浅色下卡片与页面同色

  原来用 --vp-c-bg-soft(#fbfcfe)，理由是"浮层比底色深一档"。那一档只有约 1.5%，
  肉眼近乎无差，却足以让卡片读起来**发灰** —— 一屏 23 张灰卡叠在一起就是
  "整片区域又暗又冷"的主要来源。这一档属于"有还不如没有"：既没给出边界，
  又付了发灰的代价。
  纯白卡片 + 1px 描边 + 两层投影是最常见也最不会出错的卡片语言，边界由描边
  确定给出，离纸高度由投影给出，两者都不依赖明度差。

  ## 冷的问题由"去掉冷色"解决，不是"加暖色对冲"

  中间试过一版暖白卡面（#fbf7f0 香槟色）+ 暖描边 + 暖投影 + 琥珀徽章，撤了。
  诊断没错（冷色确实叠了四层：偏蓝的表面 + 蓝灰描边 + 蓝黑投影 + 品牌蓝底纹），
  但**全站没有任何一处用暖黄**，在一个页面上铺 23 块香槟色，这一页就不像这个站
  的页面了 —— 与 brand.css 里「别改列表页背景色」那次是同一类错（为一个组件的
  观感破坏全站规律，那次坏的是背景规律，这次是色板）。
  现在四层冷色是这样清掉的：底纹整个删除、表面转纯白、投影降到近中性
  （rgba(28,28,30)）、描边保持全站的 --sid-border。冷色只剩 hover 的品牌蓝描边
  与光晕 —— 那是交互反馈，只出现在鼠标所指的那一张上，不构成整片区域的基调。

  仍然**不碰页面底色**（brand.css 里那条禁令仍然有效）。

  ## hover 方向在两个模式里必须一致（都是"更亮更浮"）

  浅色下卡面已是纯白、没法再更亮，所以 hover **不动填充**，只加深投影 +
  品牌色描边 + 上浮。深色下 --sid-card-hover 比 --sid-card 亮一档。
  旧实现两模式共用 `background: var(--vp-c-bg)`：浅色下 #fff 是变亮，深色下
  #151b28 比卡片 #1a2130 更暗 —— 同一交互在两个模式里方向相反。
*/
.bi-hero,
.bi-card {
  position: relative;
  border: 1px solid var(--sid-card-border);
  border-radius: 12px;
  background: var(--sid-card);
  /*
    投影必须自己撑住卡片形状 —— 浅色下卡面与页面**完全同色**，填充不提供
    任何分离度，全靠这里和描边。两层分工：1px 那层压出边缘、10px 那层给出
    离纸高度。色相近中性（不是原来的蓝黑 rgba(15,20,32)），避免边缘泛灰蓝。
  */
  box-shadow:
    0 1px 2px var(--sid-card-shadow),
    0 4px 10px var(--sid-card-shadow-2);
  transition:
    border-color 0.2s,
    background 0.2s,
    box-shadow 0.2s,
    transform 0.2s;
}
.bi-hero:hover,
.bi-card:hover {
  border-color: var(--vp-c-brand-1);
  background: var(--sid-card-hover);
  box-shadow: 0 6px 20px var(--sid-brand-glow);
  transform: translateY(-2px);
}
/*
  深色模式反过来：填充够用，投影不够用。
  --sid-card(#1a2130) 对页面 #151b28 是肉眼可辨的一档，卡片本身立得住；
  而黑色投影打在深底上几乎不可见，所以压深、只保留一层贴边的。
  也就是说浅色靠描边+投影、深色靠明度差 —— 手段不同，都保证卡片立得住。
*/
.dark .bi-hero,
.dark .bi-card {
  box-shadow: 0 1px 3px var(--sid-card-shadow);
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
  ── 这里曾有 .bi-card[data-tint="1"|"2"] 两条底纹规则，已删 ──

  它们给相邻卡片铺两档不同的蓝色底纹（棋盘式交替）。删除理由写在 script 顶部
  与 brand.css 的 --sid-card-* 那段：让同质卡片长得不一样，读者会去找那个差别
  的含义，而它刻意没有含义。表面色现在只有一档（.bi-hero/.bi-card 那条）。

  两条仍然有效的纪律（当时就写在这里，与底纹本身无关）：

  1. **只染背景，不碰任何文字色。** 标题/摘要/元信息一律保持 --vp-c-text-*。
     文字色一旦跟着表面变，就要为每种表面 × 深浅模式单独验对比度，
     而收益只是装饰。现在卡面是纯白/全站深色浮层色，--vp-c-text-* 在其上
     本来就是全站到处在用的组合，无需为这一页单独验。

  2. **色值只在 brand.css 里**（配色唯一事实源）。这里只引用变量，
     不写任何十六进制/rgba —— 与本文件顶部那条"不内联色值"的纪律一致，
     深浅模式的两套取值也就天然只有一处。
*/

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
  摘要限 4 行 —— 摘要是卡片上唯一回答"这篇讲什么"的东西，行数按实测长度定。

  ## 为什么是 4 而不是 2

  原先是 2 行，绝大多数摘要都被切断在句子中间。实测 25 篇 description 的
  字符数分布：min 43 / p50 69 / p75 78 / p90 86 / max 146。
  1280px 视口下卡片约 305px 宽、13px 字号，一行约 20 个汉字：
    · 2 行 = 40 字   → 连 p50 的 69 字都放不下，超过一半的卡片被截
    · 4 行 = 80 字   → 覆盖到 p75(78)，p90(86) 也只差半行
  只有 max 那篇（146 字）仍会被截，那是它自己写太长，不该由版式兜底。

  4 行放得下的前提是**删掉了 highlight 那一行**（见模板里的说明）：
  高度是从它那里腾出来的，不是凭空加的。

  ## 仍然必须有上限（别改成不截断）

  网格单元等高，最高的那张决定整行。不设上限时长摘要能占 7 行，
  卡片高度冲到 300px 以上、超过 305px 的宽度就从扁的变成方的/竖的，
  同一行里其他卡片底部还会跟着拉出大片空白。
  4 行 + 标题 2 行 + 徽章 + 元信息行在 305px 宽下约 215px 高，仍是扁的。

  title 属性挂在 .bi-card-link 上（见模板），截断的部分 hover 可见，信息没丢。
*/
.bi-desc {
  margin: 6px 0 0 !important;
  font-size: 13px;
  line-height: 1.6;
  color: var(--vp-c-text-2);
  display: -webkit-box;
  -webkit-line-clamp: 4;
  -webkit-box-orient: vertical;
  overflow: hidden;
}

/*
  系列徽章：实心 soft 底，和标签（描边）区分，标记"这是分类归属"不是可点标签。

  ── 用中性色。改过两轮彩色，两轮都退回来了 ──

  第一轮：品牌蓝底 + 品牌蓝字 → 中性灰。原因是主次反了 —— 卡片上唯一该抢眼的是
  **标题**（读者扫列表就是在扫标题），而标题是中性 --vp-c-text-1；彩色文字放在
  中性文字旁边永远更跳，于是先看见「Claude Code 源码解析」这个徽章，标题反而
  退成背景。而徽章的信息价值明确更低：系列在上方筛选 chip 里已经出现过。
  刻意不只是"把品牌色调浅"——低饱和的蓝仍然是彩色，一屏 23 张卡就是 23 个彩色
  斑点。要让它退到次要层，得整个离开彩色。

  第二轮：中性灰 → 暖琥珀 → 又退回中性灰。当时的想法是"整页需要一点亮色"，
  配合那一版的暖白卡面。两个都撤了，理由是同一条：**全站没有任何一处用暖黄**，
  在一个页面上引入一个站内不存在的色族，这一页就不像这个站的页面了。
  卡片区读着发灰的真实原因是冷色叠了四层（见 brand.css --sid-card-* 那段），
  正解是**去掉冷色**（卡面转纯白、投影降到近中性），不是**加暖色对冲**。
  加一个色相去中和另一个，结果是两个色相都在场。

  ── 现在：中性色，但提亮一档 ──

  灰底 + 灰字确实压得太闷。提亮走的是**站内已有的品牌蓝**，不引入新色族：
  底 --vp-c-brand-soft（10% 品牌蓝）、字 --vp-c-brand-1。
  这看着像退回第一轮，其实条件变了 —— 第一轮的毛病是"彩色徽章抢标题视线"，
  而当时同屏还有一行 mono 蓝色的硬数据（.bi-hl）在一起抢。那一行现在删了，
  卡片上只剩这一处彩色，抢不动 16px/600 的标题（徽章是 11.5px/500）。
  主次仍由字号与字重维持，不由颜色维持。

  ⚠ 这一页的颜色预算就一份：中性表面/文字 + 品牌蓝（徽章 + hover 描边）。
  别再加第三个色相 —— 暖黄那轮已经试过并撤掉了。
*/
.bi-badge {
  display: inline-block;
  padding: 1px 9px;
  margin-bottom: 8px;
  border-radius: 6px;
  background: var(--vp-c-brand-soft);
  color: var(--vp-c-brand-1);
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

  徽章底色用 --vp-c-default-soft（中性、半透明）：它在纯白卡面与深色卡面上
  都自然保持一档差，不需要为两个模式各写一个值。
*/
.bi-card .bi-badge {
  max-width: 100%;
  margin-bottom: 6px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/*
  硬数据行（highlight）：**只出现在特色大卡里**，紧凑卡片上已删除。

  mono 字体承担"这是实测数字"的语气，不靠颜色。原来是 --vp-c-brand-1
  （与当时的蓝徽章同色），改中性的理由：它把视觉重量加到了**标题之上** ——
  一张卡上有 mono 蓝字 + 蓝徽章 + 中性标题时，眼睛先去的是两处蓝色，
  标题反而最后被读到，而读者扫列表扫的是标题。
  现在靠**字体**而不是颜色区分层次：mono 在一片 sans 里已经足够显眼
  （全站都用这个手法，见 brand.css 里"mono 承担技术感"那条）。

  紧凑卡片上曾有一条 `.bi-card .bi-hl { line-clamp: 1 }` 把它压成 1 行，
  连同 highlight 本身一起删了 —— 压到 1 行后它只剩一句残句，却仍占着
  摘要急需的那行高度。删除理由完整写在模板里那段注释。
*/
.bi-hl {
  margin: 6px 0 0 !important;
  font-family: var(--vp-font-family-mono);
  font-size: 12px;
  line-height: 1.55;
  color: var(--vp-c-text-2);
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

  填充刻意用 transparent：标签只出现在特色大卡里（紧凑卡片不放标签），
  透明底让它在默认态与 hover 态下都跟着卡面走、不与卡面撞色，形状由描边界定。
  给它一个固定底色反而要为「卡面纯白 / 深色卡面 / hover」各验一遍是否还有一档差。
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
