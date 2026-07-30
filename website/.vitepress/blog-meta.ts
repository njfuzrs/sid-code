/**
 * 文章（/blog/）元数据的**唯一事实源**。
 *
 * ## 为什么要有这个文件
 *
 * 文章列表需要在三个地方出现：
 *   1. `config.ts` 的 sidebar（进 /blog/ 后左侧那条目录）
 *   2. `theme/blog.data.ts` → `BlogIndex.vue`（列表页卡片）
 *   3. `scripts/docs-gen-reference.ts` 生成的 llms.txt（给大模型读的全站索引）
 *
 * 前两处都在本文件汇聚，靠**扫目录**得到列表，不手写清单。手写清单必然漂移：
 * 新增一篇文章要改三处，漏一处就是「站内有页面但 sidebar 里点不到」这种静默缺陷。
 * 第 3 处本来就是扫全站 md，天然不需要维护。
 *
 * ## 为什么不用 createContentLoader
 *
 * VitePress 的 `createContentLoader` 只能在 `*.data.ts` 里用，`config.ts` 拿不到它的结果。
 * 若 sidebar 走一套解析、列表页走另一套，两边的日期/标题口径可能不一致（比如
 * 一边把 `date` 当字符串、一边当 Date）。直接用 node:fs 读一次，两边共用同一份数据。
 *
 * ## frontmatter 约定（写新文章时照抄）
 *
 * ```yaml
 * ---
 * title: JIT 上下文
 * description: 一句话说明这篇讲什么，会显示在列表卡片与 llms.txt 里。
 * date: "2026-07-31"        # ⚠ 必须加引号，见下方 parseDate 说明
 * tags: [上下文工程, 实测]
 * ---
 * ```
 *
 * `date` **必须加引号**：不加引号时 YAML 会解析成 Date 对象，VitePress 序列化到
 * 前端会变成 `2026-07-31T00:00:00.000Z` 这种带时区的形态，在 UTC+8 显示会退回前一天。
 * 加引号让它在本文件、VitePress frontmatter、前端组件三处都是同一个字符串。
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

/** website/ 根目录（本文件在 website/.vitepress/ 下） */
const WEBSITE_ROOT = join(import.meta.dirname, "..");
const BLOG_DIR = join(WEBSITE_ROOT, "blog");

export interface BlogPost {
  /** 站内 URL，与 cleanUrls: true 一致（无 .html） */
  url: string;
  title: string;
  /** 列表卡片上的一句话摘要，取 frontmatter.description */
  description: string;
  /** ISO 日期串 YYYY-MM-DD；缺失则空串（排序时沉到最后） */
  date: string;
  tags: string[];
  /** 预估阅读分钟数，见 estimateReadingMinutes */
  readingMinutes: number;
}

/**
 * 极简 frontmatter 解析：只认 `key: value` 与 `key: [a, b]` 两种形态。
 *
 * 刻意不引 gray-matter —— 站点依赖树目前只有 vitepress 一个直接依赖，
 * 为解析十来行 frontmatter 加一个依赖不划算。这里的输入是我们自己写的文章，
 * 形态可控；真需要 YAML 全量特性（嵌套、多行字符串）时再换。
 */
function parseFrontmatter(raw: string): {
  data: Record<string, string | string[]>;
  body: string;
} {
  if (!raw.startsWith("---")) return { data: {}, body: raw };
  const end = raw.indexOf("\n---", 3);
  if (end < 0) return { data: {}, body: raw };

  const data: Record<string, string | string[]> = {};
  for (const line of raw.slice(4, end).split("\n")) {
    const m = line.match(/^([a-zA-Z][a-zA-Z0-9_]*):\s*(.*)$/);
    if (!m) continue;
    const key = m[1];
    let value = m[2].trim();
    if (value.startsWith("[") && value.endsWith("]")) {
      data[key] = value
        .slice(1, -1)
        .split(",")
        .map((s) => s.trim().replace(/^["']|["']$/g, ""))
        .filter(Boolean);
    } else {
      data[key] = value.replace(/^["']|["']$/g, "");
    }
  }
  // +4 跳过 "\n---"，再跳过该行剩余部分
  const bodyStart = raw.indexOf("\n", end + 1);
  return { data, body: bodyStart < 0 ? "" : raw.slice(bodyStart + 1) };
}

/**
 * 预估阅读时长。
 *
 * 口径写在这里而不是让读者猜：中文按 400 字/分钟、英文按 200 词/分钟，
 * 两者加权后向上取整，最少 1 分钟。代码块**计入**统计——技术文章里代码是要读的，
 * 剔掉会让长代码文章显示得比实际快很多。
 *
 * 这是个估值，不追求精确；它的作用是让读者判断「现在有没有时间读」。
 */
export function estimateReadingMinutes(body: string): number {
  const cjk = (body.match(/[一-鿿぀-ヿ]/g) ?? []).length;
  const latin = (body.match(/[A-Za-z0-9_]+/g) ?? []).length;
  return Math.max(1, Math.ceil(cjk / 400 + latin / 200));
}

/**
 * 扫 website/blog/ 下的文章，按日期倒序返回。
 *
 * 排除 index.md（那是列表页容器本身，不是文章——把它算进文章列表会出现
 * 「列表里第一条链接指向列表自己」这种自指条目）。
 */
export function loadBlogPosts(): BlogPost[] {
  let files: string[];
  try {
    files = readdirSync(BLOG_DIR).filter((f) => f.endsWith(".md") && f !== "index.md");
  } catch {
    // blog 目录还不存在时返回空列表，而不是让整个站点配置加载失败
    return [];
  }

  const posts: BlogPost[] = [];
  for (const file of files) {
    const raw = readFileSync(join(BLOG_DIR, file), "utf8");
    const { data, body } = parseFrontmatter(raw);
    const slug = file.replace(/\.md$/, "");
    const h1 = body.match(/^#\s+(.+)$/m);
    posts.push({
      url: `/blog/${slug}`,
      title: (data.title as string) || (h1 ? h1[1].trim() : slug),
      description: (data.description as string) || "",
      date: (data.date as string) || "",
      tags: Array.isArray(data.tags) ? data.tags : [],
      readingMinutes: estimateReadingMinutes(body),
    });
  }

  // 日期倒序（新的在前）；无日期的沉到最后，而不是靠字符串比较随机插在中间
  return posts.sort((a, b) => {
    if (!a.date) return 1;
    if (!b.date) return -1;
    return b.date.localeCompare(a.date);
  });
}
