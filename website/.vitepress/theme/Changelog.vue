<script setup lang="ts">
/**
 * 官网 /changelog 页的渲染组件。
 *
 * ── 为什么是组件 + JSON，不是生成 markdown ──
 *   生成 markdown 更省事，但会被 minisearch 纳入**全站**索引：几百条变更描述
 *   会把「搜 hook」「搜权限」这类正常查询冲成一片版本噪音。changelog 要的是
 *   **自己的**搜索框（只搜版本变更），所以走「构建期 JSON + 组件内过滤」，
 *   容器页 frontmatter 标 `search: false` 从全站索引里摘出去（config.ts 的
 *   `_render` 钩子负责执行）。
 *
 * ── 数据来源 ──
 *   `website/.vitepress/data/changelog.json`，由 scripts/generate-changelog.ts 在
 *   release.sh 发版时生成。内容来自 `changelog/curated/*.json`（LLM 起草、人工过目、
 *   已入库的**用户视角**文案），不是 commit message。这里是**静态 import**：
 *   数据在构建期烧进产物，浏览器零请求、无白屏、无 loading 态。代价是发版后要
 *   重发站点才更新（website-deploy.sh 有版本一致性 warn 兜住这条纪律）。
 *
 * ── 2026-08-06 curated 改造：这一页不再显示 commit ──
 *   移除了 per-commit 的 hash / scope / 折叠展开的 body 细节。原因不是"简化"，
 *   而是**受众**：commit message 的读者是未来的自己，changelog 的读者是用户。
 *   hash 与 scope 是开发者坐标，body 细节讲的是实现过程 —— 三者对用户都是噪音。
 *   要回溯原始提交请看仓库根 `CHANGELOG.md`（它仍是全量的）。
 *
 *   连带移除的还有 `<details>` 折叠：curated 条目本身已经是结论，没有"展开看细节"
 *   这一层了。于是搜索时"自动展开"（autoOpen）也随之消失 —— 那是为折叠态服务的补丁。
 *
 * ── 视觉 ──
 *   全部颜色走 brand.css 的 --sid-* / --vp-* 变量，深浅色自动跟随站点主题。
 *   刻意不内联任何十六进制色值——旧 CHANGELOG.html 自带一整套 :root 调色板，
 *   那正是「看起来像两个站」的根因。
 */
import { computed, nextTick, onMounted, ref, watch } from "vue";
import { useRoute } from "vitepress";
import data from "../data/changelog.json";
import { versionAnchor } from "../changelog-meta";

interface Section {
  key: string;
  title: string;
  items: string[];
}
interface Version {
  version: string;
  date: string;
  highlight: string | null;
  userFacing: boolean;
  count: number;
  sections: Section[];
}

const changelog = data as unknown as {
  generatedAt: string;
  currentVersion: string;
  totalVersions: number;
  /** ⚠ curated **条目**数，不是 commit 数（键名与语义在生成器里一起改的） */
  totalItems: number;
  sectionMeta: Array<{ key: string; title: string }>;
  versions: Version[];
};

const query = ref("");
/** 当前只看某一类变更（null = 全部）。点徽章切换，再点取消。 */
const activeSection = ref<string | null>(null);

/**
 * 多词 AND 匹配：按空白拆词，每个词都要出现才算命中。
 *
 * 刻意不做整串子串匹配 —— 那样搜「prompt cache」要求这两个词在原文里**紧邻**，
 * 而 changelog 里它们通常分散在不同条目/位置，用户输两个词却一条不中，看着像坏了。
 * 中文不分词，单个 token 仍是子串匹配，所以「缓存」这类查询照常工作。
 *
 * ⚠ 搜索范围现在是**条目文本**（curated items）。hash 与 scope 已从数据源移除，
 * 所以「拿 hash 搜」这个用法没有了 —— 那是开发者用法，要按 hash 查请用 git。
 */
function itemMatches(text: string, terms: string[]): boolean {
  if (terms.length === 0) return true;
  const hay = text.toLowerCase();
  return terms.every((t) => hay.includes(t));
}

