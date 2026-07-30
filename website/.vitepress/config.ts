import { defineConfig } from "vitepress";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { tokenizeCJK } from "./tokenize";
import { stripFrontmatter } from "./raw-markdown";
import { loadBlogPosts } from "./blog-meta";

/**
 * /blog/ 的 sidebar 从磁盘扫出来，**不手写清单**。
 * 手写必然漂移：新增一篇要改两处（sidebar + 文章文件），漏一处就是
 * 「站内有页面但 sidebar 点不到」这种静默缺陷。数据源与列表页共用
 * blog-meta.ts，所以两处顺序与标题永远一致。
 */
const blogPosts = loadBlogPosts();

/**
 * sid-code 官网与官方文档站配置。
 *
 * 关键决策（详见 docs/reference/官网与文档站设计方案.md §4.4）：
 * - base '/'          根路径部署，IP → 域名切换时无需改动，全站内链不用重算
 * - cleanUrls true    URL 无 .html，nginx 侧配 `try_files $uri $uri.html`
 * - ignoreDeadLinks   保持默认 false，把死链检测当门禁（构建即失败），不另造断链检查
 * - sitemap           本轮不配，备案通过上域名后再加（IP 阶段填 hostname 会返工）
 */
export default defineConfig({
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
  ],

  themeConfig: {
    logo: "/favicon.svg",
    outline: { level: [2, 3], label: "本页内容" },

    /* ── 5 个顶层 Tab（§4.3.1）：读者一次只面对 ≤9 个选项 ── */
    nav: [
      { text: "入门", link: "/start/", activeMatch: "^/start/" },
      { text: "使用", link: "/use/interactive", activeMatch: "^/use/" },
      { text: "进阶定制", link: "/extend/", activeMatch: "^/extend/" },
      { text: "参考", link: "/ref/cli", activeMatch: "^/ref/" },
      { text: "企业与团队", link: "/team/defaults", activeMatch: "^/team/" },
      { text: "文章", link: "/blog/", activeMatch: "^/blog/" },
      { text: "更新日志", link: "/changelog" },
    ],

    /* ── 按路径分组的多 sidebar：进哪个 Tab 只看到该 Tab 的页面 ── */
    sidebar: {
      "/start/": [
        {
          text: "入门",
          items: [
            { text: "sid-code 是什么", link: "/start/" },
            { text: "安装", link: "/start/install" },
            { text: "配置 LLM Provider", link: "/start/configure" },
            { text: "跑通第一个任务", link: "/start/first-task" },
            { text: "接下来读什么", link: "/start/next" },
          ],
        },
      ],
      "/use/": [
        {
          text: "使用",
          items: [
            { text: "交互模式与键位", link: "/use/interactive" },
            { text: "权限与人工确认", link: "/use/permissions" },
            { text: "会话管理", link: "/use/sessions" },
            { text: "上下文与压缩", link: "/use/context" },
            { text: "Plan Mode 与 Todo", link: "/use/plan-mode" },
            { text: "记忆与 CLAUDE.md", link: "/use/memory" },
            { text: "成本与用量", link: "/use/cost" },
            { text: "Worktree 隔离", link: "/use/worktree" },
            { text: "排障", link: "/use/troubleshooting" },
          ],
        },
      ],
      "/extend/": [
        {
          text: "进阶定制",
          items: [
            { text: "扩展方式总览", link: "/extend/" },
            { text: "Skill", link: "/extend/skills" },
            { text: "Hook 指南", link: "/extend/hooks" },
            { text: "子代理", link: "/extend/subagents" },
            { text: "Dynamic Workflows", link: "/extend/workflows" },
            { text: "MCP", link: "/extend/mcp" },
            { text: "代码智能（LSP）", link: "/extend/lsp" },
            { text: "IDE 集成", link: "/extend/ide" },
            { text: "无头模式与脚本化", link: "/extend/headless" },
            { text: "插件与 Bridge", link: "/extend/plugins" },
          ],
        },
      ],
      "/ref/": [
        {
          text: "参考",
          items: [
            { text: "CLI 参数与子命令", link: "/ref/cli" },
            { text: "斜杠命令", link: "/ref/slash-commands" },
            { text: "内置工具", link: "/ref/tools" },
            { text: "settings.json 字段", link: "/ref/settings" },
            { text: "环境变量", link: "/ref/env" },
            { text: "Hook 事件", link: "/ref/hooks" },
          ],
        },
        {
          text: "术语",
          items: [{ text: "术语表", link: "/ref/glossary" }],
        },
      ],
      /**
       * 文章 sidebar：第一条固定是列表页（读者点进某篇后要能回到列表），
       * 其后是全部文章，顺序与列表页一致（同一份 blogPosts，日期倒序）。
       */
      "/blog/": [
        {
          text: "文章",
          items: [
            { text: "全部文章", link: "/blog/" },
            ...blogPosts.map((p) => ({ text: p.title, link: p.url })),
          ],
        },
      ],
      "/team/": [
        {
          text: "企业与团队",
          items: [
            { text: "团队默认配置分发", link: "/team/defaults" },
            { text: "配额与成本控制", link: "/team/quota" },
            { text: "企业 policy 与安全边界", link: "/team/policy" },
            { text: "轨迹采集与可观测", link: "/team/observability" },
            { text: "定时与无人值守", link: "/team/scheduled" },
            { text: "从 Claude Code 迁移", link: "/team/migrate" },
          ],
        },
      ],
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
        "这个地址没有对应的页面。可能是链接过期，或者路径拼错了——从入门页开始找通常更快。",
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
  },
});
