<script setup lang="ts">
/**
 * 官网 /changelog 页的渲染组件（2026-07-28：changelog 并入站点，不再是外链占位）。
 *
 * ── 为什么是组件 + JSON，不是生成 markdown ──
 *   生成 markdown 更省事，但会被 minisearch 纳入**全站**索引：几百条 commit 描述
 *   会把「搜 hook」「搜权限」这类正常查询冲成一片版本噪音。changelog 要的是
 *   **自己的**搜索框（只搜版本变更），所以走「构建期 JSON + 组件内过滤」，
 *   容器页 frontmatter 标 `search: false` 从全站索引里摘出去（config.ts 的
 *   `_render` 钩子负责执行）。
 *
 * ── 数据来源 ──
 *   `website/.vitepress/data/changelog.json`，由 scripts/generate-changelog.ts 在
 *   release.sh 发版时从 git 历史重建。这里是**静态 import**：数据在构建期烧进产物，
 *   浏览器零请求、无白屏、无 loading 态。代价是发版后要重发站点才更新
 *   （website-deploy.sh 有版本一致性 warn 兜住这条纪律）。
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

interface Commit {
  scope: string | null;
  desc: string;
  hash: string;
  details: string[];
}
interface Group {
  key: string;
  title: string;
  commits: Commit[];
}
interface Version {
  version: string;
  date: string;
  isGenesis: boolean;
  count: number;
  groups: Group[];
}

const changelog = data as unknown as {
  generatedAt: string;
  currentVersion: string;
  totalVersions: number;
  totalCommits: number;
  groupMeta: Array<{ key: string; title: string }>;
  versions: Version[];
};

const query = ref("");
/** 当前只看某一类变更（null = 全部）。点徽章切换，再点取消。 */
const activeGroup = ref<string | null>(null);

/**
 * 一条提交的可搜索文本：scope + 描述 + 全部细节 + hash 拼成一段。
 * 拼成整体而不是逐字段比，是为了让多词查询能跨字段命中
 * （例如 scope 是 `perf`、描述里有 `缓存`，搜「perf 缓存」应该中）。
 */
function haystack(c: Commit): string {
  return [c.scope ?? "", c.desc, c.hash, ...c.details].join(" ").toLowerCase();
}

/**
 * 多词 AND 匹配：按空白拆词，每个词都要出现才算命中。
 *
 * 刻意不做整串子串匹配 —— 那样搜「prompt cache」要求这两个词在原文里**紧邻**，
 * 而 changelog 里它们通常分散在描述和细节的不同位置（实测：prompt 9 条、
 * cache 6 条、"prompt cache" 0 条），用户输两个词却一条不中，看着像坏了。
 * 中文不分词，单个 token 仍是子串匹配，所以「缓存」这类查询照常工作。
 */
function commitMatches(c: Commit, terms: string[]): boolean {
  if (terms.length === 0) return true;
  const hay = haystack(c);
  return terms.every((t) => hay.includes(t));
}

/**
 * 过滤后的版本列表。搜索与分组筛选在同一处做，避免两套过滤路径。
 * 空分组、空版本直接不产出——比渲染出来再 display:none 干净，
 * 也让「没有匹配」这个状态只有一个判断点（filtered.length === 0）。
 */
const filtered = computed<Version[]>(() => {
  const terms = query.value.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const g = activeGroup.value;
  if (terms.length === 0 && !g) return changelog.versions;

  const out: Version[] = [];
  for (const v of changelog.versions) {
    const groups: Group[] = [];
    for (const grp of v.groups) {
      if (g && grp.key !== g) continue;
      const commits = grp.commits.filter((c) => commitMatches(c, terms));
      if (commits.length > 0) groups.push({ ...grp, commits });
    }
    if (groups.length > 0) {
      out.push({
        ...v,
        groups,
        count: groups.reduce((n, x) => n + x.commits.length, 0),
      });
    }
  }
  return out;
});

const matchCount = computed(() =>
  filtered.value.reduce((n, v) => n + v.count, 0),
);
const isFiltering = computed(() => !!query.value.trim() || !!activeGroup.value);

