/**
 * /changelog 左侧「版本时间线」的**唯一事实源**。
 *
 * ## 为什么需要这个文件
 *
 * 改造前 `/changelog` 是全站唯一**没有左栏**的内容页：`config.ts` 的 `sidebar` 是按
 * 路径前缀分组的对象（`/start/` `/use/` `/extend/` `/blog/` `/ref/` `/team/`），
 * 但没有 `/changelog` 这个 key。VitePress 的 `getSidebar`
 * （`theme-default/support/sidebar.js`）按前缀找不到命中项就返回 `[]`，
 * `hasSidebar` 随之为 false。构建产物是直接证据：修复前 `dist/changelog.html` 的
 * `<div class="Layout">` 只有 `has-aside`，而 `dist/use/context.html` 有 `has-sidebar`。
 * 于是这一页比全站任何一页都窄、且没有任何导航。
 *
 * 而左栏恰恰是时间线该待的地方。读者打开更新日志的第一个问题是
 * **「发过哪些版本、各自什么时候发的」**——这是一份目录能一眼回答的事，
 * 不该让人在正文里滚几十屏去数。
 *
 * ## 左栏为什么是**时间线**而不是主题目录
 *
 * 其它 Tab 的左栏回答「这一层有哪些主题」，因为那些内容有多根轴（难度、领域、场景）。
 * changelog 只有一根轴：**时间**。硬给它编一套主题分类（比如「性能相关」「权限相关」）
 * 就是无中生有一根不存在的轴，而且和正文里已有的分类徽章（新功能/修复/…）重复。
 *
 * ## 为什么从 JSON 派生，而不是手写清单
 *
 * 与 `blog-meta.ts` 同一个理由（那份注释里已论证过一遍）：手写必然漂移。
 * 每次发版都新增一个版本，手写清单意味着 `release.sh` 之外还要有人记得改 sidebar，
 * 漏一次就是「站内有这个版本但左栏点不到」这种**静默**缺陷——页面不报错，
 * 只是少一条，没人会发现。
 *
 * 数据源 `data/changelog.json` 由 `scripts/generate-changelog.ts` 在发版时从 git 历史
 * 重建，`theme/Changelog.vue` 也静态 import 同一份。这里是**第二个消费方**，
 * 不是第二份数据。
 */
import changelogData from "./data/changelog.json";

/** VitePress sidebar 的最小形状（只用到这几个字段，不引 vitepress 的类型省一层耦合） */
export interface TimelineItem {
  text: string;
  link: string;
}
export interface TimelineGroup {
  text: string;
  collapsed: boolean;
  items: TimelineItem[];
}

interface ChangelogVersion {
  version: string;
  date: string;
}

/**
 * 把 `YYYY-MM-DD` 切成分组键与展示文案。
 *
 * 刻意用字符串切片而不是 `new Date(...)`：日期在 JSON 里已经是 `YYYY-MM-DD` 字符串，
 * 过一遍 Date 会引入时区问题——UTC+8 环境下 `new Date("2026-08-01").getMonth()`
 * 在某些运行时会退回 7 月。这个坑 `blog-meta.ts` 的 frontmatter 约定里踩过一次
 * （见那份文件关于 `date` 必须加引号的说明），不再踩第二遍。
 */
function monthKey(date: string): string {
  return date.slice(0, 7); // "2026-08"
}

function monthLabel(key: string): string {
  const [year, month] = key.split("-");
  // 去掉月份前导零：「2026 年 8 月」而不是「2026 年 08 月」
  return `${year} 年 ${Number(month)} 月`;
}

/** 版本条目的展示文案：`v0.1.600 · 08-06`（日期省掉年份，年份已在组标题上） */
function itemLabel(v: ChangelogVersion): string {
  return `v${v.version} · ${v.date.slice(5)}`;
}

/**
 * 锚点 id 的**单一来源**。
 *
 * `Changelog.vue` 渲染版本块时用 `:id="versionAnchor(v.version)"`，这里生成 link 的
 * hash 部分也用它。两处必须同源：锚点对不上是这个设计唯一的致命故障——
 * 左栏能点、URL 会变、但页面不动，看起来就是坏了，且不会有任何报错。
 * `tests/website/changelog-integration.test.ts` 另有一条断言把它钉住。
 */
export function versionAnchor(version: string): string {
  return `v${version}`;
}

/**
 * 按月分组的版本时间线。
 *
 * ## 组内顺序：直接沿用 JSON 的顺序，不重排
 *
 * 生成器已经保证 `versions` 是最新在前（`changelog-integration.test.ts` 有一条
 * 「最新版本排在最前」的断言钉住）。这里、`Changelog.vue`、生成器三处都各自
 * 重排一次的话，三套排序逻辑迟早分叉，而分叉的症状是「左栏顺序和正文顺序不一致」，
 * 又是一个不报错的静默缺陷。
 *
 * ## collapsed：只展开最新月
 *
 * 依据是 `config.ts` GUIDE_SIDEBAR 注释里那条判据——**扫得完才叫目录，
 * 扫不完就只是一堵墙**。当前 19 个版本平铺勉强能扫，但按已有节奏
 * （2026-07 一个月发了 16 版）三个月后就是 60 条一堵墙。
 * 只展开最新月，默认可见条目稳定在个位数，且「最近发了什么」是绝大多数人来这一页的目的。
 *
 * 折叠不挡深链：VitePress 的 `useSidebarControl` 里
 * `(isActiveLink || hasActiveLink) && (collapsed = false)`，且它把 `hash` 纳入了
 * `watch([page, item, hash], …)`——所以直接访问 `/changelog#v0.1.585` 时
 * 7 月那组会自动展开并高亮，读者不会「进来看不到自己在哪」。
 *
 * ## 为什么不做「最近 N 个 + 归档组」
 *
 * 那是另一个候选方案（最近 10 个平铺，其余折进「更早版本」）。否决理由：
 * 「更早」那一组会无限膨胀，等于把同一堵墙挪到里层——点开之后依旧是几十条平铺，
 * 而且失去了「哪个月发得密」这个信息。按月分组的组数增长是每月 +1，
 * 而组内条数天然有上限。
 */
export const CHANGELOG_SIDEBAR: TimelineGroup[] = buildTimeline(
  changelogData.versions as ChangelogVersion[],
);

export function buildTimeline(versions: ChangelogVersion[]): TimelineGroup[] {
  // Map 保插入顺序：versions 已是降序，所以组的顺序自然也是最新月在前
  const byMonth = new Map<string, ChangelogVersion[]>();
  for (const v of versions) {
    const key = monthKey(v.date);
    const bucket = byMonth.get(key);
    if (bucket) bucket.push(v);
    else byMonth.set(key, [v]);
  }

  return [...byMonth.entries()].map(([key, items], index) => ({
    // 组标题带条数：让折叠着的组也能回答「这个月发了多少版」
    text: `${monthLabel(key)}（${items.length}）`,
    collapsed: index !== 0,
    items: items.map((v) => ({
      text: itemLabel(v),
      link: `/changelog#${versionAnchor(v.version)}`,
    })),
  }));
}
