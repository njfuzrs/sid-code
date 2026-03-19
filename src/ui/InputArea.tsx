/**
 * 输入区域组件
 * 使用可见光标字符（inverse 样式）标记光标位置，
 * 支持历史记录（↑↓）和 Emacs 快捷键（Ctrl+A/E/U/K）。
 *
 * 多行文本处理：自行计算视觉行，不依赖 Ink 的自动换行（避免 Ink issue #883）
 *
 * 粘贴处理（Bracketed Paste Mode）：
 * 终端粘贴时用 ESC[200~ ... ESC[201~ 包裹内容。
 * Ink 的 inputParser 会把原始 stdin chunk 拆分为独立事件：
 *   1. ESC[200~ 作为一个事件（PASTE_START）
 *   2. 粘贴的文本内容作为若干事件（可能含 \r\n）
 *   3. ESC[201~ 作为一个事件（PASTE_END）
 * 这些事件通过 internal_eventEmitter → useInput 传递。
 * 因此我们在 useInput 回调中通过检查 raw sequence 来识别粘贴，
 * 不需要也不应该直接监听 process.stdin（会和 Ink 的 readable 竞争数据）。
 */

import React, { useReducer, useCallback, useRef, useEffect } from "react";
import { Box, Text, useInput, useStdout } from "ink";
import stringWidth from "string-width";
import { getLogger } from "../debug/logger.ts";

// ── Bracketed Paste Mode ────────────────────────────────────────────
const PASTE_START_SEQ = "\x1b[200~";
const PASTE_END_SEQ = "\x1b[201~";
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

  // ── Bracketed Paste ────────────────────────────────────────────────
  // 用 ref 让 useInput 回调能同步读取粘贴状态
  const isPastingRef = useRef(false);
  const pasteBufferRef = useRef<string>("");
  // 超时 timer 也用 ref 保存，方便清理
  const pasteTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  /** 清理粘贴状态 + timer */
  const finishPaste = useCallback((textToInsert: string) => {
    if (pasteTimerRef.current) {
      clearTimeout(pasteTimerRef.current);
      pasteTimerRef.current = null;
    }
    isPastingRef.current = false;
    pasteBufferRef.current = "";
    if (textToInsert.length > 0) {
      dispatch({ type: "insert", text: textToInsert });
    }
  }, []);

  /** 开始粘贴：设置状态 + 启动超时保护 */
  const startPaste = useCallback(() => {
    isPastingRef.current = true;
    pasteBufferRef.current = "";
    // 5 秒超时保护：如果终端异常导致 PASTE_END 永远不来
    pasteTimerRef.current = setTimeout(() => {
      if (isPastingRef.current) {
        log.warn("UI:INPUT", `粘贴超时（5s），强制插入: ${pasteBufferRef.current.length} 字符`);
        finishPaste(pasteBufferRef.current);
      }
    }, 5000);
  }, [finishPaste]);

  /** 把粘贴内容中的换行替换为空格 */
  const cleanPasteText = (raw: string): string =>
    raw.replace(/\r\n/g, "\n").replace(/\r/g, "\n").replace(/\n/g, " ");

  // 启用 / 禁用 Bracketed Paste Mode
  useEffect(() => {
    if (process.stdin.isTTY) {
      process.stdout.write(PASTE_ENABLE);
    }
    return () => {
      if (process.stdin.isTTY) {
        process.stdout.write(PASTE_DISABLE);
      }
      // 清理可能残留的 timer
      if (pasteTimerRef.current) {
        clearTimeout(pasteTimerRef.current);
      }
    };
  }, []);

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

  // ── 核心 useInput：同时处理普通键盘输入和粘贴序列 ──────────────
  // Ink 的 inputParser 把 stdin 原始 chunk 拆分为事件，经 parseKeypress 后
  // 以 (input, key) 传入此回调。粘贴序列的事件流：
  //   1. input="" key.sequence="\x1b[200~"  ← PASTE_START
  //   2. input="hello world\r\nline2"       ← 粘贴文本（可能多次）
  //   3. input="" key.sequence="\x1b[201~"  ← PASTE_END
  // 我们据此在 useInput 内部完成粘贴状态机，不需要额外 stdin 监听。
  useInput((input, key) => {
    // 获取原始 sequence（key 对象上有 Ink 保留的 raw/sequence 字段）
    const rawSeq: string = (key as any).sequence ?? (key as any).raw ?? input;

    // ── 粘贴开始 ──
    if (rawSeq === PASTE_START_SEQ) {
      startPaste();
      log.debug("UI:INPUT", "粘贴开始 (bracketed paste)");
      return;
    }

    // ── 粘贴结束 ──
    if (rawSeq === PASTE_END_SEQ) {
      if (isPastingRef.current) {
        log.debug("UI:INPUT", `粘贴完成: ${pasteBufferRef.current.length} 字符`);
        finishPaste(pasteBufferRef.current);
      }
      return;
    }

    // ── 粘贴中：累积文本 ──
    if (isPastingRef.current) {
      // rawSeq 可能包含文本 + 换行，全部累积（换行替换为空格）
      pasteBufferRef.current += cleanPasteText(rawSeq);
      return;
    }

    // ── 普通键盘输入 ──
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
