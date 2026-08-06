import { defineConfig } from "vitepress";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { tokenizeCJK } from "./tokenize";
import { stripFrontmatter } from "./raw-markdown";
import { SERIES, loadBlogPosts } from "./blog-meta";
import { CHANGELOG_SIDEBAR } from "./changelog-meta";
import { writeFeed } from "./feed";
import { FEED_PATH, SITE_TITLE, canUseAbsoluteUrls, siteHostname } from "./site";

/**
 * /blog/ 的 sidebar 从磁盘扫出来，**不手写清单**。
 * 手写必然漂移：新增一篇要改两处（sidebar + 文章文件），漏一处就是
 * 「站内有页面但 sidebar 点不到」这种静默缺陷。数据源与列表页共用
 * blog-meta.ts，所以两处顺序与标题永远一致。
 */
const blogPosts = loadBlogPosts();

/**
 * 「指南」这一层的**唯一**侧边栏，同时绑给 `/use/` 与 `/extend/` 两个前缀。
 *
 * ## 分组依据：读者要解决的问题，不是文件放在哪个目录
 *
 * 旧结构按目录分 Tab（use = 使用 / extend = 进阶定制），于是回答同一个问题的页面被
 * 拆到两个 Tab 里。最刺眼的一处：读者想「让它懂我这个项目的规矩」，
 * 最省力的做法是写 `CLAUDE.md`（在 use/），进一步是 Skill / Hook（在 extend/）——
 * 这是**同一条路径上难度递增的三级台阶**，却要跨 Tab 才能走完。
 *
 * 现在按主题成组，一组内部就是一条从轻到重的台阶，读者不用换 Tab 就能往下走：
 *
 *   上下文与记忆：  上下文压缩 → CLAUDE.md
 *   扩展能力：      总览选择表 → Skill → Hook → MCP → 插件
 *
 * ## 组的顺序 = 读者遇到问题的先后
 *
 * 装完第一天就会撞上的排在前（日常操作 → 权限），用熟了才关心的排在后
 * （扩展能力 → 集成），排障永远垫底——它是出问题时才翻的，不是学习路径的一环。
 * 难度递进由这个顺序承担，不再需要一条切错位置的 Tab 边界。
 *
 * ## 博客为什么**不在**这份 sidebar 里
 *
 * 曾经把 `/blog/` 也绑到这份 sidebar 上，还在「上下文与记忆」组里插了一条
 * `/blog/jit-context`。那是错的，两个层面都错：
 *
 *   · 产品上——博客是本站接下来要重点投入的一层，把它折进「指南」的一个分组里，
 *     等于宣布它是文档的附属读物。它不是，它是和文档并列的一层，有自己的顶栏入口。
 *   · 机制上——sidebar 绑到 `/blog/` 后，读者在文章间跳转时左栏显示的是**指南目录**，
 *     当前文章却不在其中任何一组里，于是左栏无法回答「我在哪、这里还有什么」。
 *
 * 文档 → 文章的引流改走**页面正文的「相关」段**（如 `use/context.md` 末尾指向 JIT 那篇）。
 * 正文链接会带一句「为什么值得读」，比 sidebar 里一个光秃秃的标题更能让人点进去；
 * 而且跨层跳转时 sidebar 整体换掉是符合预期的，不会出现「左栏和当前页对不上」。
 *
 * ## collapsed 的取值不是随手写的
 *
 * 前 4 组加「成本与用量」那个单页条目保持常展开（`collapsed: false`）：这是绝大多数人
 * 真正会读的部分，折起来就等于把它藏了。后 3 组（扩展 / 集成 / 排障）`collapsed: true`，
 * 把默认可见的条目压到 10 条上下——**扫得完**才叫目录，扫不完就只是一堵墙。
 *
 * ⚠ 折叠不会挡住深链：VitePress 的 `useSidebarControl` 里
 * `(isActiveLink || hasActiveLink) && (collapsed = false)`（实测 1.6.4），
 * 命中当前页的组会自动展开。所以搜索或外部链接直接跳进 `/extend/mcp`，
 * 左栏是展开状态，读者不会「进来看不到自己在哪」。
 */
