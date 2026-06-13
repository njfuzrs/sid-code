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
import { findMidInputSlashCommand } from "../../command/mid-input.ts";

export interface CommandInfo {
  name: string;
  aliases: string[];
  description: string;
}

export interface UseSlashCompletionProps {
  /** 当前输入文本（第一行） */
  text: string;
  /** 光标在第一行的列位置 */
  cursorCol: number;
  /** 所有已注册命令 */
  commands: CommandInfo[];
  /** 设置建议列表 */
  setSuggestions: (suggestions: Suggestion[]) => void;
}

export function useSlashCompletion({ text, cursorCol, commands, setSuggestions }: UseSlashCompletionProps) {
  useEffect(() => {
    // 情况 A：行首斜杠命令（/ 开头，光标在第一个空格之前）
    if (text.startsWith("/")) {
      const spaceIdx = text.indexOf(" ");
      if (spaceIdx !== -1 && cursorCol > spaceIdx) {
        setSuggestions([]);
        return;
      }
      const query = text.slice(1, cursorCol);
      const ranked = rankCommandInfos(commands, query, 20);
      setSuggestions(
        ranked.map((r) => ({
          label: r.label,
          value: r.value,
          description: r.description,
          icon: "⌘",
          tag: "命令",
        })),
      );
      return;
    }

    // 情况 B：中间位置斜杠命令（"help me /com"）
    const mid = findMidInputSlashCommand(text, cursorCol);
    if (mid) {
      const ranked = rankCommandInfos(commands, mid.partialCommand, 20);
      setSuggestions(
        ranked.map((r) => ({
          label: r.label,
          // 中间位置补全：替换 token 部分，保留前缀
          value: r.value,
          description: r.description,
          icon: "⌘",
          tag: "命令",
        })),
      );
      return;
    }

    setSuggestions([]);
  }, [text, cursorCol, commands]);
}