/** 每类变更的全量条数，供筛选徽章显示（不随过滤变化，否则筛完就归零没法切回） */
const groupTotals = computed(() => {
  const m = new Map<string, number>();
  for (const v of changelog.versions) {
    for (const g of v.groups) {
      m.set(g.key, (m.get(g.key) ?? 0) + g.commits.length);
    }
  }
  return changelog.groupMeta
    .map((g) => ({ ...g, total: m.get(g.key) ?? 0 }))
    .filter((g) => g.total > 0);
});

function toggleGroup(key: string) {
  activeGroup.value = activeGroup.value === key ? null : key;
}

function reset() {
  query.value = "";
  activeGroup.value = null;
}

/**
 * 搜索时自动展开细节：用户搜到的关键词可能就在折叠的 body 细节里，
 * 折着等于搜到了看不见。用 :open 绑定而不是 JS 操作 DOM。
 */
const autoOpen = computed(() => !!query.value.trim());

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
      ── 统计条 ──
      刻意**不放**「N 个版本」：左栏时间线按月列出全部版本、组标题自带条数，
      总数在那儿一眼可得。这里再放一遍就是同一事实的第二个显示位，
      而两个显示位迟早对不上（谁改了过滤逻辑忘了改另一处）。
    -->
    <div class="cl-stats">
      <div class="cl-stat">
        <b>v{{ changelog.currentVersion }}</b><span>最新版本</span>
      </div>
      <div class="cl-stat">
        <b>{{ changelog.totalCommits }}</b><span>项变更</span>
      </div>
      <div class="cl-stat">
        <b>{{ changelog.generatedAt }}</b><span>生成于</span>
      </div>
    </div>

    <!-- ── 独立搜索：只搜更新日志，与全站搜索互不干扰 ── -->
    <div class="cl-filter">
      <div class="cl-search">
        <input
          v-model="query"
          type="search"
          class="cl-input"
          placeholder="在更新日志里搜索：描述、scope、提交 hash…"
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
          v-for="g in groupTotals"
          :key="g.key"
          type="button"
          class="cl-chip"
          :class="[`cl-chip-${g.key}`, { 'is-active': activeGroup === g.key }]"
          :aria-pressed="activeGroup === g.key"
          @click="toggleGroup(g.key)"
        >
          {{ g.title }}<i>{{ g.total }}</i>
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
        <span v-if="v.isGenesis" class="cl-genesis" title="最初版本，汇总早期历史提交（仅列标题）">
          初始汇总
        </span>
        <time class="cl-date">{{ v.date }}</time>
        <span class="cl-vcount">{{ v.count }} 项</span>
      </div>

      <div class="cl-vbody">
        <section v-for="g in v.groups" :key="g.key" class="cl-group">
          <h3 class="cl-ghead">
            <span class="cl-badge" :class="`cl-badge-${g.key}`">{{ g.title }}</span>
            <span class="cl-gcount">{{ g.commits.length }}</span>
          </h3>
          <ul class="cl-commits">
            <li v-for="(c, i) in g.commits" :key="`${c.hash}-${i}`" class="cl-commit">
              <!-- 有细节 → 可折叠；无细节 → 平铺，不给一个点了没反应的箭头 -->
              <details v-if="c.details.length" :open="autoOpen">
                <summary>
                  <span class="cl-chev" aria-hidden="true">▸</span>
                  <span class="cl-head">
                    <span v-if="c.scope" class="cl-scope">{{ c.scope }}</span>
                    <span class="cl-desc">{{ c.desc }}</span>
                    <span v-if="c.hash" class="cl-hash">{{ c.hash }}</span>
                  </span>
                </summary>
                <ul class="cl-details">
                  <li v-for="(d, j) in c.details" :key="j">{{ d }}</li>
                </ul>
              </details>
              <span v-else class="cl-head cl-head-flat">
                <span v-if="c.scope" class="cl-scope">{{ c.scope }}</span>
                <span class="cl-desc">{{ c.desc }}</span>
                <span v-if="c.hash" class="cl-hash">{{ c.hash }}</span>
              </span>
            </li>
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

