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
import "./brand.css";

export default {
  extends: DefaultTheme,
  Layout() {
    return h(DefaultTheme.Layout, null, {
      "doc-before": () => h(CopyPage),
    });
  },
  /**
   * 全局注册 <Changelog />，让 website/changelog.md 能直接挂载它。
   * 只注册这一个组件：它的数据源是构建期 JSON，写成 md 会被全站搜索索引
   * 冲成噪音（详见 Changelog.vue 顶部说明）。
   */
  enhanceApp({ app }) {
    app.component("Changelog", Changelog);
  },
} satisfies Theme;
