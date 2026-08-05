/**
 * 站点主题入口 —— 继承 VitePress 默认主题，只叠加品牌样式与「复制整页」按钮。
 *
 * 刻意不 fork 默认主题：默认主题已提供 Tab 分层导航、按路径分组 sidebar、
 * 本地搜索、移动端适配、outline，这些都是本方案要的。改动越少，
 * 升级 vitepress 时的回归面越小。
 *
 * T-3.11 的按钮通过默认主题的 `doc-before` 插槽注入（不改默认主题布局），
 * 同样是为了把改动面压到最小。
 */
import { h } from "vue";
import DefaultTheme from "vitepress/theme";
import type { Theme } from "vitepress";
import CopyPage from "./CopyPage.vue";
import Changelog from "./Changelog.vue";
import BlogIndex from "./BlogIndex.vue";
import BlogPostFooter from "./BlogPostFooter.vue";
import "./brand.css";

export default {
  extends: DefaultTheme,
  Layout() {
    /**
     * doc-before 只挂 CopyPage（复制整页按钮，全站）。文章标题下方**不放任何元信息**：
     * 日期/阅读时长/引证数/标签在 /blog/ 列表页卡片上已经出现过，读者是看过卡片
     * 才点进来的，再压在正文之前只会分散注意力。
     *
     * doc-after 只挂 BlogPostFooter —— 文章底部**只有这一块**：
     * 一行元信息 + 最多两条「继续读」。它自带 v-if 判路径，非 /blog/ 文章页不渲染。
     * 2026-08-05：原先这里是 BlogSeriesNav + BlogRelated 两个组件、加上默认主题的
     * 「最后更新」和「上一页/下一页」共五块，且三条链接指向同一篇文章。
     * 合并与去重的完整理由写在 BlogPostFooter.vue 顶部，默认主题那两块在
     * config.ts 的 transformPageData 里按路径关掉。
     *
     * ⚠️ 必须是 doc-after，不能是 doc-footer-before：后者在 VPDocFooter **内部**，
     * 而 VPDocFooter 整个挂在 `v-if="showFooter"` 上
     * （= editLink || lastUpdated || prev || next，见其源码）。
     * transformPageData 关掉「最后更新」与 pager 之后这四项在文章页全为假，
     * footer 连带插槽一起不渲染——实测挂 doc-footer-before 时文章底部整块消失。
     * doc-after 在 VPDocFooter 之外、无条件渲染；文章页既然已经没有 pager，
     * "doc-after 会掉到页脚导航下面"这个顾虑也就不存在了。
     */
    return h(DefaultTheme.Layout, null, {
      "doc-before": () => h(CopyPage),
      "doc-after": () => h(BlogPostFooter),
    });
  },
  /**
   * 全局注册在 markdown 里直接用的组件。
   * 只注册这几个：它们的数据源都是构建期 JSON/扫目录结果，写成 md 会被全站搜索索引
   * 冲成噪音（详见 Changelog.vue / BlogIndex.vue 顶部说明）。
   */
  enhanceApp({ app }) {
    app.component("Changelog", Changelog);
    app.component("BlogIndex", BlogIndex);
  },
} satisfies Theme;