/**
 * 过滤后的版本列表。搜索与分组筛选在同一处做，避免两套过滤路径。
 * 空分组、空版本直接不产出——比渲染出来再 display:none 干净，
 * 也让「没有匹配」这个状态只有一个判断点（filtered.length === 0）。
 *
 * ⚠ `highlight` 也纳入匹配：它常常是一个版本最核心的那句话，
 * 搜不到它会让「明明记得有这么一版」的查询落空。命中 highlight 时保留整个版本。
 */
const filtered = computed<Version[]>(() => {
  const terms = query.value.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const k = activeSection.value;
  if (terms.length === 0 && !k) return changelog.versions;

  const out: Version[] = [];
  for (const v of changelog.versions) {
    const highlightHit =
      !k && terms.length > 0 && !!v.highlight && itemMatches(v.highlight, terms);

    const sections: Section[] = [];
    for (const sec of v.sections) {
      if (k && sec.key !== k) continue;
      const items = highlightHit
        ? [...sec.items]
        : sec.items.filter((it) => itemMatches(it, terms));
      if (items.length > 0) sections.push({ ...sec, items });
    }
    if (sections.length > 0) {
      out.push({
        ...v,
        sections,
        count: sections.reduce((n, s) => n + s.items.length, 0),
      });
    }
  }
  return out;
});

const matchCount = computed(() => filtered.value.reduce((n, v) => n + v.count, 0));
const isFiltering = computed(() => !!query.value.trim() || !!activeSection.value);

/** 每类变更的全量条数，供筛选徽章显示（不随过滤变化，否则筛完就归零没法切回） */
const sectionTotals = computed(() => {
  const m = new Map<string, number>();
  for (const v of changelog.versions) {
    for (const s of v.sections) {
      m.set(s.key, (m.get(s.key) ?? 0) + s.items.length);
    }
  }
  return changelog.sectionMeta
    .map((s) => ({ ...s, total: m.get(s.key) ?? 0 }))
    .filter((s) => s.total > 0);
});

function toggleSection(key: string) {
  activeSection.value = activeSection.value === key ? null : key;
}

function reset() {
  query.value = "";
  activeSection.value = null;
}

/* ────────────────── 左栏时间线锚点 × 筛选态的冲突处理 ────────────────── */

/**
 * 左栏（`.vitepress/changelog-meta.ts` 的 CHANGELOG_SIDEBAR）每条版本都是
 * `/changelog#v0.1.598` 这样的**页内锚点**。它和本组件的筛选态有一个真实冲突：
 *
 *   筛选生效时 `filtered` 会把不匹配的版本**整个移出 DOM**（这是刻意的，见 filtered
 *   的注释：比渲染出来再 display:none 干净）。此时点左栏一个被过滤掉的版本，
 *   浏览器要滚到的 `#vX` 元素根本不存在 —— URL 变了、左栏高亮了、正文毫无反应。
 *   对读者来说这就是**坏了**，而且不会有任何报错。
 *
 * 处理：目标版本不在当前 `filtered` 里就先清筛选，等 DOM 重新渲染出来再滚过去。
 * 「点导航 → 看到那个版本」这个预期优先于「保住我刚输的关键词」——
 * 后者一个 `reset` 按钮就能重来，前者失效则整条左栏形同虚设。
 *
 * 用 `useRoute()` 的 hash 而不是 window.onhashchange：VitePress 是 SPA，
 * 站内点击走的是路由跳转，原生 hashchange 在**同页锚点间**跳转时能触发，
 * 但从别的页面带 hash 进来时不会。监听路由值两种情形都覆盖。
 */
const route = useRoute();

function versionInDom(version: string): boolean {
  return filtered.value.some((v) => v.version === version);
}

/** `#v0.1.598` → `0.1.598`；不是版本锚点则返回 null */
function parseVersionHash(hash: string): string | null {
  const m = /^#v(\d+\.\d+\.\d+)$/.exec(hash);
  if (!m) return null;
  return changelog.versions.some((v) => v.version === m[1]) ? m[1] : null;
}

async function revealHashTarget(hash: string) {
  const version = parseVersionHash(hash);
  if (!version) return;

  // 被筛掉了 → 先清筛选，让它回到 DOM。已经可见则什么都不做，
  // 交给浏览器/VitePress 自己的锚点滚动，避免和它抢滚动位置。
  if (!versionInDom(version)) {
    reset();
    await nextTick();
    document.getElementById(versionAnchor(version))?.scrollIntoView();
  }
}

