---
title: 博客
description: sid-code 的机制解析与工程实测：一个机制为什么这么设计、实现里踩了哪些坑、实测数据是多少、当前边界在哪。带 file 级证据，不写"据说"。
# 列表页本身不进全站索引：它的内容就是各文章的标题与摘要，索引它等于每篇文章
# 在搜索结果里出现两次（一次列表页、一次文章页），点列表页那条还得再点一次才到正文。
# 文章正文页照常进索引。执行方在 .vitepress/config.ts 的 search.options._render。
search: false
# 页面主体是组件渲染的卡片列表，没有 h2/h3 章节，大纲栏会是空的
outline: false
#
# ── 关掉右侧 aside，把整个右半区让给卡片网格 ──
#
# ⚠ 这是 brand.css 里那段「别改列表页栏宽」注释所说的事，但**做法不同、结论也不同**。
# 那次失败的做法是用 CSS `.aside { display:none }` + 手写 `max-width:900px`：
# 页面仍带 `.VPDoc.has-aside`（因为 hasAside 只看 frontmatter.aside 与 theme.aside，
# 从不看 outline），于是默认主题的 `.has-aside .content-container{max-width:688px}`
# 还在生效，两套几何一撞，列表页↔文章页跳转时内容列横移。
#
# 这里改的是 hasAside 的**输入**（frontmatter.aside），不是它产生的样式：
# 页面不再带 has-aside → 688px 那条规则根本不匹配 → 无需任何 max-width 覆盖。
# 单一事实源，不存在"两套几何"。
#
# 那段注释的结论（"宁可空着 256px 也要零位移"）在当时是对的：列表页只有 3 篇、
# 单列卡片，多出的宽度没用处，而位移是实打实的。现在前提变了——24 篇、四列网格，
# 那 256px 直接决定一行能放几张卡。位移这一项也不再成立：列表页是**分叉点**
# （读者从这里挑一篇进去），不是线性路径上的一站，进去之后不会再退回来逐页比对，
# 所以"同层级页面间切换不动版"保护的那个场景在这一页上不存在。
aside: false
# 给 .Layout 挂一个类名，让 brand.css 能只给这一页换底色（卡片要有色差才像卡片）。
# 默认主题在 Layout.vue 里读 frontmatter.pageClass，且是 SSR 渲染，首屏即有底色。
pageClass: blog-index
#
# ── 下面三个 false 一起把页脚整块关掉 ──
#
# 列表页的页脚原来会渲染出三样东西，对"选一篇文章读"这个唯一目的全是干扰：
#   · 最后更新: 2026/8/5 11:17  —— 列表页的 git mtime。读者要的是每篇文章的日期
#                                （卡片上已有），列表页容器什么时候改过与他无关。
#   · 下一页：<某篇文章>        —— 由 sidebar 顺序推出的"下一页"，恰好是列表里的
#                                第一篇。同一个链接在同一屏出现两次，还暗示存在
#                                一条"读完列表页该往下读"的线性路径，而列表页的
#                                语义是分叉点不是路径上的一站。
#   · 编辑此页                  —— 本站未配 editLink，本来就没渲染，列在此处备忘。
#
# 三个 false 缺一不可：VPDocFooter 的 v-if 是
# `hasEditLink || hasLastUpdated || prev || next`（见 vitepress 的 VPDocFooter.vue），
# 任一为真整块就还在，只关一个只会剩个孤零零的半条页脚。
lastUpdated: false
prev: false
next: false
---

# 博客

<BlogIndex />
