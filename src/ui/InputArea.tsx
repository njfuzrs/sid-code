/**
 * 输入区域组件
 * 使用可见光标字符（inverse 样式）标记光标位置，
 * 支持历史记录（↑↓）和 Emacs 快捷键（Ctrl+A/E/U/K）。
 *
 * 多行文本处理：自行计算视觉行，不依赖 Ink 的自动换行（避免 Ink issue #883）
 *
 * 粘贴处理：
 * KeypressContext 的 bufferPaste 中间件已将 Bracketed Paste Mode 的
 * paste-start ... paste-end 序列合并为单个 name='paste' 事件，
 * InputArea 只需处理该事件即可。
 */

import React, { useReducer, useCallback, useRef, useEffect } from "react";
import { Box, Text, useStdout } from "ink";
import stringWidth from "string-width";
import { getLogger } from "../debug/logger.ts";
import { theme } from "./semantic-colors.ts";
import { useKeypress, KeypressPriority } from "./contexts/KeypressContext.tsx";

interface InputAreaProps {
  onSubmit: (text: string) => void;
  isLoading: boolean;
}

const PLACEHOLDER = "输入消息或 /help 查看命令...";
const MAX_HISTORY = 100;
const PROMPT = "> ";

// ── 文本输入状态管理 ──────────────────────────────────────────────

interface InputState {
  value: string;
  cursorOffset: number;
  history: string[];
  historyIndex: number;
  savedInput: string;
}

type InputAction =
  | { type: "insert"; text: string }
  | { type: "delete" }
  | { type: "move-left" }
  | { type: "move-right" }
  | { type: "home" }
  | { type: "end" }
  | { type: "kill-line" }
  | { type: "kill-to-start" }
  | { type: "history-up" }
  | { type: "history-down" }
  | { type: "reset" };

function inputReducer(state: InputState, action: InputAction): InputState {
  switch (action.type) {
    case "insert":
      return {
        ...state,
        value: state.value.slice(0, state.cursorOffset) + action.text + state.value.slice(state.cursorOffset),
        cursorOffset: state.cursorOffset + action.text.length,
        historyIndex: -1,
      };
    case "delete": {
      if (state.cursorOffset === 0) return state;
      const offset = state.cursorOffset - 1;
      return {
        ...state,
        value: state.value.slice(0, offset) + state.value.slice(offset + 1),
        cursorOffset: offset,
      };
    }
    case "move-left":
      return { ...state, cursorOffset: Math.max(0, state.cursorOffset - 1) };
    case "move-right":
      return { ...state, cursorOffset: Math.min(state.value.length, state.cursorOffset + 1) };
    case "home":
      return { ...state, cursorOffset: 0 };
    case "end":
      return { ...state, cursorOffset: state.value.length };
    case "kill-line":
      return { ...state, value: state.value.slice(0, state.cursorOffset) };
    case "kill-to-start":
      return { ...state, value: state.value.slice(state.cursorOffset), cursorOffset: 0 };
    case "history-up": {
      if (state.history.length === 0) return state;
      const newIdx = state.historyIndex + 1;
      if (newIdx >= state.history.length) return state;
      const saved = state.historyIndex === -1 ? state.value : state.savedInput;
      const histValue = state.history[newIdx];
      return { ...state, value: histValue, cursorOffset: histValue.length, historyIndex: newIdx, savedInput: saved };
    }
    case "history-down": {
      if (state.historyIndex <= -1) return state;
      const newIdx = state.historyIndex - 1;
      if (newIdx === -1) {
        return { ...state, value: state.savedInput, cursorOffset: state.savedInput.length, historyIndex: -1 };
      }
      const histValue = state.history[newIdx];
      return { ...state, value: histValue, cursorOffset: histValue.length, historyIndex: newIdx };
    }
    case "reset": {
      const newHistory = state.value.trim()
        ? [state.value.trim(), ...state.history].slice(0, MAX_HISTORY)
        : state.history;
      return { value: "", cursorOffset: 0, history: newHistory, historyIndex: -1, savedInput: "" };
    }
  }
}

// ── 视觉行切分（自行管理，不依赖 Ink 的 wrap-ansi）──────────────

/** 一个视觉行：原始文本中的起止字符索引 */
interface VisualLine {
  /** 在原始文本中的起始字符索引（含） */
  start: number;
  /** 在原始文本中的结束字符索引（不含） */
  end: number;
}

