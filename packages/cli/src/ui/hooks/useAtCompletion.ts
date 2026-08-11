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
import Fuse from "fuse.js";
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

      // 先收集候选项(跳过隐藏文件/node_modules),再决定用 Fuse 模糊还是直接列全部
      const candidates: { entry: (typeof entries)[number]; displayName: string; valuePath: string }[] = [];
      for (const entry of entries) {
        // 跳过隐藏文件（除非用户输入了 .）
        if (entry.name.startsWith(".") && !searchPrefix.startsWith(".")) continue;
        // 跳过 node_modules
        if (entry.name === "node_modules") continue;

        const isDir = entry.isDirectory();
        const displayName = entry.name + (isDir ? "/" : "");
        // 构建完整的补全值（替换 @ 后的 pattern）
        const valuePath = searchDir === "." ? displayName : `${searchDir}/${displayName}`;
        candidates.push({ entry, displayName, valuePath });
      }

      // 模糊匹配：有 searchPrefix 时用 Fuse 子序列/容错匹配(与命令补全一致),
      // 无前缀(目录浏览)时列出全部。
      let ranked: typeof candidates;
      if (searchPrefix) {
        const fuse = new Fuse(candidates, {
          includeScore: true,
          threshold: 0.4,
          ignoreLocation: true,
          keys: ["entry.name"],
        });
        ranked = fuse.search(searchPrefix).map((r) => r.item);
      } else {
        ranked = candidates;
      }

      // 不在数据层截断——由 SuggestionsDisplay 的 MAX_VISIBLE 虚拟滚动窗口控制可见行数，
      // 用户可 ↑↓ 翻页看到全部候选。
      const matches: Suggestion[] = ranked.map(({ entry, displayName, valuePath }) => ({
        label: displayName,
        value: valuePath,
        icon: entry.isDirectory() ? "▸" : "·",
        tag: entry.isDirectory() ? "目录" : "文件",
      }));

      // 无前缀(目录浏览)时按「目录优先 + 名称」排序;
      // 有前缀时保留 Fuse 的相关性排序,不再二次打乱。
      if (!searchPrefix) {
        matches.sort((a, b) => {
          const aIsDir = a.label.endsWith("/");
          const bIsDir = b.label.endsWith("/");
          if (aIsDir !== bIsDir) return aIsDir ? -1 : 1;
          return a.label.localeCompare(b.label);
        });
      }

      setSuggestions(matches);
    } catch {
      // 目录不存在或无权限
      setSuggestions([]);
    }
  }, [currentLine, cursorCol, cwd]);
}
