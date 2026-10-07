/**
 * / 斜杠命令补全 hook
 *
 * 升级（Task 5）：
 * - Fuse.js 模糊搜索（/cmpct → compact）+ 五级优先级排序 + 使用频率追踪
 * - 描述搜索（/搜索 → grep，若描述含关键词）
 * - 中间位置补全（"help me /com" 中的 /com 也能触发）
 *
 * 仍保持原 props/输出契约（CommandInfo[] in，Suggestion[] out），
 * 排序核心逻辑下沉到 src/command/suggestions.ts。
 */

import { useEffect } from "react";
import type { Suggestion } from "../components/SuggestionsDisplay.tsx";
import { rankCommandInfos } from "../../command/suggestions.ts";
import { resolveSlashCompletionTarget } from "../../command/mid-input.ts";

export interface CommandInfo {
  name: string;
  aliases: string[];
  description: string;
  /** 无参数就无法工作（如 /btw）——补全列表回车仅回填等待输入 */
  requiresArgs?: boolean;
  /** 参数提示（如 "你的问题"），补全列表在命令名后 dim 显示 */
  argumentHint?: string;
}

export interface UseSlashCompletionProps {
  /** 输入框全部行 */
  lines: readonly string[];
  /** 光标所在行 */
  cursorRow: number;
  /** 光标在所在行的列位置 */
  cursorCol: number;
  /** 所有已注册命令 */
  commands: CommandInfo[];
  /**
   * 设置建议列表。replaceFrom：null = 行首命令（整行替换）；数字 = 中间位置 token 起点，
   * 应用补全时只替换该 token（D4）。
   */
  setSuggestions: (suggestions: Suggestion[], replaceFrom: number | null) => void;
}

export function useSlashCompletion({
  lines,
  cursorRow,
  cursorCol,
  commands,
  setSuggestions,
}: UseSlashCompletionProps) {
  // 只有光标所在行参与判定（D5）；依赖取该行文本而不是整个 lines 数组，避免别的行变化触发重算。
  const line = lines[cursorRow] ?? "";
  useEffect(() => {
    // 情况 A：行首斜杠命令（仅第 1 行）；情况 B：中间位置斜杠命令（任意行）
    const target = resolveSlashCompletionTarget(lines, cursorRow, cursorCol);
    if (!target) {
      setSuggestions([], null);
      return;
    }
    const ranked = rankCommandInfos(commands, target.query, 20);
    setSuggestions(
      ranked.map((r) => ({
        label: r.label,
        value: r.value,
        description: r.description,
        icon: "›",
        tag: "命令",
        requiresArgs: r.requiresArgs,
        argumentHint: r.argumentHint,
      })),
      target.replaceFrom,
    );
    // lines 只经 line（当前行）被读取，故依赖写 line 而非整个数组
  }, [line, cursorRow, cursorCol, commands]);
}
