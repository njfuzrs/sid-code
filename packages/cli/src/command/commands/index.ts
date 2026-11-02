/**
 * 内置命令聚合（延迟加载入口）
 *
 * 只 import 命令定义对象（轻量），实现代码（call() 函数）通过各命令的 load()
 * 在用户实际调用时才动态 import，优化启动性能。
 *
 * 全部内置命令都在 commands/ 下（2026-11-02 命令体系收口，旧 builtins.ts 与 adapter 已删除）。
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
import perf from "./perf/index.ts";
import bug from "./bug/index.ts";
import keybindings from "./keybindings/index.ts";
import fork from "./fork/index.ts";
import tui from "./tui/index.ts";
import color from "./color/index.ts";
import fast from "./fast/index.ts";
import batch from "./batch/index.ts";
import conflict from "./conflict/index.ts";
import login from "./login/index.ts";
import logout from "./logout/index.ts";
import whoami from "./whoami/index.ts";
import help from "./help/index.ts";
import cost from "./cost/index.ts";
import cache from "./cache/index.ts";
import trace from "./trace/index.ts";
import clear from "./clear/index.ts";
import config from "./config/index.ts";
import undo from "./undo/index.ts";
import checkpoints from "./checkpoints/index.ts";
import restore from "./restore/index.ts";
import memory from "./memory/index.ts";
import mcp from "./mcp/index.ts";
import ide from "./ide/index.ts";
import lsp from "./lsp/index.ts";
import skills from "./skills/index.ts";
import agents from "./agents/index.ts";
import commandsCmd from "./commands/index.ts";
import exit from "./exit/index.ts";
import rewind from "./rewind/index.ts";
import stats from "./stats/index.ts";
import telemetry from "./telemetry/index.ts";
import init from "./init/index.ts";
import hooks from "./hooks/index.ts";
import plan from "./plan/index.ts";
import theme from "./theme/index.ts";
import language from "./language/index.ts";
import allow from "./allow/index.ts";
import deny from "./deny/index.ts";
import permissions from "./permissions/index.ts";
import addDir from "./add-dir/index.ts";
import plugin from "./plugin/index.ts";
import reloadPlugins from "./reload-plugins/index.ts";
import ps from "./ps/index.ts";
import worktree from "./worktree/index.ts";
import cron from "./cron/index.ts";

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
  perf,
  bug,
  keybindings,
  fork,
  tui,
  color,
  fast,
  batch,
  conflict,
  login,
  logout,
  whoami,
  help,
  cost,
  cache,
  trace,
  clear,
  config,
  undo,
  checkpoints,
  restore,
  memory,
  mcp,
  ide,
  lsp,
  skills,
  agents,
  commandsCmd,
  exit,
  rewind,
  stats,
  telemetry,
  init,
  hooks,
  plan,
  theme,
  language,
  allow,
  deny,
  permissions,
  addDir,
  plugin,
  reloadPlugins,
  ps,
  worktree,
  cron,
];