watch(
  () => route.hash,
  (hash) => void revealHashTarget(hash),
);
// 首次挂载：带 hash 直接进来（外部深链、刷新、新标签页打开）时 watch 不会触发
onMounted(() => void revealHashTarget(route.hash));
</script>

<template>
  <div class="cl">
    <!--
      ⚠ 这里曾有一条统计条（最新版本 / 项变更 / 生成于），已移除，别加回来。
      三项都是**读者已经能从别处一眼看到**的事实：最新版本号和日期就写在下面
      第一个版本卡片的标题行上，版本总数与条数由左栏时间线的月份分组承担。
      放在正文最上方的结果是：真正的内容（第一个版本的变更）被挤到首屏之下，
      读者进来第一眼看到的是三个自己已经知道的数字。
      要展示元信息，先回答「它比紧邻的内容更值得占第一屏吗」。
    -->

    <!-- ── 独立搜索：只搜更新日志，与全站搜索互不干扰 ── -->
    <div class="cl-filter">
      <div class="cl-search">
        <input
          v-model="query"
          type="search"
          class="cl-input"
          placeholder="在更新日志里搜索，例如：权限、缓存、超时…"
          aria-label="搜索更新日志"
          autocomplete="off"
        />
        <button
          v-if="isFiltering"
          class="cl-reset"
          type="button"
          aria-label="清除筛选条件"
          @click="reset"
        >
          清除
        </button>
      </div>
      <div class="cl-chips" role="group" aria-label="按变更类型筛选">
        <button
          v-for="s in sectionTotals"
          :key="s.key"
          type="button"
          class="cl-chip"
          :class="[`cl-chip-${s.key}`, { 'is-active': activeSection === s.key }]"
          :aria-pressed="activeSection === s.key"
          @click="toggleSection(s.key)"
        >
          {{ s.title }}<i>{{ s.total }}</i>
        </button>
      </div>
      <p v-if="isFiltering" class="cl-hint">
        命中 <b>{{ matchCount }}</b> 项变更，分布在 <b>{{ filtered.length }}</b> 个版本
      </p>
    </div>

    <!-- ── 版本时间线 ── -->
    <p v-if="filtered.length === 0" class="cl-empty">
      没有匹配的变更。换个关键词，或
      <button type="button" class="cl-link" @click="reset">清除筛选</button>。
    </p>

    <!--
      :id 走 versionAnchor()，与左栏时间线的 link hash **同源**。
      左栏在 changelog-meta.ts 里用同一个函数生成 `/changelog#v0.1.598`；
      两边各自拼字符串的话，锚点对不上是静默故障（能点、URL 变、页面不动）。
    -->
    <article
      v-for="v in filtered"
      :key="v.version"
      :id="versionAnchor(v.version)"
      class="cl-version"
    >
      <div class="cl-vhead">
        <span class="cl-dot" aria-hidden="true"></span>
        <h2 class="cl-vtitle">v{{ v.version }}</h2>
        <time class="cl-date">{{ v.date }}</time>
        <span v-if="v.count" class="cl-vcount">{{ v.count }} 项</span>
      </div>

      <!--
        highlight：本版最值得说的一件事。放在版本卡外、正文之上，
        让扫读的人不点开也能知道这一版是干什么的。
      -->
      <p v-if="v.highlight" class="cl-highlight">{{ v.highlight }}</p>

      <!--
        userFacing=false 是一个**合法结论**（纯内部版本），不是数据缺失。
        必须显式说出来 —— 否则一个空白的版本块看起来就是「坏了」或「漏了」。
      -->
      <p v-if="!v.userFacing && v.sections.length === 0" class="cl-internal">
        本版没有用户可见的变更（内部改动、构建或文档）。
      </p>

      <div v-else class="cl-vbody">
        <section v-for="s in v.sections" :key="s.key" class="cl-group">
          <h3 class="cl-ghead">
            <span class="cl-badge" :class="`cl-badge-${s.key}`">{{ s.title }}</span>
            <span class="cl-gcount">{{ s.items.length }}</span>
          </h3>
          <ul class="cl-items">
            <li v-for="(it, i) in s.items" :key="i" class="cl-item">{{ it }}</li>
          </ul>
        </section>
      </div>
    </article>
  </div>
