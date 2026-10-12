/**
 * 斜杠命令结果去哪：面板 / 状态栏 / 不显示。消息流不在选项里——
 * 历史区只保留真实对话（ui/CLAUDE.md §H）。
 *
 * 拆成纯函数是为了单测能锁口径：曾经短回执漏走消息流（`/model xxx` 留下命令行 + 回执），
 * 判据散在 app.ts 闭包里时没有任何测试能拦住。
 */

import { PANEL_MIN_LINES } from "@sid-code/core/command-contract/types.ts";
import type { CommandPanelSpec } from "../command/types.ts";
import type { Message } from "@sid-code/core/llm/types.ts";

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

/**
 * 模型对斜杠命令的回答（fork 子代理执行的 skill / 自定义命令）落成的一轮对话。
 *
 * 不在 routeCommandResult 的三个去处里：它不是命令报告，是对话本身——要进消息流、
 * 进上下文（下一轮模型才接得上）、进会话存档（resume 后还在）。
 * user 消息用 command-expansion 标记，屏幕只显示触发命令（与 inline 展开同一套渲染），
 * 正文同样是触发命令原文：展开后的提示词只喂给了子代理，主对话里没有它。
 */
export function buildCommandAnswerMessages(
  input: string,
  output: string | null | undefined,
): Message[] {
  const text = (output ?? "").trim();
  return [
    {
      role: "user",
      content: [{ type: "text", text: input }],
      _meta: { origin: "command-expansion", displayCommand: input },
    },
    { role: "assistant", content: [{ type: "text", text: text || "（无输出）" }] },
  ];
}
