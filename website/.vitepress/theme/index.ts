/**
 * 站点主题入口 —— 继承 VitePress 默认主题，只叠加品牌样式。
 *
 * 刻意不 fork 默认主题：默认主题已提供 Tab 分层导航、按路径分组 sidebar、
 * 本地搜索、移动端适配、outline，这些都是本方案要的。改动越少，
 * 升级 vitepress 时的回归面越小。
 */
import DefaultTheme from "vitepress/theme";
import type { Theme } from "vitepress";
import "./brand.css";

export default {
  extends: DefaultTheme,
} satisfies Theme;
