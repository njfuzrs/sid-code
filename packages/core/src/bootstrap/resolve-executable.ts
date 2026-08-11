/**
 * 解析 sid-code 子进程启动命令
 *
 * 解决编译二进制 vs 开发模式（bun run）下 spawn 子进程路径不一致的问题：
 * - 开发模式：import.meta.url 指向磁盘真实路径，可用 "bun run <absolutePath>"
 * - 编译二进制：import.meta.url 指向 /$bunfs/root/...（虚拟路径），.ts 文件不存在于磁盘，
 *   必须用二进制自身路径（process.execPath）替代 "bun run <.ts>"
 *
 * 使用方：daemon/headless-executor.ts、daemon/service.ts、command/review.ts
 * （sub-agent spawn 有独立的 headless.ts 入口和 HEADLESS_AVAILABLE 守卫，不走此函数）
 */

import { dirname, join } from "path";
import { fileURLToPath } from "url";
import { existsSync } from "fs";

/** 通过 import.meta.url 定位 bootstrap.ts 绝对路径 */
const __dirname = dirname(fileURLToPath(import.meta.url));
const BOOTSTRAP_PATH = join(__dirname, "..", "entrypoints", "bootstrap.ts");

/** 是否为开发模式（bootstrap.ts 存在于磁盘） */
const IS_DEV_MODE = existsSync(BOOTSTRAP_PATH);

/**
 * 获取启动 sid-code 子进程的命令和基础参数。
 *
 * - 开发模式：{ cmd: "bun", baseArgs: ["run", "/abs/path/to/bootstrap.ts"] }
 * - 编译二进制：{ cmd: "<二进制路径>", baseArgs: [] }
 *
 * 调用方在 baseArgs 后追加自己的参数（如 "-p", "--model", prompt 等）。
 */
export function resolveExecutable(): { cmd: string; baseArgs: string[] } {
  if (IS_DEV_MODE) {
    return { cmd: "bun", baseArgs: ["run", BOOTSTRAP_PATH] };
  }
  // 编译二进制：直接调用自身
  return { cmd: process.execPath, baseArgs: [] };
}

/** 暴露给需要判断运行模式的模块 */
export { IS_DEV_MODE, BOOTSTRAP_PATH };
