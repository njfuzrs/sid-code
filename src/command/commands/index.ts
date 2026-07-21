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
import loop from "./loop/index.ts";
import effort from "./effort/index.ts";
import think from "./think/index.ts";
import goal from "./goal/index.ts";
import debug from "./debug/index.ts";
import exportCmd from "./export/index.ts";
import diff from "./diff/index.ts";
import doctor from "./doctor/index.ts";
import todos from "./todos/index.ts";
import status from "./status/index.ts";
import context from "./context/index.ts";
import vim from "./vim/index.ts";
import statusline from "./statusline/index.ts";
import terminalSetup from "./terminal-setup/index.ts";
import workflows from "./workflows/index.ts";
import copy from "./copy/index.ts";
import rename from "./rename/index.ts";
import insights from "./insights/index.ts";
import bug from "./bug/index.ts";
import keybindings from "./keybindings/index.ts";
import claudeApi from "./claude-api/index.ts";
import fork from "./fork/index.ts";
import tui from "./tui/index.ts";
import color from "./color/index.ts";
import fast from "./fast/index.ts";
import batch from "./batch/index.ts";

export const BUILTIN_COMMANDS: UnifiedCommand[] = [
  compact,
  model,
  btw,
  loop,
  effort,
  think,
  goal,
  debug,
  exportCmd,
  diff,
  doctor,
  todos,
  status,
  context,
  vim,
  statusline,
  terminalSetup,
  workflows,
  copy,
  rename,
  insights,
  bug,
  keybindings,
  claudeApi,
  fork,
  tui,
  color,
  fast,
  batch,
];
