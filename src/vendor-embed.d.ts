/**
 * bun `with { type: "file" }` 嵌入 import 的类型声明。
 *
 * bun 编译时把文件内容嵌入产物，import 默认导出一个运行时虚拟路径字符串
 * （`/$bunfs/...`）。TS 不认识 vendor 下的无扩展名二进制占位文件，这里给它
 * 补一个字符串默认导出的模块声明。见 src/tool/rg-embedded.ts。
 */
declare module "*/vendor/rg-embed" {
  const path: string;
  export default path;
}

/**
 * bun `with { type: "text" }` 文本 import 的类型声明。
 *
 * 编译时把 .md 原文内联进产物，import 默认导出文件文本内容（utf-8 字符串）。
 * 用于把参考文档打进二进制（如 /claude-api 注入 api-reference/*.md），发布版无需运行时文件。
 */
declare module "*.md" {
  const content: string;
  export default content;
}