/* ── 统计条 ── */
.cl-stats {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
  margin-bottom: 20px;
}
.cl-stat {
  flex: 1 1 120px;
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 12px 16px;
  border: 1px solid var(--vp-c-divider);
  border-radius: 10px;
  background: var(--vp-c-bg-soft);
}
.cl-stat b {
  font-family: var(--vp-font-family-mono);
  font-size: 17px;
  font-weight: 700;
  color: var(--vp-c-brand-1);
  line-height: 1.4;
}
.cl-stat span {
  font-size: 12px;
  color: var(--vp-c-text-3);
}

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
  font-family: var(--vp-font-family-mono);
  font-size: 13px;
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
  margin-bottom: 12px;
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
.cl-genesis {
  font-size: 11px;
  color: var(--vp-c-text-3);
  border: 1px dashed var(--vp-c-divider);
  padding: 1px 8px;
  border-radius: 999px;
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
/* 分组语义色：与 TUI/品牌变量同源（brand.css 的 --sid-feat 等） */
.cl-badge-feat,
.cl-chip-feat.is-active {
  color: var(--sid-feat);
  border-color: var(--sid-feat);
}
.cl-badge-fix,
.cl-chip-fix.is-active {
  color: var(--sid-fix);
  border-color: var(--sid-fix);
}
.cl-badge-refactor,
.cl-chip-refactor.is-active {
  color: var(--sid-brand-strong);
  border-color: var(--sid-brand-strong);
}
.cl-badge-perf,
.cl-chip-perf.is-active {
  color: var(--sid-perf);
  border-color: var(--sid-perf);
}
.cl-badge-docs,
.cl-chip-docs.is-active {
  color: var(--sid-docs);
  border-color: var(--sid-docs);
}
.cl-gcount {
  font-family: var(--vp-font-family-mono);
  font-size: 11px;
  color: var(--vp-c-text-3);
}

/* ── 提交条目 ── */
.cl-commits {
  list-style: none;
  margin: 0 !important;
  padding: 0 !important;
}
.cl-commit {
  margin: 0 !important;
  padding: 3px 0;
}
.cl-head {
  display: inline-flex;
  align-items: baseline;
  gap: 8px;
  flex-wrap: wrap;
}
.cl-scope {
  font-family: var(--vp-font-family-mono);
  font-size: 11px;
  font-weight: 600;
  color: var(--vp-c-brand-1);
  background: var(--vp-c-brand-soft);
  padding: 1px 8px;
  border-radius: 6px;
}
.cl-desc {
  color: var(--vp-c-text-1);
  font-size: 14.5px;
}
.cl-hash {
  font-family: var(--vp-font-family-mono);
  font-size: 11px;
  color: var(--vp-c-text-3);
  background: var(--vp-c-bg-soft);
  border: 1px solid var(--vp-c-divider);
  padding: 0 6px;
  border-radius: 5px;
}

.cl-commit details summary {
  list-style: none;
  cursor: pointer;
  display: flex;
  align-items: baseline;
  gap: 5px;
  padding: 2px 4px 2px 0;
  border-radius: 6px;
  transition: background 0.15s;
}
.cl-commit details summary:hover {
  background: var(--vp-c-bg-soft);
}
.cl-commit details summary::-webkit-details-marker {
  display: none;
}
.cl-commit details summary:focus-visible {
  outline: 2px solid var(--vp-c-brand-1);
  outline-offset: 2px;
}
.cl-chev {
  color: var(--vp-c-text-3);
  font-size: 11px;
  transition: transform 0.15s;
  display: inline-block;
  flex-shrink: 0;
}
.cl-commit details[open] .cl-chev {
  transform: rotate(90deg);
  color: var(--vp-c-brand-1);
}
.cl-head-flat {
  padding-left: 16px; /* 与有箭头的条目左端对齐 */
}

.cl-details {
  list-style: none;
  margin: 4px 0 8px 6px !important;
  padding: 8px 14px !important;
  border-left: 2px solid var(--vp-c-brand-soft);
  background: var(--vp-c-bg-soft);
  border-radius: 0 8px 8px 0;
}
.cl-details li {
  margin: 0 !important;
  color: var(--vp-c-text-2);
  font-size: 13px;
  padding: 2px 0 2px 14px;
  position: relative;
  line-height: 1.6;
}
.cl-details li::before {
  content: "›";
  position: absolute;
  left: 0;
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
  .cl-link,
  .cl-chev,
  .cl-commit details summary {
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
