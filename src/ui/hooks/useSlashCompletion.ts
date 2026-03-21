/**
 * / 斜杠命令补全 hook
 *
 * 检测输入以 / 开头且光标在第一个空格之前时，
 * 从命令列表中进行前缀匹配 + 别名匹配。
 */

import { useEffect } from "react";
import type { Suggestion } from "../components/SuggestionsDisplay.tsx";

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
    // 必须以 / 开头
    if (!text.startsWith("/")) {
      setSuggestions([]);
      return;
    }

    // 光标必须在第一个空格之前（即还在输入命令名）
    const spaceIdx = text.indexOf(" ");
    if (spaceIdx !== -1 && cursorCol > spaceIdx) {
      setSuggestions([]);
      return;
    }

    const query = text.slice(1, cursorCol).toLowerCase();

    const matches: Suggestion[] = [];
    for (const cmd of commands) {
      const name = cmd.name.toLowerCase();
      // 名称前缀匹配
      if (name.startsWith(query)) {
        matches.push({
          label: `/${cmd.name}`,
          value: `/${cmd.name} `,
          description: cmd.description,
        });
        continue;
      }
      // 别名匹配
      for (const alias of cmd.aliases) {
        if (alias.toLowerCase().startsWith(query)) {
          matches.push({
            label: `/${cmd.name}`,
            value: `/${cmd.name} `,
            description: `(${alias}) ${cmd.description}`,
          });
          break;
        }
      }
    }

    // 按名称排序
    matches.sort((a, b) => a.label.localeCompare(b.label));
    setSuggestions(matches.slice(0, 20));
  }, [text, cursorCol, commands]);
}
