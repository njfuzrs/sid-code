/**
 * 站点绝对地址的**唯一事实源**，以及依赖它的功能的开关闸门。
 *
 * ## 为什么需要这个文件
 *
 * RSS/Atom feed 与 sitemap 都必须写**绝对 URL**（`<link>` 里写 `/blog/x` 的 feed
 * 在任何阅读器里都点不开）。而本站现在部署在 IP 上、域名还没备案下来
 * （见 config.ts 里 sitemap 那条注释：IP 阶段填 hostname 会返工）。
 *
 * 把 IP 硬编码进 feed 有两个具体代价，都不是"以后改一下"能补的：
 *   1. feed 的 `<id>`/`<guid>` 是订阅者侧的**去重主键**。用 IP 发布过之后再换域名，
 *      所有条目的 id 都变，已订阅的人会看到全部历史文章重新推送一遍。
 *   2. 阅读器会缓存 feed URL 自身。IP 那份失效后是静默不再更新，不是报错。
 *
 * 所以这里的选择不是"先用 IP 凑合"，而是**把功能完整实现、用一个显式开关挂起**：
 * `SITE_HOSTNAME` 一填，feed 与 sitemap 同时生效，代码零改动。
 *
 * ## 怎么启用
 *
 * 域名备案下来后，二选一：
 *   · 改下面的 `HOSTNAME` 常量为 `https://your-domain.com`（推荐，入库可追溯）
 *   · 或构建时传环境变量：`SITE_HOSTNAME=https://your-domain.com bun run build`
 *
 * 两者都不给时 `siteHostname()` 返回空串，`canUseAbsoluteUrls()` 为 false，
 * feed 与 sitemap 都不生成——**不是生成一份错的**。构建期会打印一行提示说明它被跳过了，
 * 免得变成"我配了 RSS 但线上 404"这种查不出原因的现象。
 */

/**
 * 正式域名。空串 = 尚未启用绝对 URL 类功能。
 * 域名到位后把它改成 `https://example.com`（**不要**带结尾斜杠，见 normalize）。
 */
const HOSTNAME = "";

/** 去掉结尾斜杠，避免拼出 `https://x.com//blog/y` 这种双斜杠 URL */
function normalize(raw: string): string {
  return raw.trim().replace(/\/+$/, "");
}

/**
 * 当前生效的站点绝对地址；未配置时为空串。
 * 环境变量优先于常量——CI 里想临时换域名构建一份预览时不必改代码。
 */
export function siteHostname(): string {
  return normalize(process.env.SITE_HOSTNAME || HOSTNAME);
}

/** 是否可以生成需要绝对 URL 的产物（RSS/Atom、sitemap） */
export function canUseAbsoluteUrls(): boolean {
  return siteHostname().length > 0;
}

/** 把站内路径（`/blog/x`）拼成绝对 URL；未配置 hostname 时原样返回 */
export function absoluteUrl(path: string): string {
  const host = siteHostname();
  if (!host) return path;
  return `${host}${path.startsWith("/") ? path : `/${path}`}`;
}

/** feed 的站内路径。写死在这里，供 config.ts 的 head 与 buildEnd 共用一个值。 */
export const FEED_PATH = "/blog/feed.xml";

/** 站点标题与描述：feed 的频道信息复用它们，避免和 config.ts 各写一份漂移 */
export const SITE_TITLE = "sid-code 博客";
export const SITE_DESCRIPTION =
  "sid-code 的机制解析与工程实测：一个机制为什么这么设计、实现里踩了哪些坑、实测数据是多少、当前边界在哪。";