</template>

<style scoped>
/* 全部颜色走站点变量：深浅色自动跟随，不内联任何品牌色 */

.cl {
  margin-top: 8px;
}

/* 统计条（.cl-stats / .cl-stat）的样式随模板一起删除，理由见模板处注释。 */

/* ── 筛选区 ── */
.cl-filter {
  margin-bottom: 26px;
}
.cl-search {
  display: flex;
  gap: 8px;
}
.cl-input {
  flex: 1;
  min-width: 0;
  padding: 9px 14px;
  border: 1px solid var(--vp-c-divider);
  border-radius: 9px;
  background: var(--vp-c-bg);
  color: var(--vp-c-text-1);
  font-size: 13.5px;
  outline: none;
  transition:
    border-color 0.2s,
    box-shadow 0.2s;
}
.cl-input:focus {
  border-color: var(--vp-c-brand-1);
  box-shadow: 0 0 0 3px var(--vp-c-brand-soft);
}
.cl-input::placeholder {
  color: var(--vp-c-text-3);
}
.cl-reset,
.cl-link {
  padding: 0 14px;
  border: 1px solid var(--vp-c-divider);
  border-radius: 9px;
  background: var(--vp-c-bg-soft);
  color: var(--vp-c-text-2);
  font-size: 13px;
  cursor: pointer;
  transition:
    color 0.2s,
    border-color 0.2s;
}
.cl-reset:hover,
.cl-link:hover {
  color: var(--vp-c-brand-1);
  border-color: var(--vp-c-brand-1);
}
.cl-link {
  padding: 1px 8px;
  border-radius: 6px;
  font-size: inherit;
}
.cl-reset:focus-visible,
.cl-link:focus-visible,
.cl-chip:focus-visible,
.cl-input:focus-visible {
  outline: 2px solid var(--vp-c-brand-1);
  outline-offset: 2px;
}

