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
import "./brand.css";

export default {
  extends: DefaultTheme,
  Layout() {
    return h(DefaultTheme.Layout, null, {
      "doc-before": () => h(CopyPage),
    });
  },
} satisfies Theme;
