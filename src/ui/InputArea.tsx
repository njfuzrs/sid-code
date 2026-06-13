/**
 * 输入区域组件（InputPrompt）
 *
 * 集成：
 * - TextBuffer：多行编辑、visual 行映射、viewport 滚动
 * - useSlashCompletion：/ 命令补全
 * - useAtCompletion：@ 文件路径补全
 * - useReverseSearch：Ctrl+R 反向搜索历史
 * - useInputHistoryStore：输入历史持久化
 * - SuggestionsDisplay：补全列表 UI
 * - 输入语法高亮（/命令、@文件、!shell）
 *
 * 粘贴处理：
 * KeypressContext 的 bufferPaste 中间件已将 Bracketed Paste Mode 的
 * paste-start ... paste-end 序列合并为单个 name='paste' 事件，
 * InputArea 只需处理该事件即可。
 */

import React, { useCallback, useRef, useEffect, useState } from "react";
import Box from "../ink/components/Box.js";
import Text from "../ink/components/Text.js";
import useStdout from "../ink/_vendor/use-stdout.js";
import { getLogger } from "../debug/logger.ts";
import { theme } from "./semantic-colors.ts";
import { useKeypress, KeypressPriority } from "./contexts/KeypressContext.tsx";
import { useTextBuffer, getVisualLines, getCursorVisualPosition } from "./text-buffer.ts";
import { useSlashCompletion, type CommandInfo } from "./hooks/useSlashCompletion.ts";
import { useAtCompletion } from "./hooks/useAtCompletion.ts";
import { useReverseSearch } from "./hooks/useReverseSearch.ts";
import { useInputHistoryStore } from "./hooks/useInputHistoryStore.ts";
import { useShellCompletion } from "./hooks/useShellCompletion.ts";
import { consumePendingRestore } from "./pending-input.ts";
import {
  registerPaste,
  shouldPlaceholder,
  expandPastedRefs,
  clearPastes,
} from "./pasted-contents.ts";
import { SuggestionsDisplay, type Suggestion } from "./components/SuggestionsDisplay.tsx";
import { parseInputForHighlighting, renderHighlightedSegments } from "./utils/inputHighlight.tsx";
import { DEFAULT_TERM_WIDTH } from "./markdown.ts";

interface InputAreaProps {
  onSubmit: (text: string) => void;
  isLoading: boolean;
  commands: CommandInfo[];
  cwd: string;
  /** Shift+Tab 权限模式切换回调（可选） */
  onPermissionModeSwitch?: () => void;
}

const PLACEHOLDER = "输入消息或 /help 查看命令...";
const PROMPT = "> ";
const SHELL_PROMPT = "! ";
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

// ── 渲染辅助：带语法高亮的行内容 ──

/** 渲染第一行内容（带语法高亮，去掉 PROMPT 前缀后高亮） */
function renderFirstLineContent(lineText: string, promptLen: number): React.ReactNode {
  const content = lineText.slice(promptLen);
  if (!content) return null;
  const segments = parseInputForHighlighting(content);
  return <>{renderHighlightedSegments(segments)}</>;
}

// ── 组件 ──────────────────────────────────────────────────────────

