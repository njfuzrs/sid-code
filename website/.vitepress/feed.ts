/**
 * Atom feed 生成（构建期，由 config.ts 的 `buildEnd` 调用）。
 *
 * ## 为什么手写而不引 feed 库
 *
 * 站点依赖树目前只有 vitepress 一个直接依赖（见 blog-meta.ts 同款理由）。
 * Atom 的最小合法文档就是下面这几十行 XML，输入是我们自己写的文章、字段可控，
 * 为此引一个包（及其传递依赖）不划算。真需要 podcast/media 扩展时再换。
 *
 * ## 为什么是 Atom 而不是 RSS 2.0
 *
 * Atom（RFC 4287）强制要求 `<id>` 与 `<updated>`，日期格式是 RFC 3339 单一形态；
 * RSS 2.0 的 `<guid>` 是可选的、日期用 RFC 822，实现之间对"没有 guid 时怎么去重"
 * 各行其是。既然要手写，选规范更严的那个：错的可能性更小。
 * 文件名仍叫 `feed.xml`（而不是 `atom.xml`）——阅读器认 content-type 与文档根元素，
 * 不认扩展名，而 `feed.xml` 是读者更可能猜到的路径。
 *
 * ## 未配置域名时不生成
 *
 * feed 必须是绝对 URL，理由与"为什么不能先用 IP 凑合"一并写在 site.ts 里。
 */
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { BlogPost } from "./blog-meta";
import {
  FEED_PATH,
  SITE_DESCRIPTION,
  SITE_TITLE,
  absoluteUrl,
  canUseAbsoluteUrls,
  siteHostname,
} from "./site";

/**
 * XML 文本转义。
 *
 * 五个字符全转，不只转 `&<>`：属性值里出现裸引号会截断属性，
 * 而本文件的 `<title>`/`<summary>` 内容来自 frontmatter，里面有中英文引号是常态。
 */
function xmlEscape(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/**
 * `YYYY-MM-DD` → RFC 3339 时间戳。
 *
 * 文章 frontmatter 只有日期没有时刻。补 `T00:00:00+08:00` 而不是 `Z`：
 * 本站作者时区是 UTC+8，写 `Z` 会让 8 月 4 日的文章在阅读器里显示成 8 月 3 日
 * ——这正是 blog-meta.ts 里 `date` 必须加引号所要防的同一类时区错位。
 */
function toRfc3339(date: string): string {
  return /^\d{4}-\d{2}-\d{2}$/.test(date) ? `${date}T00:00:00+08:00` : date;
}

/**
 * 生成 Atom XML 文本。导出供测试直接断言，不必先落盘。
 * 返回空串表示"未配置 hostname、本次不生成"。
 */
export function renderFeed(posts: BlogPost[]): string {
  if (!canUseAbsoluteUrls()) return "";

  const host = siteHostname();
  const feedUrl = absoluteUrl(FEED_PATH);
  // 频道 updated 取最新一篇的日期；没有文章时用最早的一个确定值而不是当前时间
  // ——用当前时间会让每次构建产出不同的 feed，订阅端每次都判定"有更新"。
  const updated = toRfc3339(posts.find((p) => p.date)?.date ?? "1970-01-01");

  const entries = posts
    .map((p) => {
      const url = absoluteUrl(p.url);
      // series 与 tags 去重后合并：系列名常常同时也是一个标签
      // （如「上下文工程」既是 series 又在 tags 里），不去重会输出两条相同的 category。
      const terms = [...new Set([p.series, ...p.tags].filter(Boolean))];
      const cats = terms.map((t) => `    <category term="${xmlEscape(t)}" />`).join("\n");
      // summary 里带上 highlight：阅读器列表页往往只显示 summary，
      // 硬数据那一行是这些文章最强的点击理由，不该只存在于网站上。
      const summary = [p.highlight, p.description].filter(Boolean).join(" —— ");
      return `  <entry>
    <title>${xmlEscape(p.title)}</title>
    <link href="${xmlEscape(url)}" />
    <id>${xmlEscape(url)}</id>
    <updated>${toRfc3339(p.date)}</updated>
    <summary>${xmlEscape(summary)}</summary>
${cats}
  </entry>`;
    })
    .join("\n");

  return `<?xml version="1.0" encoding="utf-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <title>${xmlEscape(SITE_TITLE)}</title>
  <subtitle>${xmlEscape(SITE_DESCRIPTION)}</subtitle>
  <link href="${xmlEscape(absoluteUrl("/blog/"))}" />
  <link rel="self" type="application/atom+xml" href="${xmlEscape(feedUrl)}" />
  <id>${xmlEscape(host)}/</id>
  <updated>${updated}</updated>
${entries}
</feed>
`;
}

/**
 * 写 feed 到产物目录。未配置 hostname 时**跳过并打印原因**。
 *
 * 打印那行提示是刻意的：静默跳过会变成"我明明实现了 RSS，线上却 404"
 * 这种最难查的现象——查代码看到实现是全的，查产物看到文件不存在，
 * 中间那一步"因为没配 hostname 所以没生成"没有任何信号。
 */
export function writeFeed(posts: BlogPost[], outDir: string): void {
  const xml = renderFeed(posts);
  if (!xml) {
    console.info(
      `[feed] 跳过 ${FEED_PATH}：尚未配置站点域名。` +
        `域名备案后在 .vitepress/site.ts 填 HOSTNAME（或传 SITE_HOSTNAME=... 构建）即自动生成。`,
    );
    return;
  }
  writeFileSync(join(outDir, ...FEED_PATH.replace(/^\//, "").split("/")), xml, "utf8");
  console.info(`[feed] 已生成 ${FEED_PATH}（${posts.length} 篇）`);
}
