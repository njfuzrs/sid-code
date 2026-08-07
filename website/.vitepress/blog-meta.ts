/**
 * 文章（/blog/）元数据的**唯一事实源**。
 *
 * ## 为什么要有这个文件
 *
 * 文章列表需要在多个地方出现：
 *   1. `config.ts` 的 sidebar（进 /blog/ 后左侧那条目录）
 *   2. `theme/blog.data.ts` → `BlogIndex.vue`（列表页卡片）/ `BlogPostFooter.vue`（文章页脚）
 *   3. `scripts/docs-gen-reference.ts` 生成的 llms.txt（给大模型读的全站索引）
 *   4. `config.ts` 的 buildEnd → RSS/Atom feed（域名到位后自动启用，见 site.ts）
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
 * series: 上下文工程         # 可选，必须是 SERIES 里的受控词，见下方说明
 * highlight: 19 会话实测基线 · 3 个静默缺陷   # 可选，卡片上的硬数据一行
 * featured: true            # 可选，强制置顶为特色大卡；不写则最新一篇自动特色
 * tags: [上下文工程, 实测]
 * ---
 * ```
 *
 * `date` **必须加引号**：不加引号时 YAML 会解析成 Date 对象，VitePress 序列化到
 * 前端会变成 `2026-07-31T00:00:00.000Z` 这种带时区的形态，在 UTC+8 显示会退回前一天。
 * 加引号让它在本文件、VitePress frontmatter、前端组件三处都是同一个字符串。
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

/** website/ 根目录（本文件在 website/.vitepress/ 下） */
const WEBSITE_ROOT = join(import.meta.dirname, "..");
const BLOG_DIR = join(WEBSITE_ROOT, "blog");
/** 仓库根：用于校验文章里的 `src/xxx.ts` 引用是否真的指向存在的文件 */
const REPO_ROOT = join(WEBSITE_ROOT, "..");

/**
 * ## 系列：受控词表，与 tags 分成两层
 *
 * `tags` 是自由词——作者想写什么写什么，只用于**展示**。
 * `series` 是**受控词**，只能取下面这几个，用于**筛选**与**文章间导航**。
 *
 * 为什么必须分两层：自由词表做筛选器会随文章数线性膨胀。实测当前 2 篇文章已经产出
 * 5 个标签，其中 3 个只对应 1 篇（点了等于直接点那篇）、2 个对应全部（点了等于「全部」），
 * 也就是说**没有一个能有效收窄**。而且那 5 个词混了三个维度：体裁（机制解析）、
 * 领域（上下文工程）、文章专属词（prompt cache）——没有层级，20 篇时会平铺成三四十个。
 *
 * 受控词表的个数由**内容规划**决定而不是由文章数决定，所以筛选器永远是这几个按钮。
 * 新增系列要改这里，这正是想要的效果：加一个系列是内容架构决策，该有一次显式改动。
 *
 * `order` 决定筛选器里的排列顺序（不按文章数排——那会让按钮位置随发文而跳动，
 * 读者建立不起肌肉记忆）。`blurb` 是筛选后显示的一句话，说明这个系列在讲什么。
 */
export interface Series {
  name: string;
  order: number;
  blurb: string;
  /**
   * 这个系列解析的是**外部代码**，不是 sid-code 自己的实现。
   *
   * 唯一作用：关掉「N 处源码引证」这个指标（见 `countEvidenceFiles` 与
   * `BlogPost.evidenceFiles`）。那个指标的语义是「本文引证了 N 个 **sid-code**
   * 源文件」，用来支撑「带 file 级证据」的主张。解析别人代码的文章套用它是
   * **归属错误**——而且实测真的会误报：sid-code 的 `src/ink/` 与 Claude Code
   * 那份快照同源，于是 CC 的路径在本仓库里真实存在、`existsSync` 会通过，
   * 21 篇里有 23 处碰撞（`src/ink/reconciler.ts` 这类），最多的一篇会显示
   * 「15 处源码引证」。一个用来支撑可信度的数字本身不实，比不显示更糟。
   *
   * 刻意不在 `countEvidenceFiles` 里加「排除 src/ink/」白名单：治不了根
   * （`src/bridge/types.ts` 这类同名巧合会继续漏），且每加一个 vendor 目录
   * 都要回来改。按系列关掉是**数据驱动**的——新增外部解析系列只需加这个字段。
   */
  external?: boolean;
}

