/**
 * 嵌入 ripgrep 二进制的隔离层
 *
 * 用 bun 原生 `with { type: "file" }` 把预编译 rg 二进制嵌入 `bun --compile` 产物。
 * 编译时 bun 读取 `vendor/rg-embed` 的内容嵌进二进制，import 返回一个
 * `/$bunfs/` 开头的虚拟路径字符串（运行时可用 `Bun.file()` 读取字节）。
 *
 * 关键约束：
 * - 本模块**只能被 `await import()` 动态加载**，且调用方须先用
 *   IS_DEV_MODE 守卫（见 ensure-ripgrep.ts）。原因见下。
 * - `vendor/rg-embed` 是构建脚本在编译前填入「对应平台 rg 二进制」的固定占位文件
 *   （见 scripts/fetch-ripgrep.ts / release.sh）。仓库里保留一个 0 字节占位，
 *   保证即使没跑 fetch，`bun build` 也不因缺文件报错——此时嵌入的是空文件，
 *   运行时 `bytes.byteLength === 0` 会触发降级到系统 rg。
 * - dev 模式（bun run src）下 IS_DEV_MODE 为 true，
 *   ensure-ripgrep.ts 的守卫直接 return，根本不会 import 本模块，
 *   因此 dev 运行不依赖 vendor/rg-embed 的实际内容。
 */

import rgEmbeddedPath from "../../vendor/rg-embed" with { type: "file" };

/** 嵌入 rg 二进制的运行时虚拟路径（`/$bunfs/...`），用 Bun.file() 读取 */
export { rgEmbeddedPath };