/**
 * 将文本按可用宽度切分为视觉行（基于字符索引）
 * 同时定位光标所在行和行内字符索引
 */
function layoutText(
  text: string,
  cursorOffset: number,
  maxWidth: number,
): { lines: VisualLine[]; cursorRow: number; cursorColIdx: number } {
  if (maxWidth <= 0) {
    return { lines: [{ start: 0, end: text.length }], cursorRow: 0, cursorColIdx: cursorOffset };
  }

  const lines: VisualLine[] = [];
  let lineStart = 0;
  let lineWidth = 0;
  let cursorRow = 0;
  let cursorColIdx = 0;

  for (let i = 0; i < text.length; i++) {
    const charW = stringWidth(text[i]);

    if (lineWidth + charW > maxWidth) {
      // 当前行满了，断行
      lines.push({ start: lineStart, end: i });
      lineStart = i;
      lineWidth = charW;
    } else {
      lineWidth += charW;
    }

    // 光标定位：光标在字符 cursorOffset 之前
    // 当 i < cursorOffset 时，光标还没到
    if (i < cursorOffset) {
      cursorRow = lines.length; // 当前正在构建的行号
      cursorColIdx = i + 1 - lineStart; // 行内字符索引（光标在 i+1 处）
    }
  }

  // 最后一行
  lines.push({ start: lineStart, end: text.length });

  // 光标在文本末尾的情况
  if (cursorOffset >= text.length) {
    cursorRow = lines.length - 1;
    cursorColIdx = text.length - lines[cursorRow].start;
  }

  return { lines, cursorRow, cursorColIdx };
}

// ── 水平分隔线组件 ─────────────────────────────────────────────────

/** 只渲染上下水平线，不使用 Ink 的 borderStyle 避免左右边框与文本宽度冲突 */
function HorizontalRule({ color, width }: { color: string; width: number }) {
  return <Text color={color}>{"─".repeat(Math.max(0, width))}</Text>;
}

// ── 组件 ──────────────────────────────────────────────────────────