export const SERIES: Series[] = [
  {
    name: "上下文工程",
    order: 1,
    blurb: "规则 / 提示词 / 压缩 / cache —— 什么内容在什么时刻进入上下文，以什么代价。",
  },
  {
    name: "数据与度量",
    order: 2,
    blurb: "轨迹底座 —— 度量不是「验收达没达标」，而是「确认每一步是不是在朝北极星走」。",
  },
  {
    name: "Agent 架构",
    order: 3,
    blurb: "主循环、子代理、会话管理 —— agent 怎么跑起来的。",
  },
  {
    name: "安全与权限",
    order: 4,
    blurb: "拦截链、HITL、防线体系 —— 「更安全」是怎么落地的。",
  },
  {
    name: "TUI",
    order: 5,
    blurb: "Ink/React 渲染管线 —— 终端里的像素是怎么画出来的。",
  },
  {
    name: "工程踩坑",
    order: 6,
    blurb: "切口更小，但坑够深 —— 单篇讲透一个事故或一个设计的演进。",
  },
  {
    /**
     * 唯一一个**不是**自家实测的系列：解析别人的代码。
     *
     * 前 6 个系列的共同点是「我们测过」（`博客写作标准.md` §0 的立意）；这一个的价值
     * 来源不同——「我们读透了一份 51 万行的参考实现」。两者都成立，但依据不同，
     * 所以 blurb 里**明说是读源码得出、不是实测**：读者要能分清哪层是哪层。
     *
     * 刻意不给它单独一套机制（独立顶栏入口 / 独立列表页 / 独立 sidebar）。
     * 那样会把博客切成两个入口、分散注意力，且同一件事有两套实现必然漂移。
     * 它就是博客的一个系列：同一个列表页、同一个 feed、同一份 sidebar 分组。
     *
     * 排在最后（order 7）：21 篇会在数量上压过其它系列，放前面等于让一个
     * 「解析别人代码」的系列占据入口最显眼的位置。
     */
    name: "Claude Code 源码解析",
    order: 7,
    blurb:
      "逐章拆一份 51 万行的 agent harness 参考实现（2026-03-31 源码快照）—— " +
      "结论来自读源码，不是实测数据，与其它系列不是同一种依据。共 21 篇，按顺序读。",
    external: true,
  },
];

const SERIES_BY_NAME = new Map(SERIES.map((s) => [s.name, s]));

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
  /** 所属系列名（受控词，见 SERIES）；未标注则空串 */
  series: string;
  /** 卡片上那行硬数据摘要；未写则空串，卡片不渲染该行 */
  highlight: string;
  /** 是否人工指定为特色文章。都没指定时由 loadBlogPosts 把最新一篇标为特色 */
  featured: boolean;
  /**
   * 正文里**经过存在性校验**的源码文件引用数（去重后）。
   *
   * 只数真实存在于仓库里的路径。为什么要校验而不是直接数正则命中：文章里会出现
   * 演示用的假路径（jit-context 那篇的实验室样例 `src/a.ts`、`src/ui/b.ts` 等），
   * 直接数会把它们算进去，让「N 处源码引证」这个数字虚高——一个用来支撑
   * 「带证据」主张的指标本身不实，比不显示更糟。
   */
  evidenceFiles: number;
  /** 该文在所属系列内的序号（从 1 起，按日期升序=阅读顺序）；无系列则 0 */
  seriesIndex: number;
  /** 所属系列的文章总数；无系列则 0 */
  seriesTotal: number;
  /** 同系列上一篇（按阅读顺序）的 url/title；没有则 null */
  seriesPrev: { url: string; title: string } | null;
  /** 同系列下一篇（按阅读顺序）的 url/title；没有则 null */
  seriesNext: { url: string; title: string } | null;
  /** 相关文章（同系列优先，其次共享标签最多的），最多 3 条 */
  related: { url: string; title: string; reason: string }[];
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
 * 数正文里指向**真实存在**的源码文件的引用（去重）。
 *
 * 判据刻意收紧到「以 src/ | scripts/ | tests/ 开头 + 已知源码后缀」，且必须
 * `existsSync` 通过。三层收紧各有原因：
 *   · 限定前缀   —— 排除 `CLAUDE.md`、`~/.sid-code/xxx.jsonl` 这类非源码路径
 *   · 限定后缀   —— 排除裸 `.tsx`、`*.md` 通配这类不是具体文件的字符串
 *   · 存在性校验 —— 排除文章里的演示假路径（见 BlogPost.evidenceFiles 说明）
 *
 * 行号（`:123` / `:171-179`）在计数前剥掉：同一个文件被引用五处，算 1 个文件而不是 5。
 * 数「文件」而不是数「引用点」是有意的：后者在两篇实测文章上分别是 0 与 15，
 * 悬殊到没法当同一个指标展示（0 会渲染成「0 处引证」，正好出现在最强调证据的那篇上）。
 *
 * ⚠ 后缀候选里 `tsx` 必须排在 `ts` 前面。正则的 `|` 是**最左优先**而非最长优先，
 * 写成 `ts|tsx` 时 `Footer.tsx` 会在 `.ts` 处停下，切出不存在的 `Footer.ts`，
 * 于是一个真实文件被存在性校验静默判掉。同理 `mjs` 要在 `js` 之前。
 */
