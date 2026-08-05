---
title: 博客
description: sid-code 的机制解析与工程实测：一个机制为什么这么设计、实现里踩了哪些坑、实测数据是多少、当前边界在哪。带 file 级证据，不写"据说"。
# 列表页本身不进全站索引：它的内容就是各文章的标题与摘要，索引它等于每篇文章
# 在搜索结果里出现两次（一次列表页、一次文章页），点列表页那条还得再点一次才到正文。
# 文章正文页照常进索引。执行方在 .vitepress/config.ts 的 search.options._render。
search: false
# 页面主体是组件渲染的卡片列表，没有 h2/h3 章节，大纲栏会是空的
outline: false
# 给 .Layout 挂一个类名，让 brand.css 能只给这一页加渐变背板（卡片要有色差才像卡片）。
# 默认主题在 Layout.vue 里读 frontmatter.pageClass，且是 SSR 渲染，首屏即有底色。
pageClass: blog-index
---

# 博客

文档告诉你**怎么做**，这里讲**为什么这么做、以及它实际做到了什么程度**。

每篇都是把一个机制拆开讲透：它解决什么问题、在 sid-code 里怎么实现的、
实测数据是多少、踩过哪些坑、当前边界在哪。

<div class="bi-creed">
  <div class="bi-creed-item">
    <b>带 file:line 级证据</b>
    <span>讲一个机制就指到源码位置，不写"据说""大概"。上方「处源码引证」那个数字是构建期数出来的，只算真实存在于仓库里的路径。</span>
  </div>
  <div class="bi-creed-item">
    <b>数据是自己跑出来的</b>
    <span>缓存命中率、注入覆盖率这类数字来自真实会话轨迹，附采集口径。</span>
  </div>
  <div class="bi-creed-item">
    <b>能力边界照实写</b>
    <span>没做完的、已知有问题的直接写出来。不写出来，用户只会遇到「有时候生效有时候不生效」这种最难排查的现象。</span>
  </div>
</div>

<BlogIndex />

## 相关

- [更新日志](/changelog) —— 每个版本具体改了什么（这里是机制解析，那里是版本资讯）
- [扩展方式总览](/extend/) —— 读完想动手时，从这张选择表开始
- [术语表](/ref/glossary) —— 文章里出现的术语的准确定义

<style scoped>
/*
 * 三条自我约束：从三个 bullet 改成并排卡片带。
 *
 * 原来是三行 markdown 列表——读者每次进列表页都要先读一段散文才看到文章。
 * 做成卡片后它既是视觉锚点（填住标题与文章列表之间那片空白），
 * 也把这个博客与一般技术博客的区别摆在了首屏。文字一个字没改。
 *
 * 写在这一页的 <style scoped> 里而不是 brand.css：它只服务这一页的这一块内容，
 * 放全局样式表会让人以为是可复用组件。颜色仍然只用 --vp-* 变量。
 */
.bi-creed {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 10px;
  margin: 22px 0 26px;
}
.bi-creed-item {
  display: flex;
  flex-direction: column;
  gap: 5px;
  padding: 14px 16px;
  border: 1px solid var(--vp-c-divider);
  border-radius: 10px;
  background: var(--vp-c-bg-soft);
}
.bi-creed-item b {
  font-size: 13.5px;
  font-weight: 600;
  color: var(--vp-c-brand-1);
}
.bi-creed-item span {
  font-size: 12.5px;
  line-height: 1.65;
  color: var(--vp-c-text-2);
}

/* 窄屏改单列：三列挤在手机上每列只剩几个字宽，比纵向排列更难读 */
@media (max-width: 720px) {
  .bi-creed {
    grid-template-columns: 1fr;
  }
}
</style>
