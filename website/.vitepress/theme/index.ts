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
import BlogMeta from "./BlogMeta.vue";
import "./brand.css";

export default {
  extends: DefaultTheme,
  Layout() {
    /**
     * doc-before 里挂两个组件，顺序即视觉顺序：
     *   BlogMeta（文章元信息行，仅 /blog/ 下的文章页渲染，自带 v-if 判路径）
     *   CopyPage（复制整页按钮，全站）
     * 元信息行在按钮上方——它是文章的一部分（日期/时长/标签），
     * 而按钮是工具栏。工具栏压在署名之上会让文章头部读起来像先看到一个控件。
     */
    return h(DefaultTheme.Layout, null, {
      "doc-before": () => [h(BlogMeta), h(CopyPage)],
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