export function InputArea({ onSubmit, isLoading, commands, cwd, onPermissionModeSwitch }: InputAreaProps) {
  const lastSubmittedRef = useRef<string>("");
  const log = getLogger();
  const prevLoadingRef = useRef(isLoading);
  const { stdout } = useStdout();
  const termWidth = stdout.columns || DEFAULT_TERM_WIDTH;
  const availableWidth = Math.max(10, termWidth - 2); // paddingX=1 左右各 1

  // Shell 模式状态（! 前缀直接执行 shell 命令）
  const [shellModeActive, setShellModeActive] = useState(false);

  // 输入历史持久化
  const { history: persistedHistory, addEntry: addHistoryEntry } = useInputHistoryStore();

  // TextBuffer
  const tb = useTextBuffer({
    viewport: { height: MAX_INPUT_LINES, width: availableWidth - PROMPT.length },
  });

  // 挂载时消费早期输入缓冲（启动期间用户按键）
  const earlyInputConsumed = useRef(false);
  useEffect(() => {
    if (earlyInputConsumed.current) return;
    earlyInputConsumed.current = true;
    import("./early-input.ts").then(({ consumeEarlyInput }) => {
      const earlyText = consumeEarlyInput();
      if (earlyText) {
        tb.setText(earlyText);
      }
    }).catch(() => { /* 静默失败 */ });
  }, []);

  // 反向搜索
  const reverseSearch = useReverseSearch({ history: persistedHistory });

  // 补全状态
  const [suggestions, setSuggestions] = useState<Suggestion[]>([]);
  const [activeIndex, setActiveIndex] = useState(0);
  const completionModeRef = useRef<"none" | "slash" | "at" | "shell">("none");

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

  // ! Shell 命令补全
  const setShellSuggestions = useCallback((items: Suggestion[]) => {
    if (items.length > 0) {
      completionModeRef.current = "shell";
      setSuggestions(items);
      setActiveIndex(0);
    } else if (completionModeRef.current === "shell") {
      completionModeRef.current = "none";
      setSuggestions([]);
      setActiveIndex(0);
    }
  }, []);

  useShellCompletion({
    text: firstLine,
    cursorCol: tb.state.cursorRow === 0 ? tb.state.cursorCol : firstLine.length,
    shellMode: shellModeActive,
    setSuggestions: setShellSuggestions,
  });

  const hasSuggestions = suggestions.length > 0;

  // 应用补全：替换触发文本为选中的补全值
  const applyCompletion = useCallback((suggestion: Suggestion) => {
    const mode = completionModeRef.current;
    if (mode === "slash" || mode === "shell") {
      // 替换整行为命令（shell 模式保留 ! 前缀）
      tb.moveCursor("home");
      tb.killLine();
      if (mode === "shell") {
        tb.insert("!" + suggestion.value);
      } else {
        tb.insert(suggestion.value);
      }
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
      const wasLoading = prevLoadingRef.current;
      prevLoadingRef.current = isLoading;
      // A4：loading→idle 边沿(本轮结束)消费"待回填输入"。
      // 仅当用户 ESC 取消且通过守卫时 app 层才会 markForRestore,故此处拿到非 null 即应回填。
      // 守卫 tb.isEmpty():不覆盖用户在 loading 期间已敲入的新内容（对标 cc 的 inputValueRef==='' 守卫）。
      if (wasLoading && !isLoading) {
        const restore = consumePendingRestore();
        if (restore && tb.isEmpty()) {
          tb.setText(restore.text);
          if (restore.shellMode) setShellModeActive(true);
          log.info("UI:INPUT", "已自动恢复被取消的输入");
        }
      }
    }
  }, [isLoading, tb]);

  const handleSubmit = useCallback(() => {
    const text = tb.submit();
    if (!text) return;

    if (text === lastSubmittedRef.current) {
      log.warn("UI:INPUT", `重复内容被拦截: "${text.slice(0, 50)}"`);
      return;
    }

    // 持久化历史
    addHistoryEntry(text);

    // Shell 模式：! 前缀直接执行 shell 命令
    if (shellModeActive && text.startsWith("!")) {
      const shellCmd = text.slice(1).trim();
      if (shellCmd) {
        log.info("UI:INPUT", `Shell 模式执行: "${shellCmd}"`);
        onSubmit(`/bash ${shellCmd}`);
      }
      setShellModeActive(false);
      lastSubmittedRef.current = text;
      setTimeout(() => { lastSubmittedRef.current = ""; }, 1000);
      return;
    }

    log.info("UI:INPUT", `提交输入: "${text.slice(0, 100)}"${text.length > 100 ? "..." : ""}`);
    lastSubmittedRef.current = text;
    onSubmit(text);

    setTimeout(() => { lastSubmittedRef.current = ""; }, 1000);
  }, [tb, onSubmit, shellModeActive, addHistoryEntry]);

  // ── 核心键盘处理 ──────────────────────────────────────────────────
  useKeypress(KeypressPriority.Normal, (key) => {
    if (isLoading) return false;

    // ── 反向搜索模式 ──
    if (reverseSearch.state.active) {
      if (key.name === "escape") {
        reverseSearch.deactivate();
        return true;
      }
      if (key.name === "enter") {
        // 选中当前匹配项
        const match = reverseSearch.getMatch();
        if (match) {
          tb.setText(match);
        }
        reverseSearch.deactivate();
        return true;
      }
      if (key.ctrl && key.name === "r") {
        // 继续搜索下一个
        reverseSearch.searchNext();
        return true;
      }
      // ↑/↓ 在反搜模式下遍历匹配项（↑ 更早，↓ 更新），不插入换行
      if (key.name === "up") {
        reverseSearch.searchNext();
        return true;
      }
      if (key.name === "down") {
        reverseSearch.searchPrev();
        return true;
      }
      if (key.name === "backspace") {
        reverseSearch.deleteQuery();
        return true;
      }
      if (key.insertable && !key.ctrl && !key.alt) {
        reverseSearch.appendQuery(key.sequence);
        return true;
      }
      return false;
    }

    // Ctrl+R 激活反向搜索
    if (key.ctrl && key.name === "r") {
      reverseSearch.activate();
      return true;
    }

    // Shell 模式切换：! 在行首时进入 Shell 模式
    if (key.insertable && key.sequence === "!" && tb.isEmpty()) {
      setShellModeActive(true);
      tb.insert("!");
      return true;
    }

    // 退出 Shell 模式：删除 ! 后退出
    if (shellModeActive && key.name === "backspace" && tb.state.lines[0] === "!") {
      tb.deleteBackward();
      setShellModeActive(false);
      return true;
    }

    // ── 粘贴事件 ──
    // Shift+Tab：权限模式切换
    if (key.shift && key.name === "tab") {
      if (onPermissionModeSwitch) {
        onPermissionModeSwitch();
      }
      return true;
    }

    if (key.name === "paste") {
      const cleaned = cleanPasteText(key.sequence);
      if (cleaned.length > 0) {
        // IN3：大块粘贴登记元数据并插入精简占位引用，提交时还原；
        // 小块粘贴直接插入，保持顺手。
        if (shouldPlaceholder(cleaned)) {
          const ref = registerPaste(cleaned, "text");
          log.debug("UI:INPUT", `粘贴(占位): ${cleaned.length} 字符 → ${ref}`);
          tb.insert(ref);
        } else {
          log.debug("UI:INPUT", `粘贴: ${cleaned.length} 字符`);
          tb.insert(cleaned);
        }
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

  // 反向搜索模式 UI
  if (reverseSearch.state.active) {
    const { query, match } = reverseSearch.state;
    return (
      <Box flexDirection="column">
        <HorizontalRule color={theme.status.warning} width={termWidth} />
        <Box paddingX={1} flexDirection="column">
          <Box>
            <Text color={theme.status.warning}>反向搜索: </Text>
            <Text>{query}</Text>
            <Text inverse> </Text>
          </Box>
          {match ? (
            <Box>
              <Text dimColor>匹配: </Text>
              <Text>{match.length > termWidth - 10 ? match.slice(0, termWidth - 13) + "..." : match}</Text>
            </Box>
          ) : query ? (
            <Box>
              <Text color={theme.status.error}>无匹配</Text>
            </Box>
          ) : null}
        </Box>
        <HorizontalRule color={theme.status.warning} width={termWidth} />
      </Box>
    );
  }

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
    const currentPrompt = shellModeActive ? SHELL_PROMPT : PROMPT;
    const currentPlaceholder = shellModeActive ? "输入 shell 命令..." : PLACEHOLDER;

    return (
      <Box flexDirection="column">
        <HorizontalRule color={theme.ui.active} width={termWidth} />
        <Box paddingX={1}>
          <Text>
            <Text color={theme.ui.active} bold>{currentPrompt}</Text>
            <Text inverse> </Text>
            <Text dimColor>{currentPlaceholder}</Text>
          </Text>
        </Box>
        <HorizontalRule color={theme.ui.active} width={termWidth} />
      </Box>
    );
  }

  // 构建带 PROMPT 前缀的显示行
  const currentPrompt = shellModeActive ? SHELL_PROMPT : PROMPT;
  const displayLines: string[] = tb.state.lines.map((line, i) =>
    i === 0 ? currentPrompt + line : "  " + line,
  );

  // 计算 visual 行
  const visualLines = getVisualLines(displayLines, availableWidth);

  // 光标在 display 坐标中的位置
  const displayCursorCol = tb.state.cursorRow === 0
    ? PROMPT.length + tb.state.cursorCol
    : 2 + tb.state.cursorCol;
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
        return (
          <Text key={`vl-${visualIdx}`}>
            <Text color={theme.ui.active} bold>{currentPrompt}</Text>
            {renderFirstLineContent(lineText, currentPrompt.length)}
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
      // 第一行带语法高亮 + 光标
      const contentBefore = before.slice(currentPrompt.length);
      const contentAfter = after;
      const beforeSegments = parseInputForHighlighting(contentBefore);
      const afterSegments = parseInputForHighlighting(contentAfter);

      return (
        <Text key={`vl-${visualIdx}`}>
          <Text color={theme.ui.active} bold>{currentPrompt}</Text>
          {renderHighlightedSegments(beforeSegments)}
          <Text inverse>{cursorChar}</Text>
          {renderHighlightedSegments(afterSegments)}
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
