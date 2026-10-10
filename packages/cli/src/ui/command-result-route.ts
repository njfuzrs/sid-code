/**
 * 斜杠命令结果去哪：面板 / 状态栏 / 不显示。消息流不在选项里——
 * 历史区只保留真实对话（ui/CLAUDE.md §H）。
 *
 * 拆成纯函数是为了单测能锁口径：曾经短回执漏走消息流（`/model xxx` 留下命令行 + 回执），
 * 判据散在 app.ts 闭包里时没有任何测试能拦住。
 */

import { PANEL_MIN_LINES } from "@sid-code/core/command-contract/types.ts";
import type { CommandPanelSpec } from "../command/types.ts";

export type CommandResultRoute =
  | { to: "panel"; content: string; panel: CommandPanelSpec }
  | { to: "status"; text: string; delayMs: number }
  | { to: "none" };

/** 短回执在状态栏停留的时长；错误要给人读完的时间，停更久 */
export const COMMAND_STATUS_MS = 4000;
export const COMMAND_ERROR_STATUS_MS = 8000;

export function routeCommandResult(
  output: string | null | undefined,
  opts: { panel?: CommandPanelSpec; isError?: boolean } = {},
): CommandResultRoute {
  // 两端都要 trim：前导空行会被算进行数，让一条两行回执误判成面板
  const text = (output ?? "").trim();
  if (!text) return { to: "none" };
  // 未声明 outputPanel 的命令输出变长时也进面板：消息流不再兜底，状态栏只有一行放不下
  const panel = opts.panel ?? (text.split("\n").length >= PANEL_MIN_LINES ? {} : undefined);
  if (panel) return { to: "panel", content: text, panel };
  const oneLine = text.replace(/\s*\n\s*/g, " · ");
  return opts.isError
    ? { to: "status", text: `✗ ${oneLine}`, delayMs: COMMAND_ERROR_STATUS_MS }
    : { to: "status", text: oneLine, delayMs: COMMAND_STATUS_MS };
}