.cl-chips {
  display: flex;
  flex-wrap: wrap;
  gap: 7px;
  margin-top: 11px;
}
.cl-chip {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 3px 11px;
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
.cl-chip i {
  font-family: var(--vp-font-family-mono);
  font-style: normal;
  font-size: 11px;
  color: var(--vp-c-text-3);
}
.cl-chip:hover {
  border-color: var(--vp-c-brand-1);
  color: var(--vp-c-brand-1);
}
/* 选中态不只靠颜色：加粗 + 实心底，避免色觉障碍用户无法分辨 */
.cl-chip.is-active {
  background: var(--vp-c-brand-soft);
  border-color: var(--vp-c-brand-1);
  color: var(--vp-c-brand-1);
  font-weight: 600;
}
.cl-chip.is-active i {
  color: var(--vp-c-brand-1);
}

.cl-hint {
  margin: 11px 0 0;
  font-size: 13px;
  color: var(--vp-c-text-3);
}
.cl-hint b {
  color: var(--vp-c-text-1);
  font-family: var(--vp-font-family-mono);
}

/* ── 版本卡 ── */
.cl-version {
  margin-bottom: 24px;
  scroll-margin-top: 96px; /* 锚点跳转不被顶栏遮住 */
}
.cl-vhead {
  display: flex;
  align-items: center;
  gap: 11px;
  margin-bottom: 10px;
  flex-wrap: wrap;
}
.cl-dot {
  width: 10px;
  height: 10px;
  border-radius: 50%;
  background: var(--vp-c-brand-2);
  box-shadow: 0 0 0 4px var(--vp-c-brand-soft);
  flex-shrink: 0;
}
/* 覆盖 vp-doc 给 h2 的上边距与分隔线：这里的 h2 是卡片标题不是章节标题 */
.cl-vtitle {
  margin: 0 !important;
  padding: 0 !important;
  border: 0 !important;
  font-family: var(--vp-font-family-mono);
  font-size: 20px;
  font-weight: 700;
  letter-spacing: 0.3px;
  color: var(--vp-c-brand-1);
  line-height: 1.4;
}
.cl-date {
  font-family: var(--vp-font-family-mono);
  font-size: 12px;
  color: var(--vp-c-text-3);
}
.cl-vcount {
  margin-left: auto;
  font-family: var(--vp-font-family-mono);
  font-size: 11px;
  color: var(--vp-c-text-2);
  background: var(--vp-c-bg-soft);
  border: 1px solid var(--vp-c-divider);
  padding: 2px 10px;
  border-radius: 999px;
}

/* highlight：一句话说清这一版。左侧竖线是唯一的装饰，不用底色抢焦点 */
.cl-highlight {
  margin: 0 0 12px !important;
  padding-left: 12px;
  border-left: 3px solid var(--vp-c-brand-2);
  color: var(--vp-c-text-1);
  font-size: 15px;
  font-weight: 600;
  line-height: 1.6;
}

/* 纯内部版本：淡色一行，明确说出「不是漏了」 */
.cl-internal {
  margin: 0 !important;
  padding: 10px 0 4px;
  color: var(--vp-c-text-3);
  font-size: 13.5px;
}

.cl-vbody {
  border: 1px solid var(--vp-c-divider);
  border-radius: 12px;
  background: var(--vp-c-bg);
  padding: 4px 20px 12px;
}

/* ── 分组 ── */
.cl-group {
  padding: 13px 0;
  border-bottom: 1px solid var(--vp-c-gutter);
}
.cl-group:last-child {
  border-bottom: none;
}
.cl-ghead {
  margin: 0 0 9px !important;
  padding: 0 !important;
  border: 0 !important;
  display: flex;
  align-items: center;
  gap: 9px;
  line-height: 1.5;
}
.cl-badge {
  font-size: 12px;
  font-weight: 700;
  padding: 3px 11px;
  border-radius: 7px;
  border: 1px solid var(--vp-c-divider);
  background: var(--vp-c-bg-soft);
  color: var(--vp-c-text-2);
}
/* 分组语义色：与 TUI/品牌变量同源（brand.css 的 --sid-feat 等），
   对比度已实测达 AA（浅色 5.25–6.38 / 深色 6.73–9.24）。 */
.cl-badge-breaking,
.cl-chip-breaking.is-active {
  color: var(--sid-breaking);
  border-color: var(--sid-breaking);
}
.cl-badge-feat,
.cl-chip-feat.is-active {
  color: var(--sid-feat);
  border-color: var(--sid-feat);
}
.cl-badge-improve,
.cl-chip-improve.is-active {
  color: var(--sid-perf);
  border-color: var(--sid-perf);
}
.cl-badge-fix,
.cl-chip-fix.is-active {
  color: var(--sid-fix);
  border-color: var(--sid-fix);
}
/* 破坏性变更的徽章额外给一层底色：它是用户升级前最该先看到的一类，
   只靠边框色在一屏多个徽章里不够显眼。 */
.cl-badge-breaking {
  background: var(--sid-breaking-soft);
}
.cl-gcount {
  font-family: var(--vp-font-family-mono);
  font-size: 11px;
  color: var(--vp-c-text-3);
}

/* ── 条目 ── */
.cl-items {
  list-style: none;
  margin: 0 !important;
  padding: 0 !important;
}
.cl-item {
  margin: 0 !important;
  padding: 3px 0 3px 15px;
  position: relative;
  color: var(--vp-c-text-1);
  font-size: 14.5px;
  line-height: 1.75;
}
.cl-item::before {
  content: "·";
  position: absolute;
  left: 2px;
  color: var(--vp-c-brand-2);
  font-weight: 700;
}

.cl-empty {
  padding: 22px 0;
  color: var(--vp-c-text-3);
  font-size: 14px;
}

/* ── 无障碍：跟随系统「减少动效」 ── */
@media (prefers-reduced-motion: reduce) {
  .cl-input,
  .cl-chip,
  .cl-reset,
  .cl-link {
    transition: none;
  }
}

@media (max-width: 640px) {
  .cl-vbody {
    padding: 4px 14px 12px;
  }
  .cl-vcount {
    margin-left: 0;
  }
}
</style>
