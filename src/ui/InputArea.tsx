/**
 * 输入区域组件（增强版 Composer）
 *
 * 集成：
 * - TextBuffer：多行编辑、visual 行映射、viewport 滚动
 * - useSlashCompletion：/ 命令补全
 * - useAtCompletion：@ 文件路径补全
 * - SuggestionsDisplay：补全列表 UI
 *
 * 粘贴处理：
 * KeypressContext 的 bufferPaste 中间件已将 Bracketed Paste Mode 的
 * paste-start ... paste-end 序列合并为单个 name='paste' 事件，
 * InputArea 只需处理该事件即可。
 */

import React, { useCallback, useRef, useEffect, useState } from "react";
import { Box, Text, useStdout } from "ink";
import { getLogger } from "../debug/logger.ts";
import { theme } from "./semantic-colors.ts";
import { useKeypress, KeypressPriority } from "./contexts/KeypressContext.tsx";
import { useTextBuffer, getVisualLines, getCursorVisualPosition } from "./text-buffer.ts";
import { useSlashCompletion, type CommandInfo } from "./hooks/useSlashCompletion.ts";
import { useAtCompletion } from "./hooks/useAtCompletion.ts";
import { SuggestionsDisplay, type Suggestion } from "./components/SuggestionsDisplay.tsx";

interface InputAreaProps {
  onSubmit: (text: string) => void;
  isLoading: boolean;
  commands: CommandInfo[];
  cwd: string;
}

const PLACEHOLDER = "输入消息或 /help 查看命令...";
const PROMPT = "> ";
/** InputArea 最大可见行数（超过时 viewport 滚动） */
const MAX_INPUT_LINES = 8;

// ── 水平分隔线组件 ─────────────────────────────────────────────────

function HorizontalRule({ color, width }: { color: string; width: number }) {
  return <Text color={color}>{"─".repeat(Math.max(0, width))}</Text>;
}

/**
 * 清理粘贴文本：
 * - Tab → 2 空格
 * - 控制字符（\x00-\x1f 除 \t \r \n）→ 删除
 * - 保留换行（多行粘贴支持）
 */
const cleanPasteText = (raw: string): string =>
  raw
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .replace(/\t/g, "  ")
    // eslint-disable-next-line no-control-regex
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, "");

// ── 组件 ──────────────────────────────────────────────────────────