const GUIDE_SIDEBAR = [
  {
    text: "日常操作",
    collapsed: false,
    items: [
      { text: "交互模式与键位", link: "/use/interactive" },
      { text: "会话管理", link: "/use/sessions" },
    ],
  },
  {
    text: "权限与安全",
    collapsed: false,
    items: [
      { text: "权限与人工确认", link: "/use/permissions" },
      { text: "Worktree 隔离", link: "/use/worktree" },
    ],
  },
  {
    /**
     * 上下文与记忆放在一组：两者是同一件事的两面——
     * 「这一轮模型看得到什么」。压缩管临时的，CLAUDE.md 管长期的。
     */
    text: "上下文与记忆",
    collapsed: false,
    items: [
      { text: "上下文与压缩", link: "/use/context" },
      { text: "记忆与 CLAUDE.md", link: "/use/memory" },
    ],
  },
  {
    text: "任务编排",
    collapsed: false,
    items: [
      { text: "Plan Mode 与 Todo", link: "/use/plan-mode" },
      { text: "子代理", link: "/extend/subagents" },
      { text: "Dynamic Workflows", link: "/extend/workflows" },
    ],
  },
  {
    /**
     * 只有一页，所以刻意**不包一层组**——写成 `{ text, items: [同名的一条] }`
     * 会在左栏渲染出「成本与用量 › 成本与用量」这种同名嵌套，是纯视觉噪音。
     * 顶级条目带 link 会渲染成可点的分区标题，视觉重量与其它组标题一致。
     */
    text: "成本与用量",
    link: "/use/cost",
  },
  {
    /**
     * 「扩展能力」组内顺序 = 上手成本从低到高，与 `/extend/` 总览页那张选择表同序。
     * 总览页固定排第一条：它是这一组的路由器，读者该先看表再挑一个。
     */
    text: "扩展能力",
    collapsed: true,
    items: [
      { text: "扩展方式总览", link: "/extend/" },
      { text: "Skill", link: "/extend/skills" },
      { text: "Hook 指南", link: "/extend/hooks" },
      { text: "MCP", link: "/extend/mcp" },
      { text: "插件与 Bridge", link: "/extend/plugins" },
    ],
  },
  {
    /**
     * 「开发环境集成」= 让 sid-code 接上你已有的工具链（编辑器 / 语言服务 / CI）。
     * 与「扩展能力」的区别：扩展是教它新本事，集成是把它接到现有环境里。
     */
    text: "开发环境集成",
    collapsed: true,
    items: [
      { text: "IDE 集成", link: "/extend/ide" },
      { text: "代码智能（LSP）", link: "/extend/lsp" },
      { text: "无头模式与脚本化", link: "/extend/headless" },
    ],
  },
  {
    text: "出问题时",
    collapsed: true,
    items: [
      { text: "排障", link: "/use/troubleshooting" },
      { text: "术语表", link: "/ref/glossary" },
    ],
  },
];

/**
 * 「博客」这一层的侧边栏，绑给 `/blog/`。
 *
 * ## 为什么博客有自己独立的一份，而不是复用 GUIDE_SIDEBAR
 *
 * 博客是本站接下来重点投入的一层，需要**独立的顶栏入口 + 独立的左栏目录**。
 * 复用指南目录会让读者在文章页看到一份「当前页不在其中任何一组」的目录——
 * 左栏本该回答「我在哪、这一层还有什么」，对不上就等于没有左栏。
 *
 * ## 「全部文章」为什么是独立的顶级条目
 *
 * 读者从首页或顶栏点进某篇文章后，必须有一条明确的路回到列表去挑下一篇——
 * 浏览器后退键不算：搜索或外链直达时后退会离站。
 *
 * 它刻意**不包进下面那个组**：包进去会渲染成「博客 › 全部文章」，而「博客」正是
 * 当前 Tab 名，等于用一层同名嵌套换来零信息（`成本与用量` 那条同理，见 GUIDE_SIDEBAR）。
 * 顶级条目带 link 会渲染成可点的分区标题，视觉重量与组标题一致。
 *
 * ## 清单不手写
 *
 * `blogPosts` 扫 `website/blog/*.md` 得到（`blog-meta.ts`，与列表页 `BlogIndex.vue`
 * 同源），所以新增一篇文章只需要新增 md 文件，sidebar 与列表页自动同步、顺序一致。
 * 手写清单必然漂移成「站内有页面但左栏点不到」。
 *
 * 组名用「最新文章」而不是「文章」：`loadBlogPosts` 返回的就是**日期倒序**，
 * 组名把这个顺序说出来，读者才知道第一条是最新的而不是随机排的。
 */