export function InputArea({ onSubmit, isLoading }: InputAreaProps) {
  const lastSubmittedRef = useRef<string>("");
  const log = getLogger();
  const prevLoadingRef = useRef(isLoading);
  const { stdout } = useStdout();
  const [state, dispatch] = useReducer(inputReducer, {
    value: "", cursorOffset: 0, history: [], historyIndex: -1, savedInput: "",
  });

  // ── Bracketed Paste ────────────────────────────────────────────────
  // KeypressContext 的 bufferPaste 中间件已将粘贴内容合并为 name='paste' 事件，
  // 这里只需要清理粘贴文本中的控制字符。

  /**
   * 清理粘贴文本：
   * - 换行（\r\n / \r / \n）→ 空格
   * - Tab → 空格
   * - 控制字符（\x00-\x1f 除已处理的 \t \r \n）→ 删除
   */
  const cleanPasteText = (raw: string): string =>
    raw
      .replace(/\r\n/g, "\n")
      .replace(/\r/g, "\n")
      .replace(/\n/g, " ")
      .replace(/\t/g, " ")
      // eslint-disable-next-line no-control-regex
      .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, "");

  useEffect(() => {
    if (prevLoadingRef.current !== isLoading) {
      log.debug("UI:INPUT", `isLoading 变化: ${prevLoadingRef.current} → ${isLoading}`);
      prevLoadingRef.current = isLoading;
    }
  }, [isLoading]);

  const handleSubmit = useCallback(() => {
    const trimmed = state.value.trim();
    if (!trimmed) return;

    if (trimmed === lastSubmittedRef.current) {
      log.warn("UI:INPUT", `重复内容被拦截: "${trimmed.slice(0, 50)}"`);
      return;
    }

    log.info("UI:INPUT", `提交输入: "${trimmed.slice(0, 100)}"${trimmed.length > 100 ? '...' : ''}`);
    lastSubmittedRef.current = trimmed;
    onSubmit(trimmed);
    dispatch({ type: "reset" });

    setTimeout(() => { lastSubmittedRef.current = ""; }, 1000);
  }, [state.value, onSubmit]);

  // ── 核心键盘处理（通过 KeypressContext 的 useKeypress） ──────────────
  // KeypressContext 直接读取 stdin 原始数据，解析为结构化 Key 事件。
  // 粘贴已由 bufferPaste 中间件合并为 name='paste' 事件。
  // 鼠标事件已由 nonKeyboardEventFilter 过滤，不会到达此处。
  useKeypress(KeypressPriority.Normal, (key) => {
    if (isLoading) return false;

    // ── 粘贴事件（由 bufferPaste 中间件合并） ──
    if (key.name === 'paste') {
      const cleaned = cleanPasteText(key.sequence);
      if (cleaned.length > 0) {
        log.debug("UI:INPUT", `粘贴: ${cleaned.length} 字符`);
        dispatch({ type: "insert", text: cleaned });
      }
      return true;
    }

    // ── 普通键盘输入 ──
    if (key.name === 'enter' && !key.shift) { handleSubmit(); return true; }
    if (key.name === 'up' && !key.shift) { dispatch({ type: "history-up" }); return true; }
    if (key.name === 'down' && !key.shift) { dispatch({ type: "history-down" }); return true; }
    if (key.name === 'left') { dispatch({ type: "move-left" }); return true; }
    if (key.name === 'right') { dispatch({ type: "move-right" }); return true; }
    if (key.name === 'backspace' || key.name === 'delete') { dispatch({ type: "delete" }); return true; }
    if (key.name === 'home') { dispatch({ type: "home" }); return true; }
    if (key.name === 'end') { dispatch({ type: "end" }); return true; }

    // Emacs 快捷键
    if (key.ctrl) {
      if (key.name === "a") { dispatch({ type: "home" }); return true; }
      if (key.name === "e") { dispatch({ type: "end" }); return true; }
      if (key.name === "k") { dispatch({ type: "kill-line" }); return true; }
      if (key.name === "u") { dispatch({ type: "kill-to-start" }); return true; }
    }

    // 可插入字符
    if (key.insertable && !key.ctrl && !key.alt && !key.cmd) {
      dispatch({ type: "insert", text: key.sequence });
      return true;
    }

    // Shift+Enter 插入换行（作为空格处理，单行输入）
    if (key.name === 'enter' && key.shift) {
      dispatch({ type: "insert", text: " " });
      return true;
    }

    return false;
  });

  const termWidth = stdout.columns || 80;

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

  // 可用宽度：终端宽度 - 左右 padding(2)，不再减去边框
  const availableWidth = Math.max(10, termWidth - 2);

  if (state.value.length === 0) {
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

  // 完整文本 = 提示符 + 输入内容
  const fullText = PROMPT + state.value;
  // 光标在完整文本中的字符索引
  const fullCursorIdx = PROMPT.length + state.cursorOffset;

  const { lines, cursorRow, cursorColIdx } = layoutText(fullText, fullCursorIdx, availableWidth);

  const renderedLines = lines.map((vl, lineIdx) => {
    const lineText = fullText.slice(vl.start, vl.end);

    if (lineIdx !== cursorRow) {
      // 非光标行
      if (lineIdx === 0) {
        return (
          <Text key={lineIdx}>
            <Text color={theme.ui.active} bold>{PROMPT}</Text>
            {lineText.slice(PROMPT.length)}
          </Text>
        );
      }
      return <Text key={lineIdx}>{lineText}</Text>;
    }

    // 光标行：在 cursorColIdx 处插入 inverse 字符
    const before = lineText.slice(0, cursorColIdx);
    const cursorChar = lineText[cursorColIdx] || " ";
    const after = cursorColIdx < lineText.length ? lineText.slice(cursorColIdx + 1) : "";

    if (lineIdx === 0) {
      return (
        <Text key={lineIdx}>
          <Text color={theme.ui.active} bold>{PROMPT}</Text>
          {before.slice(PROMPT.length)}
          <Text inverse>{cursorChar}</Text>
          {after}
        </Text>
      );
    }

    return (
      <Text key={lineIdx}>
        {before}
        <Text inverse>{cursorChar}</Text>
        {after}
      </Text>
    );
  });

  return (
    <Box flexDirection="column">
      <HorizontalRule color={theme.ui.active} width={termWidth} />
      <Box paddingX={1} flexDirection="column">
        {renderedLines}
      </Box>
      <HorizontalRule color={theme.ui.active} width={termWidth} />
    </Box>
  );
}
