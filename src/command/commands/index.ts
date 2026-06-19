/**
 * 内置命令聚合（延迟加载入口）
 *
 * 只 import 命令定义对象（轻量），实现代码（call() 函数）通过各命令的 load()
 * 在用户实际调用时才动态 import，优化启动性能。
 *
 * 迁移进度：已迁移的命令在此聚合；未迁移的命令仍在 builtins.ts 中，
 * 由 loaders.ts 的 loadBuiltinCommands() 通过 legacy 适配器桥接。
 */

import type { UnifiedCommand } from "../types.ts";
import compact from "./compact/index.ts";
import model from "./model/index.ts";
import btw from "./btw/index.ts";

export const BUILTIN_COMMANDS: UnifiedCommand[] = [
  compact,
  model,
  btw,
];