const BLOG_SIDEBAR = [
  { text: "全部文章", link: "/blog/" },
  /**
   * 按系列分组。
   *
   * ## 为什么按系列而不是一律「最新文章」倒序
   *
   * 系列是有**阅读顺序**的（前置知识在前），而"最新在前"正好把顺序倒过来：
   * 读者从左栏自上而下点，读到的是先结论后前提。所以系列组内按日期**升序**排。
   *
   * ## 为什么只在系列数 ≥2 时才分组
   *
   * 只有一个系列时，分组等于在「博客」和文章之间插一层同名嵌套，零信息
   * （与「全部文章」为什么不包进组是同一条理由）。此时退化成单组「最新文章」倒序，
   * 与改造前的行为一致。判据是**系列数**而不是文章数：三篇文章分属三个系列时，
   * 分组仍然有意义。
   *
   * ## 未归入任何系列的文章
   *
   * 单独归到末尾的「其他」组，而不是静默从左栏消失——那会变成
   * 「站内有页面但左栏点不到」，正是本文件反复要防的那种静默缺陷。
   */
  ...(() => {
    const grouped = SERIES.map((s) => ({
      text: s.name,
      collapsed: false,
      items: blogPosts
        .filter((p) => p.series === s.name)
        // 系列内按阅读顺序（日期升序）；blogPosts 本身是倒序，这里要反过来
        .sort((a, b) => a.date.localeCompare(b.date))
        .map((p) => ({ text: p.title, link: p.url })),
    })).filter((g) => g.items.length > 0);

    const orphans = blogPosts.filter((p) => !p.series);

    // 系列不足 2 个时不分组，退化成单组倒序（理由见上）
    if (grouped.length < 2) {
      return [
        {
          text: "最新文章",
          collapsed: false,
          items: blogPosts.map((p) => ({ text: p.title, link: p.url })),
        },
      ];
    }

    return orphans.length
      ? [
          ...grouped,
          {
            text: "其他",
            collapsed: false,
            items: orphans.map((p) => ({ text: p.title, link: p.url })),
          },
        ]
      : grouped;
  })(),
];

/**
 * sid-code 官网与官方文档站配置。
 *
 * 关键决策（详见 docs/reference/官网与文档站设计方案.md §4.4）：
 * - base '/'          根路径部署，IP → 域名切换时无需改动，全站内链不用重算
 * - cleanUrls true    URL 无 .html，nginx 侧配 `try_files $uri $uri.html`
 * - ignoreDeadLinks   保持默认 false，把死链检测当门禁（构建即失败），不另造断链检查
 * - sitemap           2026-08-06 域名到位后启用，hostname 走 site.ts 同一个闸门
 *                     （未配域名则整个 sitemap 字段不出现，而不是生成一份带 IP 的错的）
 */