export function countEvidenceFiles(body: string): number {
  const hits = body.match(/(?:src|scripts|tests)\/[A-Za-z0-9_./-]+\.(?:tsx|ts|mjs|js|vue|sh)/g);
  if (!hits) return 0;
  const real = new Set<string>();
  for (const hit of hits) {
    if (existsSync(join(REPO_ROOT, hit))) real.add(hit);
  }
  return real.size;
}

/** frontmatter 里 `featured: true` / `featured: yes` 都算真，其余算假 */
function parseBool(v: string | string[] | undefined): boolean {
  if (typeof v !== "string") return false;
  return /^(true|yes|1)$/i.test(v.trim());
}

/**
 * 校验 series 值。写错（拼写不一致、写了个没登记的新系列）时**构建期告警**，
 * 并把该文当作「无系列」处理，而不是静默生成一个只含它自己的孤儿分组。
 *
 * 不直接抛错中断构建：一篇文章的元数据写错不该让整站发布不了，
 * 但也不能没有信号——静默是最难排查的那种缺陷。
 */
function normalizeSeries(raw: string | string[] | undefined, file: string): string {
  if (typeof raw !== "string" || !raw.trim()) return "";
  const name = raw.trim();
  if (SERIES_BY_NAME.has(name)) return name;
  console.warn(
    `[blog-meta] ${file} 的 series「${name}」不在受控词表里，已按「无系列」处理。` +
      `可选值：${SERIES.map((s) => s.name).join(" / ")}（要新增系列请改 blog-meta.ts 的 SERIES）`,
  );
  return "";
}

/**
 * 算「相关文章」：同系列优先，其次按共享标签数排，最多 3 条。
 *
 * 刻意不做语义相似度：当前文章量级下（十几篇）标签重合度已经足够区分，
 * 引入 embedding 需要构建期跑模型，与「构建期纯 node:fs、零额外依赖」的现状不符。
 */
function computeRelated(post: BlogPost, all: BlogPost[]): BlogPost["related"] {
  const scored: { p: BlogPost; score: number; reason: string }[] = [];
  for (const other of all) {
    if (other.url === post.url) continue;
    const shared = other.tags.filter((t) => post.tags.includes(t)).length;
    const sameSeries = !!post.series && other.series === post.series;
    if (!sameSeries && shared === 0) continue;
    scored.push({
      p: other,
      // 同系列给一个足够大的基础分，保证它一定排在「仅共享标签」之前
      score: (sameSeries ? 100 : 0) + shared,
      reason: sameSeries ? `${post.series}系列` : `同标签 ${shared} 个`,
    });
  }
  return scored
    .sort((a, b) => b.score - a.score || b.p.date.localeCompare(a.p.date))
    .slice(0, 3)
    .map((s) => ({ url: s.p.url, title: s.p.title, reason: s.reason }));
}

