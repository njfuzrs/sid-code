/**
 * `.vue` 单文件组件的类型声明。
 *
 * 没有这份 shim，`import CopyPage from "./CopyPage.vue"` 会报
 * TS2307「Cannot find module」——Vue 项目通常由 vue-tsc 提供该声明，
 * 但本站没装 vue-tsc（不需要，构建走 vitepress），故手写一份最小声明。
 */
declare module "*.vue" {
  import type { DefineComponent } from "vue";
  const component: DefineComponent<{}, {}, any>;
  export default component;
}
