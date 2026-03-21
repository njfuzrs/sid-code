/**
 * @ 文件路径补全 hook
 *
 * 检测输入中 @ 字符，提取 @ 后的 pattern，
 * 使用 fs.readdir 做路径补全。
 * 支持递进式路径补全：@src/ → 列出 src 下的文件/目录
 */

import { useEffect, useRef } from "react";
import { readdirSync } from "fs";
import { dirname, basename, resolve } from "path";
import type { Suggestion } from "../components/SuggestionsDisplay.tsx";

export interface UseAtCompletionProps {
  /** 光标在当前行的列位置 */
  cursorCol: number;
  /** 光标所在行的文本 */
  currentLine: string;
  /** 工作目录 */
  cwd: string;
  /** 设置建议列表 */
  setSuggestions: (suggestions: Suggestion[]) => void;
}

const MAX_SUGGESTIONS = 8;

/**
 * 从光标位置向前查找最近的 @ 符号，返回 @ 后的 pattern
 * 如果 @ 前面是字母/数字（如 email），则不触发补全
 */
function extractAtPattern(line: string, cursorCol: number): string | null {
  // 从光标位置向前找 @
  for (let i = cursorCol - 1; i >= 0; i--) {
    if (line[i] === "@") {
      // @ 前面不能是字母/数字（避免 email 误触发）
      if (i > 0 && /\w/.test(line[i - 1])) return null;
      return line.slice(i + 1, cursorCol);
    }
    // 遇到空格则停止（@ 补全不跨空格）
    if (line[i] === " ") return null;
  }
  return null;
}

export function useAtCompletion({ cursorCol, currentLine, cwd, setSuggestions }: UseAtCompletionProps) {
  const lastPatternRef = useRef<string | null>(null);

  useEffect(() => {
    const pattern = extractAtPattern(currentLine, cursorCol);

    if (pattern === null) {
      if (lastPatternRef.current !== null) {
        lastPatternRef.current = null;
        setSuggestions([]);
      }
      return;
    }

    lastPatternRef.current = pattern;

    // 解析路径：分离目录部分和文件名前缀
    const hasSlash = pattern.includes("/");
    const dir = hasSlash ? dirname(pattern) : ".";
    const prefix = hasSlash ? basename(pattern) : pattern;
    // 如果 pattern 以 / 结尾，说明用户想看目录内容
    const isTrailingSlash = pattern.endsWith("/");
    const searchDir = isTrailingSlash ? pattern : dir;
    const searchPrefix = isTrailingSlash ? "" : prefix.toLowerCase();

    try {
      const absDir = resolve(cwd, searchDir);
      const entries = readdirSync(absDir, { withFileTypes: true });

      const matches: Suggestion[] = [];
      for (const entry of entries) {
        // 跳过隐藏文件（除非用户输入了 .）
        if (entry.name.startsWith(".") && !searchPrefix.startsWith(".")) continue;
        // 跳过 node_modules
        if (entry.name === "node_modules") continue;

        if (searchPrefix && !entry.name.toLowerCase().startsWith(searchPrefix)) continue;

        const isDir = entry.isDirectory();
        const displayName = entry.name + (isDir ? "/" : "");
        // 构建完整的补全值（替换 @ 后的 pattern）
        const valuePath = searchDir === "." ? displayName : `${searchDir}/${displayName}`;

        matches.push({
          label: displayName,
          value: valuePath,
          description: isDir ? "目录" : undefined,
        });

        if (matches.length >= MAX_SUGGESTIONS) break;
      }

      // 目录优先，然后按名称排序
      matches.sort((a, b) => {
        const aIsDir = a.label.endsWith("/");
        const bIsDir = b.label.endsWith("/");
        if (aIsDir !== bIsDir) return aIsDir ? -1 : 1;
        return a.label.localeCompare(b.label);
      });

      setSuggestions(matches);
    } catch {
      // 目录不存在或无权限
      setSuggestions([]);
    }
  }, [currentLine, cursorCol, cwd]);
}