/**
 * 扫 website/blog/ 下的文章，按日期倒序返回。
 *
 * 排除 index.md（那是列表页容器本身，不是文章——把它算进文章列表会出现
 * 「列表里第一条链接指向列表自己」这种自指条目）。
 *
 * 也排除 frontmatter 里 `search: false` **且** 无 date 的规划类页面？——不，
 * 判据用 date：文章一定有日期。没日期的页面（若有）沉到列表末尾，见下方排序。
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
    const series = normalizeSeries(data.series, file);
    posts.push({
      url: `/blog/${slug}`,
      title: (data.title as string) || (h1 ? h1[1].trim() : slug),
      description: (data.description as string) || "",
      date: (data.date as string) || "",
      tags: Array.isArray(data.tags) ? data.tags : [],
      readingMinutes: estimateReadingMinutes(body),
      series,
      highlight: (data.highlight as string) || "",
      featured: parseBool(data.featured),
      // 解析外部代码的系列不数引证：那个指标的语义绑定的是 sid-code 源码，
      // 且实测会因 src/ink/ 同源而误报（完整理由见 Series.external）。
      evidenceFiles: SERIES_BY_NAME.get(series)?.external ? 0 : countEvidenceFiles(body),
      // 下面四个字段需要全量文章才能算，先占位，扫完再回填
      seriesIndex: 0,
      seriesTotal: 0,
      seriesPrev: null,
      seriesNext: null,
      related: [],
    });
  }

  /**
   * 日期倒序（新的在前）；无日期的沉到最后，而不是靠字符串比较随机插在中间。
   *
   * ## 同一天多篇时的次级键：url
   *
   * `date` 只到天，一天发多篇时它给不出顺序，而 `readdirSync` 的返回顺序是
   * **文件系统决定的**（实测在 macOS 上既不是字典序也不是创建序）。少数几篇时
   * 这只是「同一天内部顺序随机」，不痛；但一次并入一个 21 篇的系列时它会
   * 明确出错——实测「引言」那篇被排到系列第 7 位，读者从左栏自上而下点，
   * 第一篇读到的是 MCP 集成，引言在中间。
   *
   * 用 url 作次级键（升序）就稳定了：文件名带序号前缀（`cc-00-` … `cc-20-`）时，
   * 字典序恰好是阅读顺序。这也是为什么系列文章的文件名值得带零填充的数字前缀
   * ——`cc-9-` 会排在 `cc-10-` 后面。
   */
  posts.sort((a, b) => {
    if (!a.date) return 1;
    if (!b.date) return -1;
    return b.date.localeCompare(a.date) || a.url.localeCompare(b.url);
  });

  // ── 回填系列内序号与前后篇 ──
  // 系列内按日期**升序**（= 阅读顺序：先发的是前置知识），与列表页的倒序无关。
  // 同日多篇时次级键同样是 url 升序（理由见上方排序说明：日期只到天，
  // 一天发多篇时它给不出顺序，而 readdirSync 的顺序由文件系统决定）。
  for (const s of SERIES) {
    const inSeries = posts
      .filter((p) => p.series === s.name)
      .sort((a, b) => a.date.localeCompare(b.date) || a.url.localeCompare(b.url));
    inSeries.forEach((p, i) => {
      p.seriesIndex = i + 1;
      p.seriesTotal = inSeries.length;
      const prev = inSeries[i - 1];
      const next = inSeries[i + 1];
      p.seriesPrev = prev ? { url: prev.url, title: prev.title } : null;
      p.seriesNext = next ? { url: next.url, title: next.title } : null;
    });
  }

  // ── 回填相关文章（依赖 series 已算好）──
  for (const p of posts) p.related = computeRelated(p, posts);

  // ── 特色文章：没有任何一篇人工标 featured 时，把最新一篇（即首条）标为特色 ──
  // 这样「特色大卡」永远有内容，不需要作者记着每次发文去移动那个标记。
  if (posts.length && !posts.some((p) => p.featured)) posts[0].featured = true;

  return posts;
}

/*
 * 这里曾有一个 computeBlogStats（全站文章数 / 累计时长 / 系列数 / 引证数之和），
 * 唯一消费者是列表页顶部那条四格统计条。统计条已删（理由见 BlogIndex.vue 里的
 * 那段注释：全站聚合数字不参与"挑哪一篇读"这个决定），于是它成了死代码，一并删掉。
 *
 * 逐篇的 readingMinutes 仍然渲染在卡片与文章页脚（BlogPostFooter）里。
 * evidenceFiles 的位置收窄过两次：先是 2026-08-05 精简页脚时从文章页移除
 * （读完之后它已由正文本身兑现），只留在列表页卡片上作为挑文章时的可信度信号；
 * 之后紧凑卡片上也删了，现在**只出现在列表页的特色大卡**（.bi-hero）上 ——
 * 紧凑卡片宽约 305px，它与 highlight 一起在跟摘要争同一块地方，
 * 而摘要是那里唯一能回答"这篇讲什么"的东西（见 BlogIndex.vue 模板里的说明）。
 * 字段本身仍然全量计算：特色大卡要用，且它是受控产出、不按消费方裁剪。
 * 删掉的只是"把它们加总成一个全站数字"这一层。
 */
