/**
 * bun `with { type: "file" }` 嵌入 import 的类型声明。
 *
 * bun 编译时把文件内容嵌入产物，import 默认导出一个运行时虚拟路径字符串
 * （`/$bunfs/...`）。TS 不认识 vendor 下的无扩展名二进制占位文件，这里给它
 * 补一个字符串默认导出的模块声明。见 packages/core/src/tool/rg-embedded.ts。
 *
 * 下面的模块名用前缀通配符（星号 + /vendor/rg-embed）而不写死路径：P2-3 把 vendor/
 * 从仓库根挪到 packages/core/ 时，正是这个通配符让本声明**不需要**跟着改。
 *
 * ⚠️ 注意别把那个通配符原样写进块注释里 —— 星号紧跟斜杠会提前闭合注释，
 *    实测会让本文件从第 17 行起整段解析错乱（TS1005 / TS1160），
 *    而这类报错的位置离真正的错因很远，排查很费时间。
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
