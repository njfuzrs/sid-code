/**
 * 输入区域组件
 * 使用可见光标字符（inverse 样式）标记光标位置，
 * 支持历史记录（↑↓）和 Emacs 快捷键（Ctrl+A/E/U/K）。
 *
 * 多行文本处理：自行计算视觉行，不依赖 Ink 的自动换行（避免 Ink issue #883）
 */

import React, { useReducer, useCallback, useRef, useEffect, useState } from "react";
import { Box, Text, useInput, useStdout } from "ink";
import stringWidth from "string-width";
import { getLogger } from "../debug/logger.ts";

// ── Bracketed Paste Mode ────────────────────────────────────────────
// 终端粘贴时用 ESC[200~ ... ESC[201~ 包裹内容
// 检测到该序列时，将换行符当作普通文本插入而非触发提交
const PASTE_START = "\x1b[200~";
const PASTE_END = "\x1b[201~";
const PASTE_ENABLE = "\x1b[?2004h";
const PASTE_DISABLE = "\x1b[?2004l";

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

  // Bracketed Paste 状态：缓冲区收集粘贴内容
  const pasteBufferRef = useRef<string>("");
  const [isPasting, setIsPasting] = useState(false);

  // 启用 / 禁用 Bracketed Paste Mode
  useEffect(() => {
    if (process.stdin.isTTY) {
      process.stdout.write(PASTE_ENABLE);
    }
    return () => {
      if (process.stdin.isTTY) {
        process.stdout.write(PASTE_DISABLE);
      }
    };
  }, []);

  // 监听 stdin 原始数据，检测 bracketed paste 序列
  useEffect(() => {
    if (isLoading) return;

    const onData = (data: Buffer) => {
      const str = data.toString();

      // 检测粘贴开始
      if (str.includes(PASTE_START)) {
        setIsPasting(true);
        // 提取 PASTE_START 之后的内容
        const afterStart = str.split(PASTE_START).slice(1).join(PASTE_START);
        // 可能同一个 data 里就包含结束标记
        if (afterStart.includes(PASTE_END)) {
          const content = afterStart.split(PASTE_END)[0];
          // 换行符替换为空格，粘贴内容作为单行插入
          const cleaned = content.replace(/\r\n/g, "\n").replace(/\r/g, "\n").replace(/\n/g, " ");
          log.debug("UI:INPUT", `粘贴完成（单次）: ${cleaned.length} 字符`);
          dispatch({ type: "insert", text: cleaned });
          pasteBufferRef.current = "";
          setIsPasting(false);
        } else {
          pasteBufferRef.current = afterStart.replace(/\r\n/g, "\n").replace(/\r/g, "\n").replace(/\n/g, " ");
        }
        return;
      }

      // 正在粘贴中
      if (isPasting) {
        if (str.includes(PASTE_END)) {
          const beforeEnd = str.split(PASTE_END)[0];
          const full = pasteBufferRef.current + beforeEnd.replace(/\r\n/g, "\n").replace(/\r/g, "\n").replace(/\n/g, " ");
          log.debug("UI:INPUT", `粘贴完成（多块）: ${full.length} 字符`);
          dispatch({ type: "insert", text: full });
          pasteBufferRef.current = "";
          setIsPasting(false);
        } else {
          pasteBufferRef.current += str.replace(/\r\n/g, "\n").replace(/\r/g, "\n").replace(/\n/g, " ");
        }
        return;
      }
    };

    // 使用 'data' 事件在 useInput 之前拦截原始输入
    process.stdin.on("data", onData);
    return () => {
      process.stdin.off("data", onData);
    };
  }, [isLoading, isPasting]);

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

  useInput((input, key) => {
    // 粘贴模式下跳过 useInput 处理，由 stdin data 事件处理
    if (isPasting) return;

    if (key.return) { handleSubmit(); return; }
    if (key.upArrow) { dispatch({ type: "history-up" }); return; }
    if (key.downArrow) { dispatch({ type: "history-down" }); return; }
    if (key.leftArrow) { dispatch({ type: "move-left" }); return; }
    if (key.rightArrow) { dispatch({ type: "move-right" }); return; }
    if (key.backspace || key.delete) { dispatch({ type: "delete" }); return; }
    if (key.ctrl) {
      if (input === "a") { dispatch({ type: "home" }); return; }
      if (input === "e") { dispatch({ type: "end" }); return; }
      if (input === "k") { dispatch({ type: "kill-line" }); return; }
      if (input === "u") { dispatch({ type: "kill-to-start" }); return; }
    }
    if (input && !key.ctrl && !key.meta) {
      dispatch({ type: "insert", text: input });
    }
  }, { isActive: !isLoading });

  const termWidth = stdout.columns || 80;

  if (isLoading) {
    return (
      <Box flexDirection="column">
        <HorizontalRule color="gray" width={termWidth} />
        <Box paddingX={1}>
          <Text dimColor>等待响应中...</Text>
        </Box>
        <HorizontalRule color="gray" width={termWidth} />
      </Box>
    );
  }

  // 可用宽度：终端宽度 - 左右 padding(2)，不再减去边框
  const availableWidth = Math.max(10, termWidth - 2);

  if (state.value.length === 0) {
    return (
      <Box flexDirection="column">
        <HorizontalRule color="cyan" width={termWidth} />
        <Box paddingX={1}>
          <Text>
            <Text color="cyan" bold>{PROMPT}</Text>
            <Text inverse> </Text>
            <Text dimColor>{PLACEHOLDER}</Text>
          </Text>
        </Box>
        <HorizontalRule color="cyan" width={termWidth} />
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
            <Text color="cyan" bold>{PROMPT}</Text>
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
          <Text color="cyan" bold>{PROMPT}</Text>
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
      <HorizontalRule color="cyan" width={termWidth} />
      <Box paddingX={1} flexDirection="column">
        {renderedLines}
      </Box>
      <HorizontalRule color="cyan" width={termWidth} />
    </Box>
  );
}
