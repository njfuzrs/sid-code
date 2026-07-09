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