export function InputArea({ onSubmit, isLoading, commands, cwd }: InputAreaProps) {
  const lastSubmittedRef = useRef<string>("");
  const log = getLogger();
  const prevLoadingRef = useRef(isLoading);
  const { stdout } = useStdout();
  const termWidth = stdout.columns || 80;
  const availableWidth = Math.max(10, termWidth - 2); // paddingX=1 左右各 1

  // TextBuffer
  const tb = useTextBuffer({
    viewport: { height: MAX_INPUT_LINES, width: availableWidth - PROMPT.length },
  });

  // 补全状态
  const [suggestions, setSuggestions] = useState<Suggestion[]>([]);
  const [activeIndex, setActiveIndex] = useState(0);
  const completionModeRef = useRef<"none" | "slash" | "at">("none");

  // 当前行文本和光标位置
  const currentLine = tb.state.lines[tb.state.cursorRow] ?? "";
  const firstLine = tb.state.lines[0] ?? "";

  // / 命令补全
  const setSlashSuggestions = useCallback((items: Suggestion[]) => {
    if (items.length > 0) {
      completionModeRef.current = "slash";
      setSuggestions(items);
      setActiveIndex(0);
    } else if (completionModeRef.current === "slash") {
      completionModeRef.current = "none";
      setSuggestions([]);
      setActiveIndex(0);
    }
  }, []);

  useSlashCompletion({
    text: firstLine,
    cursorCol: tb.state.cursorRow === 0 ? tb.state.cursorCol : firstLine.length,
    commands,
    setSuggestions: setSlashSuggestions,
  });

  // @ 文件补全
  const setAtSuggestions = useCallback((items: Suggestion[]) => {
    if (items.length > 0) {
      completionModeRef.current = "at";
      setSuggestions(items);
      setActiveIndex(0);
    } else if (completionModeRef.current === "at") {
      completionModeRef.current = "none";
      setSuggestions([]);
      setActiveIndex(0);
    }
  }, []);

  useAtCompletion({
    cursorCol: tb.state.cursorCol,
    currentLine,
    cwd,
    setSuggestions: setAtSuggestions,
  });

  const hasSuggestions = suggestions.length > 0;

  // 应用补全：替换触发文本为选中的补全值
  const applyCompletion = useCallback((suggestion: Suggestion) => {
    const mode = completionModeRef.current;
    if (mode === "slash") {
      // 替换整行为命令
      tb.moveCursor("home");
      tb.killLine();
      tb.insert(suggestion.value);
    } else if (mode === "at") {
      // 找到 @ 的位置，替换 @ 后的 pattern
      const line = tb.state.lines[tb.state.cursorRow];
      let atPos = -1;
      for (let i = tb.state.cursorCol - 1; i >= 0; i--) {
        if (line[i] === "@") { atPos = i; break; }
        if (line[i] === " ") break;
      }
      if (atPos >= 0) {
        // 删除 @ 后的 pattern
        const deleteCount = tb.state.cursorCol - atPos - 1;
        for (let i = 0; i < deleteCount; i++) tb.deleteBackward();
        tb.insert(suggestion.value);
      }
    }
    setSuggestions([]);
    setActiveIndex(0);
    completionModeRef.current = "none";
  }, [tb]);

  useEffect(() => {
    if (prevLoadingRef.current !== isLoading) {
      log.debug("UI:INPUT", `isLoading 变化: ${prevLoadingRef.current} → ${isLoading}`);
      prevLoadingRef.current = isLoading;
    }
  }, [isLoading]);

  const handleSubmit = useCallback(() => {
    const text = tb.submit();
    if (!text) return;

    if (text === lastSubmittedRef.current) {
      log.warn("UI:INPUT", `重复内容被拦截: "${text.slice(0, 50)}"`);
      return;
    }

    log.info("UI:INPUT", `提交输入: "${text.slice(0, 100)}"${text.length > 100 ? "..." : ""}`);
    lastSubmittedRef.current = text;
    onSubmit(text);

    setTimeout(() => { lastSubmittedRef.current = ""; }, 1000);
  }, [tb, onSubmit]);

  // ── 核心键盘处理 ──────────────────────────────────────────────────
  useKeypress(KeypressPriority.Normal, (key) => {
    if (isLoading) return false;

    // ── 粘贴事件 ──
    if (key.name === "paste") {
      const cleaned = cleanPasteText(key.sequence);
      if (cleaned.length > 0) {
        log.debug("UI:INPUT", `粘贴: ${cleaned.length} 字符`);
        tb.insert(cleaned);
      }
      return true;
    }

    // ── 补全列表交互 ──
    if (hasSuggestions) {
      if (key.name === "escape") {
        setSuggestions([]);
        setActiveIndex(0);
        completionModeRef.current = "none";
        return true;
      }
      if (key.name === "tab" || (key.name === "enter" && !key.shift)) {
        applyCompletion(suggestions[activeIndex]);
        return true;
      }
      if (key.name === "up" && !key.shift) {
        setActiveIndex(i => (i - 1 + suggestions.length) % suggestions.length);
        return true;
      }
      if (key.name === "down" && !key.shift) {
        setActiveIndex(i => (i + 1) % suggestions.length);
        return true;
      }
    }

    // ── 普通键盘输入 ──
    if (key.name === "enter" && !key.shift) { handleSubmit(); return true; }

    // 多行输入：Shift+Enter 插入真正的换行
    if (key.name === "enter" && key.shift) { tb.insert("\n"); return true; }

    // 历史记录：仅单行时 ↑↓ 触发历史
    if (key.name === "up" && !key.shift) {
      if (tb.state.lines.length === 1) {
        tb.historyUp();
      } else {
        tb.moveCursor("up");
      }
      return true;
    }
    if (key.name === "down" && !key.shift) {
      if (tb.state.lines.length === 1) {
        tb.historyDown();
      } else {
        tb.moveCursor("down");
      }
      return true;
    }

    if (key.name === "left" && !key.alt) { tb.moveCursor("left"); return true; }
    if (key.name === "right" && !key.alt) { tb.moveCursor("right"); return true; }
    if (key.name === "left" && key.alt) { tb.moveCursor("wordLeft"); return true; }
    if (key.name === "right" && key.alt) { tb.moveCursor("wordRight"); return true; }
    if (key.name === "backspace" || key.name === "delete") { tb.deleteBackward(); return true; }
    if (key.name === "home") { tb.moveCursor("home"); return true; }
    if (key.name === "end") { tb.moveCursor("end"); return true; }

    // Emacs 快捷键
    if (key.ctrl) {
      if (key.name === "a") { tb.moveCursor("home"); return true; }
      if (key.name === "e") { tb.moveCursor("end"); return true; }
      if (key.name === "k") { tb.killLine(); return true; }
      if (key.name === "u") { tb.killToStart(); return true; }
      if (key.name === "d") { tb.deleteForward(); return true; }
    }

    // 可插入字符
    if (key.insertable && !key.ctrl && !key.alt && !key.cmd) {
      tb.insert(key.sequence);
      return true;
    }

    return false;
  });

  // ── 渲染 ──────────────────────────────────────────────────────────

  if (isLoading) {
    return (
      <Box flexDirection="column">
        <HorizontalRule color={theme.ui.dark} width={termWidth} />
        <Box paddingX={1}>
          <Text dimColor>等待响应中...</Text>
        </Box>
        <HorizontalRule color={theme.ui.dark} width={termWidth} />
      </Box>
    );
  }

  const isEmpty = tb.isEmpty();

  if (isEmpty) {
    return (
      <Box flexDirection="column">
        <HorizontalRule color={theme.ui.active} width={termWidth} />
        <Box paddingX={1}>
          <Text>
            <Text color={theme.ui.active} bold>{PROMPT}</Text>
            <Text inverse> </Text>
            <Text dimColor>{PLACEHOLDER}</Text>
          </Text>
        </Box>
        <HorizontalRule color={theme.ui.active} width={termWidth} />
      </Box>
    );
  }

  // 构建带 PROMPT 前缀的显示行
  // 第一逻辑行前面加 "> "，后续逻辑行前面加 "  "（对齐缩进）
  const displayLines: string[] = tb.state.lines.map((line, i) =>
    i === 0 ? PROMPT + line : "  " + line,
  );

  // 计算 visual 行
  const visualLines = getVisualLines(displayLines, availableWidth);

  // 光标在 display 坐标中的位置
  const displayCursorCol = tb.state.cursorRow === 0
    ? PROMPT.length + tb.state.cursorCol
    : 2 + tb.state.cursorCol; // "  " 缩进
  const cursorPos = getCursorVisualPosition(displayLines, tb.state.cursorRow, displayCursorCol, availableWidth);

  // Viewport 滚动
  const totalVisualLines = visualLines.length;
  let viewStart = 0;
  if (totalVisualLines > MAX_INPUT_LINES) {
    viewStart = Math.max(0, Math.min(
      cursorPos.visualRow - Math.floor(MAX_INPUT_LINES / 2),
      totalVisualLines - MAX_INPUT_LINES,
    ));
  }
  const viewEnd = Math.min(viewStart + MAX_INPUT_LINES, totalVisualLines);
  const visibleLines = visualLines.slice(viewStart, viewEnd);

  const renderedLines = visibleLines.map((vl, i) => {
    const visualIdx = viewStart + i;
    const lineText = vl.text;

    if (visualIdx !== cursorPos.visualRow) {
      // 非光标行
      if (vl.logicalRow === 0 && vl.start === 0) {
        // 第一逻辑行的第一个 visual 行：高亮 PROMPT
        return (
          <Text key={`vl-${visualIdx}`}>
            <Text color={theme.ui.active} bold>{PROMPT}</Text>
            {lineText.slice(PROMPT.length)}
          </Text>
        );
      }
      return <Text key={`vl-${visualIdx}`}>{lineText}</Text>;
    }

    // 光标行：在 cursorCol 处插入 inverse 字符
    const colInLine = cursorPos.visualCol;
    const before = lineText.slice(0, colInLine);
    const cursorChar = lineText[colInLine] || " ";
    const after = colInLine < lineText.length ? lineText.slice(colInLine + 1) : "";

    if (vl.logicalRow === 0 && vl.start === 0) {
      return (
        <Text key={`vl-${visualIdx}`}>
          <Text color={theme.ui.active} bold>{PROMPT}</Text>
          {before.slice(PROMPT.length)}
          <Text inverse>{cursorChar}</Text>
          {after}
        </Text>
      );
    }

    return (
      <Text key={`vl-${visualIdx}`}>
        {before}
        <Text inverse>{cursorChar}</Text>
        {after}
      </Text>
    );
  });

  return (
    <Box flexDirection="column">
      {hasSuggestions && (
        <SuggestionsDisplay
          suggestions={suggestions}
          activeIndex={activeIndex}
          width={termWidth}
        />
      )}
      <HorizontalRule color={theme.ui.active} width={termWidth} />
      <Box paddingX={1} flexDirection="column">
        {renderedLines}
      </Box>
      <HorizontalRule color={theme.ui.active} width={termWidth} />
    </Box>
  );
}