export default defineConfig({
  // sitemap 与 feed 共用 site.ts 的闸门：域名是唯一事实源，两个产物不会各写一份而漂移
  ...(canUseAbsoluteUrls() ? { sitemap: { hostname: `${siteHostname()}/` } } : {}),
  lang: "zh-CN",
  title: "sid-code",
  description: "跑在终端的 coding agent —— 多 provider 可插拔、功能自主、数据自主",

  base: "/",
  cleanUrls: true,
  lastUpdated: true,
  // 死链在构建期即失败（默认值，显式写出以防被误改）
  ignoreDeadLinks: false,

  head: [
    ["link", { rel: "icon", href: "/favicon.svg", type: "image/svg+xml" }],
    ["meta", { name: "color-scheme", content: "light dark" }],
    /**
     * feed 自动发现（阅读器/浏览器扩展靠这条找到订阅地址）。
     *
     * 与 feed 文件本身同一个闸门：没配域名时 feed 不生成，这条也不能出现
     * ——留着它等于告诉阅读器"这里有 feed"，然后给一个 404，
     * 那比没有 feed 更糟（用户会以为是自己的阅读器坏了）。
     */
    ...(canUseAbsoluteUrls()
      ? [
          [
            "link",
            {
              rel: "alternate",
              type: "application/atom+xml",
              title: SITE_TITLE,
              href: FEED_PATH,
            },
          ] as [string, Record<string, string>],
        ]
      : []),
  ],

  themeConfig: {
    logo: "/favicon.svg",
    outline: { level: [2, 3], label: "本页内容" },

    /**
     * ── 顶层导航：5 个入口 + 更新日志 ──
     *
     * ## 为什么从 7 个平铺 Tab 收到现在这套
     *
     * 旧结构是「入门 / 使用 / 进阶定制 / 参考 / 企业与团队 / 文章 / 更新日志」，
     * 7 个 Tab 看似都在 ≤9 的预算内，真正的问题不是**个数**而是它们**不在同一根轴上**：
     *
     *   · 入门 / 使用 / 进阶定制  → 按「读者熟练度」分（时间线轴）
     *   · 参考                    → 按「内容体裁」分（查 vs 学）
     *   · 企业与团队              → 按「读者角色」分（个人 vs 管理者）
     *   · 文章 / 更新日志         → 又是按体裁分
     *
     * 三根轴混在一层，就没有任何一个问题能被顶栏回答，读者只能逐个点开试
     * ——「一开始根本找不到相关内容在哪里」的直接成因。
     *
     * 现在顶栏的主干（前 4 个）只回答一个问题：**你现在处于哪个阶段**，
     * 左到右就是真实时间线：
     *
     *   开始 → 指南 → 参考 → 团队部署
     *   评估安装  日常用与定制  查确切写法  推广给团队
     *
     * ## 「使用」与「进阶定制」为什么必须合并
     *
     * 那条线是假的：`use/memory`（CLAUDE.md）和 `extend/skills` 都在回答「怎么把我的
     * 规矩教给它」，却被分在两个 Tab；而 `extend/` 总览页自己那张选择表里，CLAUDE.md
     * 和 Skill/Hook/MCP 就是并列的候选项——**总览页跨过了它所在 Tab 的边界**，这本身
     * 就是分界线画错的证据。合并后按「主题」分组（见上方 GUIDE_SIDEBAR），
     * 难度递进改由**组的排列顺序**承担，而不是靠一条切错位置的 Tab 边界。
     *
     * ## 「博客」为什么是独立 Tab，而不是「指南」下拉里的一条
     *
     * 中途曾把它折进「指南」下拉（并把 JIT 那篇塞进「上下文与记忆」组），已推翻。
     * 博客与文档是**两类不同的内容**，不是难度上的递进关系：
     *
     *   文档回答「怎么做」——任务导向，读者带着具体目的来，读完就走；
     *   博客回答「为什么这么设计、实测数据长什么样」——它是唯一能体现
     *   「这东西真在跑、真被度量过」的一层，也是本站接下来重点投入的方向。
     *
     * 折进下拉有两个直接代价：① 少一层曝光（要先点开「指南」才看得见），
     * ② 顶栏高亮归到「指南」，读者在文章页会以为自己还在文档里。
     * 一个要重点做的内容层，必须有自己的顶栏位置和自己的高亮。
     *
     * 排序刻意放在「参考」之后、「团队部署」之前：它不属于那条上手时间线，
     * 但比团队部署更贴近个人读者，不该沉到最右。
     *
     * ## 「指南」为什么做成下拉而不是直接跳页
     *
     * 旧的「使用」Tab 直接跳 `/use/interactive`，等于把读者空投到一个具体页面，
     * 看不到这一层还有什么。下拉把 7 个主题摊在顶栏上——**点开之前**就知道
     * 权限、成本、上下文各自在哪，导航本身成了目录。
     */
    nav: [
      { text: "开始", link: "/start/", activeMatch: "^/start/" },
      {
        text: "指南",
        // /use/ 与 /extend/ 两个目录共用同一份 sidebar，高亮也必须一起算
        activeMatch: "^/(use|extend)/",
        items: [
          { text: "日常操作", link: "/use/interactive" },
          { text: "权限与安全", link: "/use/permissions" },
          { text: "上下文与记忆", link: "/use/context" },
          { text: "任务编排", link: "/use/plan-mode" },
          { text: "成本与用量", link: "/use/cost" },
          { text: "扩展能力", link: "/extend/" },
          { text: "开发环境集成", link: "/extend/ide" },
          // ⚠ 这 8 条必须与 GUIDE_SIDEBAR 的 8 个分组一一对应、同序。
          // 少一条（曾漏掉「出问题时」）就意味着顶栏声称的目录比实际内容少一块，
          // 而排障恰好是最需要被一眼看见的一块——用户翻它的时候正卡着。
          { text: "出问题时", link: "/use/troubleshooting" },
        ],
      },
      { text: "参考", link: "/ref/cli", activeMatch: "^/ref/" },
      { text: "博客", link: "/blog/", activeMatch: "^/blog/" },
      { text: "团队部署", link: "/team/defaults", activeMatch: "^/team/" },
      { text: "更新日志", link: "/changelog" },
    ],

    /**
     * ── 按路径分组的多 sidebar：进哪个 Tab 只看到该 Tab 的页面 ──
     *
     * ⚠ 两处 `GUIDE_SIDEBAR`（`/use/` `/extend/`）刻意共用同一个数组引用，
     * 别拆成两份各自维护的副本。VitePress 按 key 的**路径深度倒序**取第一个前缀命中项
     * （`support/sidebar.js` 的 `getSidebar`，实测 1.6.4），所以同一份数组绑到两个前缀上，
     * 读者在这两个目录间跳转时左栏**结构完全不动、位置不丢**——这正是「合并成一个指南 Tab」
     * 在视觉上成立的实现基础。拆成副本就会漂移成两套不一样的目录。
     *
     * `/blog/` 用自己的 `BLOG_SIDEBAR`（理由见其定义处）：博客是独立的一层，
     * 不是指南的一个分组，左栏也该是它自己的文章目录。
     */
    sidebar: {
      /**
       * 「开始」是全站唯一**有序**的一层：五篇按先后读完就能跑通，不是任你挑的清单。
       * 所以刻意不分组、不折叠——线性列表本身就在表达「照这个顺序走」。
       * 末篇 `next` 是这一层到「指南」的交接口。
       */
      "/start/": [
        {
          text: "开始",
          items: [
            { text: "sid-code 是什么", link: "/start/" },
            { text: "安装", link: "/start/install" },
            { text: "配置 LLM Provider", link: "/start/configure" },
            { text: "跑通第一个任务", link: "/start/first-task" },
            { text: "接下来读什么", link: "/start/next" },
          ],
        },
      ],
      // 两个前缀共用同一份 GUIDE_SIDEBAR（同一个数组引用，别拆副本，理由见其定义处）
      "/use/": GUIDE_SIDEBAR,
      "/extend/": GUIDE_SIDEBAR,
      // 博客是独立一层，用自己的目录（别改回 GUIDE_SIDEBAR，理由见 BLOG_SIDEBAR 定义处）
      "/blog/": BLOG_SIDEBAR,
      /**
       * 「参考」按**你手里拿的是什么**分两组，而不是平铺 7 条：
       * 上组是你在终端里敲的（命令行 / 会话里），下组是你在文件里写的（配置 / hook）。
       * 读者来这一层时心里已经有目标，两组把候选面从 7 条砍到 3~4 条。
       * 术语表在「指南 › 出问题时」也挂了一份——它既是查询项也是排障入口，两处都该有。
       */
      "/ref/": [
        {
          text: "你敲的命令",
          collapsed: false,
          items: [
            { text: "CLI 参数与子命令", link: "/ref/cli" },
            { text: "斜杠命令", link: "/ref/slash-commands" },
            { text: "内置工具", link: "/ref/tools" },
          ],
        },
        {
          text: "你写的配置",
          collapsed: false,
          items: [
            { text: "settings.json 字段", link: "/ref/settings" },
            { text: "环境变量", link: "/ref/env" },
            { text: "Hook 事件", link: "/ref/hooks" },
          ],
        },
        {
          text: "术语表",
          collapsed: false,
          items: [{ text: "术语表", link: "/ref/glossary" }],
        },
      ],
      /**
       * 「团队部署」按推广的真实时序排：先让人装上（迁移 / 分发），
       * 再管住（配额 / policy），最后看效果（可观测 / 定时）。
       * `migrate` 从末位提到首位：团队里已有 cc 用户时，它是第一道门槛而不是补充读物。
       */
      "/team/": [
        {
          text: "落地到团队",
          collapsed: false,
          items: [
            { text: "从 Claude Code 迁移", link: "/team/migrate" },
            { text: "团队默认配置分发", link: "/team/defaults" },
          ],
        },
        {
          text: "管住成本与边界",
          collapsed: false,
          items: [
            { text: "配额与成本控制", link: "/team/quota" },
            { text: "企业 policy 与安全边界", link: "/team/policy" },
          ],
        },
        {
          text: "看清实际用得怎么样",
          collapsed: false,
          items: [
            { text: "轨迹采集与可观测", link: "/team/observability" },
            { text: "定时与无人值守", link: "/team/scheduled" },
          ],
        },
      ],
      /**
       * ── /changelog：全站唯一一条**时间线**左栏 ──
       *
       * ⚠ key 刻意**不带尾斜杠**。`getSidebar` 判的是
       * `path.startsWith(ensureStartingSlash(dir))`，而这一页的 relativePath 是
       * `changelog.md`（它是单页，不是目录）。写成 `"/changelog/"` 永远匹配不上，
       * 症状是「配了 sidebar 但左栏还是不出现」——和改造前一模一样，且不报错。
       *
       * 少了这条 key 会发生什么，是这次改造的起因：VitePress 找不到前缀命中项就
       * 返回 `[]`，`hasSidebar` 为 false，于是 /changelog 成了全站唯一没有左栏、
       * 且内容宽度与所有其它页都不同的一页（实测构建产物里它只有 `has-aside`，
       * 别的文档页有 `has-sidebar`）。
       *
       * 内容为什么是版本时间线而不是主题目录、按月分组与 collapsed 的取值依据，
       * 全部写在 `changelog-meta.ts` 顶部——那里是这份数据的产地，不在这里重复。
       */
      "/changelog": CHANGELOG_SIDEBAR,
    },

    /* ── 本地搜索：构建期建 minisearch 索引，浏览器内检索，不依赖外部服务 ── */
    search: {
      provider: "local",
      options: {
        /**
         * ⚠ 硬性约束（§3.4）：tokenize 必须在 options 与 searchOptions
         * 两处都传。minisearch 的索引期分词与查询期分词是两个独立参数，
         * 只传 options → 索引用 bigram、查询用默认分词 → 全站搜不到，
         * 且不报任何错（静默失效）。删任一处前先读 tokenize.ts 顶部说明。
         */
        /**
         * 把 frontmatter 标了 `search: false` 的页面从**全站**索引里摘出去。
         *
         * 目前唯一使用者是 /changelog：它由 theme/Changelog.vue 从构建期 JSON 渲染，
         * 自带一个只搜版本变更的独立搜索框。若让几百条 commit 描述进全站索引，
         * 「搜 hook」「搜权限」这类正常查询会被一片版本噪音冲掉——两个搜索的
         * 目标读者不同，索引必须分开。
         *
         * ⚠ 用同步 `md.render`，不要照抄上游 main 分支文档里的 `md.renderAsync` ——
         * 那是更新版才有的 API，在当前锁定的 vitepress 1.6.4 上是 undefined，
         * 构建期直接报 `md.renderAsync is not a function`（实测踩到）。
         * 升级 vitepress 时可一并复核这里。
         *
         * ⚠ 顺序不能调：必须**先 render 再判断**。`env.frontmatter` 是 md.render
         * 在渲染过程中回填到 env 上的，渲染前读恒为 undefined —— 把早退提到前面
         * 看似省一次渲染，实际是静默失效（实测索引里照旧留下 4 条 /changelog 标题条目）。
         */
        _render(src, env, md) {
          const html = md.render(src, env);
          if ((env as any)?.frontmatter?.search === false) return "";
          return html;
        },
        miniSearch: {
          options: {
            tokenize: tokenizeCJK,
          },
          searchOptions: {
            tokenize: tokenizeCJK,
            /**
             * ⚠ combineWith 必须是 AND —— minisearch 默认 OR。
             *
             * bigram 分词会把「区块链」切成 区/块/链/区块/块链。默认 OR 语义下
             * 只要任一 token 命中就返回整页：单字「子」能被「钩子」「子代理」命中，
             * 于是站内根本不存在的词也能搜出一堆结果（实测浏览器里
             * 「区块链」32 条、「量子计算」20 条，全是噪音）。
             * 中文 bigram 检索必须 AND：要求全部 token 都出现，才是"这页真讲这个词"。
             */
            combineWith: "AND",
            /**
             * fuzzy / prefix 对 CJK 关闭（保持默认 false）。
             * 单字 token 上做模糊或前缀匹配会再次把召回放大成噪音，
             * 而中文查询本身不存在英文那种拼写错误与词形变化。
             */
            boost: { title: 4, text: 2, titles: 1 },
          },
        },
        translations: {
          button: { buttonText: "搜索文档", buttonAriaLabel: "搜索文档" },
          modal: {
            displayDetails: "显示详情",
            resetButtonTitle: "清除条件",
            backButtonTitle: "关闭",
            noResultsText: "没有找到结果",
            footer: {
              selectText: "选择",
              navigateText: "切换",
              closeText: "关闭",
            },
          },
        },
      },
    },

    notFound: {
      code: "404",
      title: "页面不存在",
      quote:
        // ⚠ 别在这句里写死 Tab 名（曾写「从入门页开始找」，Tab 改名后这句就在指路到
        // 一个站上不存在的地方）。改用顶栏搜索框——它不随导航结构变化而失效。
        "这个地址没有对应的页面。可能是链接过期，或者路径拼错了——用顶栏的搜索框找通常最快。",
      linkLabel: "回到首页",
      linkText: "回到首页",
    },

    docFooter: { prev: "上一页", next: "下一页" },
    lastUpdatedText: "最后更新",
    returnToTopLabel: "回到顶部",
    sidebarMenuLabel: "菜单",
    darkModeSwitchLabel: "主题",
    lightModeSwitchTitle: "切换到浅色模式",
    darkModeSwitchTitle: "切换到深色模式",
    externalLinkIcon: true,

    footer: {
      // llms.txt 由 scripts/docs-gen-reference.ts 生成（T-3.3b），供 agent 抓全站索引。
      // sid-code 本身就是 agent，自家 agent 能读懂自家文档是个闭环。
      message:
        '本站由 <a href="https://vitepress.dev/">VitePress</a> 构建。参考类页面由脚本从源码生成。' +
        '给大模型看的全站索引：<a href="/llms.txt">llms.txt</a>',
      copyright: "sid-code · 跑在终端的 coding agent",
    },
  },

  /**
   * T-3.11「复制整页」按钮的数据供给：把每页的**原始 markdown** 塞进 pageData，
   * 供主题层的按钮直接读。
   *
   * 为什么走 transformPageData 而不是前端 fetch 源文件：
   *   · fetch 需要把 .md 一并发布到站点目录（多一份产物 + 要改 nginx 才不当下载处理）；
   *   · 且 dev 与 build 两套路径不一致，容易只在一边能用。
   * transformPageData 在两种模式下都跑，数据随页面一起序列化，前端零请求。
   *
   * 刻意复制 markdown 源文而非渲染后的 HTML/innerText：用户复制整页的真实目的
   * 是**贴给 agent**，markdown 才是 agent 友好的形态（表格结构完整、无样式噪音）。
   *
   * 顺带承担第二件事：关掉 /blog/ 文章页默认主题的「最后更新」与「上一页/下一页」，
   * 详见下方注释。两件事都要按页改 pageData，合在一个钩子里比拆两处更省。
   */
  transformPageData(pageData, ctx) {
    // 虚拟页（404 等）的 filePath 是空串，跳过
    if (!pageData.filePath) return;
    try {
      const abs = resolve(ctx.siteConfig.srcDir, pageData.filePath);
      pageData.frontmatter.rawMarkdown = stripFrontmatter(readFileSync(abs, "utf-8"));
    } catch {
      // 读不到就不给按钮数据（按钮自身会隐藏），不因此让整站构建失败
    }

    /**
     * ── /blog/ 文章页：关掉默认主题的「最后更新」与「上一页/下一页」──
     *
     * 文章底部由 theme/BlogPostFooter.vue 统一负责（一行元信息 + 最多两条继续读）。
     * 默认主题这两块与它重复甚至矛盾：
     *
     *   · 「最后更新」取 git 提交时间，和文章的**发布日期**是同一件事的两种口径。
     *     并列显示只会让读者疑惑"哪个才算这篇文章的时间"，而改一个错别字就会让
     *     "最后更新"跳到今天，对读者没有信息量。
     *   · 「上一页/下一页」走 sidebar 顺序，而 blog 的 sidebar 是**日期倒序**
     *     （见上面的 BLOG_SIDEBAR）。也就是说它的"下一页"其实是**更旧的一篇**，
     *     与 BlogPostFooter 里按阅读顺序算的"系列下一篇"方向相反——
     *     两者并存必然有一个在骗人。
     *
     * 只对文章页生效：列表页 /blog/ 自身与文档页照旧（文档页的 pager 是按阅读
     * 顺序排的 sidebar，那里它是对的）。
     *
     * 实现细节：`lastUpdated = undefined` 而不是 `false`——VPDocFooter 判的是
     * `page.lastUpdated` 的真值，而 pageData.lastUpdated 的类型是 `number | undefined`。
     * pager 则走 frontmatter 的 prev/next === false，这是默认主题 prev-next.js
     * 支持的官方开关（见 hidePrev / hideNext）。
     */
    const rel = pageData.relativePath;
    if (rel.startsWith("blog/") && rel.endsWith(".md") && rel !== "blog/index.md") {
      pageData.lastUpdated = undefined;
      pageData.frontmatter.prev = false;
      pageData.frontmatter.next = false;
    }
  },

  /**
   * 构建收尾：生成博客的 Atom feed。
   *
   * 未配置站点域名时**跳过并打印原因**（不是生成一份带 IP 的错 feed）——
   * feed 的 `<id>` 是订阅端去重主键，用 IP 发布过再换域名会让所有历史文章
   * 重新推送一遍。完整论证与启用方式写在 .vitepress/site.ts 里。
   *
   * 数据源仍是 blog-meta.ts 那一份（与 sidebar / 列表页同源），不另解析一遍 md。
   */
  buildEnd(siteConfig) {
    writeFeed(loadBlogPosts(), siteConfig.outDir);
  },
});
