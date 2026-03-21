/**
 * TextBuffer 抽象
 *
 * 将 InputArea 的 reducer 逻辑提取为独立的 hook，支持：
 * - lines[] + cursorRow/cursorCol 多行模型
 * - Visual 行映射（逻辑行按终端宽度折行）
 * - Viewport 滚动（文本超过 viewport 高度时自动滚动）
 * - Word navigation（Alt+Left/Right 按词移动）
 * - 历史记录（↑↓）
 * - Shift+Enter 插入真正的换行
 */

import { useReducer, useCallback, useMemo } from "react";
import stringWidth from "string-width";

// ── 类型定义 ──────────────────────────────────────────────────────

export interface TextBufferState {
  lines: string[];              // 逻辑行（\n 分割）
  cursorRow: number;            // 逻辑行号
  cursorCol: number;            // 行内列号（code point 索引）
  preferredCol: number | null;  // 上下移动时保持列位置
  history: string[];
  historyIndex: number;
  savedInput: string;
}

export interface Viewport {
  height: number;
  width: number;
}

/** 一个视觉行：来源逻辑行号 + 原始文本中的起止字符索引 */
export interface VisualLine {
  /** 来源逻辑行号 */
  logicalRow: number;
  /** 在逻辑行文本中的起始字符索引（含） */
  start: number;
  /** 在逻辑行文本中的结束字符索引（不含） */
  end: number;
  /** 逻辑行的完整文本 */
  text: string;
}

const MAX_HISTORY = 100;

// ── Reducer ──────────────────────────────────────────────────────

type Action =
  | { type: "insert"; text: string }
  | { type: "delete-backward" }
  | { type: "delete-forward" }
  | { type: "move"; direction: "left" | "right" | "up" | "down" | "home" | "end" | "wordLeft" | "wordRight" }
  | { type: "kill-line" }
  | { type: "kill-to-start" }
  | { type: "history-up" }
  | { type: "history-down" }
  | { type: "reset" }
  | { type: "set-text"; text: string };

/** 获取完整文本 */
function getText(state: TextBufferState): string {
  return state.lines.join("\n");
}

/** 从文本构建 lines */
function textToLines(text: string): string[] {
  const lines = text.split("\n");
  return lines.length === 0 ? [""] : lines;
}

/** 查找前一个词边界 */
function findPrevWordBoundary(line: string, col: number): number {
  if (col <= 0) return 0;
  let i = col - 1;
  // 跳过空白
  while (i > 0 && /\s/.test(line[i])) i--;
  // 跳过词字符
  while (i > 0 && !/\s/.test(line[i - 1])) i--;
  return i;
}

/** 查找下一个词边界 */
function findNextWordBoundary(line: string, col: number): number {
  const len = line.length;
  if (col >= len) return len;
  let i = col;
  // 跳过当前词字符
  while (i < len && !/\s/.test(line[i])) i++;
  // 跳过空白
  while (i < len && /\s/.test(line[i])) i++;
  return i;
}

function reducer(state: TextBufferState, action: Action): TextBufferState {
  switch (action.type) {
    case "insert": {
      const insertLines = action.text.split("\n");
      const currentLine = state.lines[state.cursorRow];
      const before = currentLine.slice(0, state.cursorCol);
      const after = currentLine.slice(state.cursorCol);

      if (insertLines.length === 1) {
        // 单行插入
        const newLines = [...state.lines];
        newLines[state.cursorRow] = before + insertLines[0] + after;
        return {
          ...state,
          lines: newLines,
          cursorCol: state.cursorCol + insertLines[0].length,
          preferredCol: null,
          historyIndex: -1,
        };
      }

      // 多行插入（含换行）
      const newLines = [...state.lines];
      const firstLine = before + insertLines[0];
      const lastLine = insertLines[insertLines.length - 1] + after;
      const middleLines = insertLines.slice(1, -1);
      newLines.splice(state.cursorRow, 1, firstLine, ...middleLines, lastLine);

      return {
        ...state,
        lines: newLines,
        cursorRow: state.cursorRow + insertLines.length - 1,
        cursorCol: insertLines[insertLines.length - 1].length,
        preferredCol: null,
        historyIndex: -1,
      };
    }

    case "delete-backward": {
      if (state.cursorCol > 0) {
        // 行内删除
        const line = state.lines[state.cursorRow];
        const newLines = [...state.lines];
        newLines[state.cursorRow] = line.slice(0, state.cursorCol - 1) + line.slice(state.cursorCol);
        return { ...state, lines: newLines, cursorCol: state.cursorCol - 1, preferredCol: null };
      }
      if (state.cursorRow > 0) {
        // 合并到上一行
        const newLines = [...state.lines];
        const prevLen = newLines[state.cursorRow - 1].length;
        newLines[state.cursorRow - 1] += newLines[state.cursorRow];
        newLines.splice(state.cursorRow, 1);
        return { ...state, lines: newLines, cursorRow: state.cursorRow - 1, cursorCol: prevLen, preferredCol: null };
      }
      return state;
    }

    case "delete-forward": {
      const line = state.lines[state.cursorRow];
      if (state.cursorCol < line.length) {
        const newLines = [...state.lines];
        newLines[state.cursorRow] = line.slice(0, state.cursorCol) + line.slice(state.cursorCol + 1);
        return { ...state, lines: newLines, preferredCol: null };
      }
      if (state.cursorRow < state.lines.length - 1) {
        // 合并下一行
        const newLines = [...state.lines];
        newLines[state.cursorRow] += newLines[state.cursorRow + 1];
        newLines.splice(state.cursorRow + 1, 1);
        return { ...state, lines: newLines, preferredCol: null };
      }
      return state;
    }

    case "move": {
      const { direction } = action;
      const line = state.lines[state.cursorRow];

      switch (direction) {
        case "left":
          if (state.cursorCol > 0) {
            return { ...state, cursorCol: state.cursorCol - 1, preferredCol: null };
          }
          if (state.cursorRow > 0) {
            return { ...state, cursorRow: state.cursorRow - 1, cursorCol: state.lines[state.cursorRow - 1].length, preferredCol: null };
          }
          return state;

        case "right":
          if (state.cursorCol < line.length) {
            return { ...state, cursorCol: state.cursorCol + 1, preferredCol: null };
          }
          if (state.cursorRow < state.lines.length - 1) {
            return { ...state, cursorRow: state.cursorRow + 1, cursorCol: 0, preferredCol: null };
          }
          return state;

        case "up": {
          if (state.cursorRow > 0) {
            const preferred = state.preferredCol ?? state.cursorCol;
            const prevLine = state.lines[state.cursorRow - 1];
            return {
              ...state,
              cursorRow: state.cursorRow - 1,
              cursorCol: Math.min(preferred, prevLine.length),
              preferredCol: preferred,
            };
          }
          return state;
        }

        case "down": {
          if (state.cursorRow < state.lines.length - 1) {
            const preferred = state.preferredCol ?? state.cursorCol;
            const nextLine = state.lines[state.cursorRow + 1];
            return {
              ...state,
              cursorRow: state.cursorRow + 1,
              cursorCol: Math.min(preferred, nextLine.length),
              preferredCol: preferred,
            };
          }
          return state;
        }

        case "home":
          return { ...state, cursorCol: 0, preferredCol: null };

        case "end":
          return { ...state, cursorCol: line.length, preferredCol: null };

        case "wordLeft": {
          if (state.cursorCol > 0) {
            return { ...state, cursorCol: findPrevWordBoundary(line, state.cursorCol), preferredCol: null };
          }
          // 跳到上一行末尾
          if (state.cursorRow > 0) {
            return { ...state, cursorRow: state.cursorRow - 1, cursorCol: state.lines[state.cursorRow - 1].length, preferredCol: null };
          }
          return state;
        }

        case "wordRight": {
          if (state.cursorCol < line.length) {
            return { ...state, cursorCol: findNextWordBoundary(line, state.cursorCol), preferredCol: null };
          }
          // 跳到下一行开头
          if (state.cursorRow < state.lines.length - 1) {
            return { ...state, cursorRow: state.cursorRow + 1, cursorCol: 0, preferredCol: null };
          }
          return state;
        }
      }
    }

    case "kill-line": {
      const newLines = [...state.lines];
      newLines[state.cursorRow] = state.lines[state.cursorRow].slice(0, state.cursorCol);
      return { ...state, lines: newLines, preferredCol: null };
    }

    case "kill-to-start": {
      const newLines = [...state.lines];
      newLines[state.cursorRow] = state.lines[state.cursorRow].slice(state.cursorCol);
      return { ...state, lines: newLines, cursorCol: 0, preferredCol: null };
    }

    case "history-up": {
      if (state.history.length === 0) return state;
      const newIdx = state.historyIndex + 1;
      if (newIdx >= state.history.length) return state;
      const saved = state.historyIndex === -1 ? getText(state) : state.savedInput;
      const histValue = state.history[newIdx];
      const histLines = textToLines(histValue);
      const lastRow = histLines.length - 1;
      return {
        ...state,
        lines: histLines,
        cursorRow: lastRow,
        cursorCol: histLines[lastRow].length,
        preferredCol: null,
        historyIndex: newIdx,
        savedInput: saved,
      };
    }

    case "history-down": {
      if (state.historyIndex <= -1) return state;
      const newIdx = state.historyIndex - 1;
      if (newIdx === -1) {
        const savedLines = textToLines(state.savedInput);
        const lastRow = savedLines.length - 1;
        return {
          ...state,
          lines: savedLines,
          cursorRow: lastRow,
          cursorCol: savedLines[lastRow].length,
          preferredCol: null,
          historyIndex: -1,
        };
      }
      const histValue = state.history[newIdx];
      const histLines = textToLines(histValue);
      const lastRow = histLines.length - 1;
      return {
        ...state,
        lines: histLines,
        cursorRow: lastRow,
        cursorCol: histLines[lastRow].length,
        preferredCol: null,
        historyIndex: newIdx,
      };
    }

    case "reset": {
      const text = getText(state).trim();
      const newHistory = text
        ? [text, ...state.history].slice(0, MAX_HISTORY)
        : state.history;
      return {
        lines: [""],
        cursorRow: 0,
        cursorCol: 0,
        preferredCol: null,
        history: newHistory,
        historyIndex: -1,
        savedInput: "",
      };
    }

    case "set-text": {
      const newLines = textToLines(action.text);
      const lastRow = newLines.length - 1;
      return {
        ...state,
        lines: newLines,
        cursorRow: lastRow,
        cursorCol: newLines[lastRow].length,
        preferredCol: null,
        historyIndex: -1,
      };
    }
  }
}

// ── Visual 行映射 ────────────────────────────────────────────────

/**
 * 将逻辑行按终端宽度折行为视觉行
 */
export function getVisualLines(lines: string[], width: number): VisualLine[] {
  if (width <= 0) {
    return lines.map((text, i) => ({ logicalRow: i, start: 0, end: text.length, text }));
  }

  const result: VisualLine[] = [];
  for (let row = 0; row < lines.length; row++) {
    const line = lines[row];
    if (line.length === 0) {
      result.push({ logicalRow: row, start: 0, end: 0, text: "" });
      continue;
    }

    let lineStart = 0;
    let lineWidth = 0;

    for (let i = 0; i < line.length; i++) {
      const charW = stringWidth(line[i]);
      if (lineWidth + charW > width) {
        result.push({ logicalRow: row, start: lineStart, end: i, text: line.slice(lineStart, i) });
        lineStart = i;
        lineWidth = charW;
      } else {
        lineWidth += charW;
      }
    }
    result.push({ logicalRow: row, start: lineStart, end: line.length, text: line.slice(lineStart) });
  }
  return result;
}

/**
 * 计算光标在视觉行中的位置
 */
export function getCursorVisualPosition(
  lines: string[],
  cursorRow: number,
  cursorCol: number,
  width: number,
): { visualRow: number; visualCol: number } {
  const visualLines = getVisualLines(lines, width);
  for (let i = 0; i < visualLines.length; i++) {
    const vl = visualLines[i];
    if (vl.logicalRow === cursorRow && cursorCol >= vl.start && cursorCol <= vl.end) {
      return { visualRow: i, visualCol: cursorCol - vl.start };
    }
  }
  // fallback：光标在最后
  return { visualRow: Math.max(0, visualLines.length - 1), visualCol: 0 };
}

// ── Hook ─────────────────────────────────────────────────────────

export interface UseTextBufferProps {
  viewport: Viewport;
  onChange?: (text: string) => void;
}

export function useTextBuffer(props: UseTextBufferProps) {
  const [state, dispatch] = useReducer(reducer, {
    lines: [""],
    cursorRow: 0,
    cursorCol: 0,
    preferredCol: null,
    history: [],
    historyIndex: -1,
    savedInput: "",
  });

  const insert = useCallback((text: string) => {
    dispatch({ type: "insert", text });
  }, []);

  const deleteBackward = useCallback(() => {
    dispatch({ type: "delete-backward" });
  }, []);

  const deleteForward = useCallback(() => {
    dispatch({ type: "delete-forward" });
  }, []);

  const moveCursor = useCallback((direction: "left" | "right" | "up" | "down" | "home" | "end" | "wordLeft" | "wordRight") => {
    dispatch({ type: "move", direction });
  }, []);

  const killLine = useCallback(() => {
    dispatch({ type: "kill-line" });
  }, []);

  const killToStart = useCallback(() => {
    dispatch({ type: "kill-to-start" });
  }, []);

  const historyUp = useCallback(() => {
    dispatch({ type: "history-up" });
  }, []);

  const historyDown = useCallback(() => {
    dispatch({ type: "history-down" });
  }, []);

  const submit = useCallback((): string | null => {
    const text = getText(state).trim();
    if (!text) return null;
    dispatch({ type: "reset" });
    return text;
  }, [state]);

  const getTextValue = useCallback((): string => {
    return getText(state);
  }, [state]);

  const isEmpty = useCallback((): boolean => {
    return state.lines.length === 1 && state.lines[0].length === 0;
  }, [state]);

  const setText = useCallback((text: string) => {
    dispatch({ type: "set-text", text });
  }, []);

  // Viewport 滚动
  const { height: vpHeight, width: vpWidth } = props.viewport;
  const visualLines = useMemo(
    () => getVisualLines(state.lines, vpWidth),
    [state.lines, vpWidth],
  );
  const cursorVisual = useMemo(
    () => getCursorVisualPosition(state.lines, state.cursorRow, state.cursorCol, vpWidth),
    [state.lines, state.cursorRow, state.cursorCol, vpWidth],
  );

  // 计算 scrollTop：确保光标可见
  const scrollTop = useMemo(() => {
    if (vpHeight <= 0 || visualLines.length <= vpHeight) return 0;
    // 光标在 viewport 之上
    const cursorVRow = cursorVisual.visualRow;
    // 简单策略：让光标在 viewport 中间偏下
    const idealTop = Math.max(0, cursorVRow - Math.floor(vpHeight / 2));
    return Math.min(idealTop, visualLines.length - vpHeight);
  }, [visualLines.length, vpHeight, cursorVisual.visualRow]);

  return {
    state,
    insert,
    deleteBackward,
    deleteForward,
    moveCursor,
    killLine,
    killToStart,
    historyUp,
    historyDown,
    submit,
    getText: getTextValue,
    isEmpty,
    setText,
    visualLines,
    cursorVisual,
    scrollTop,
  };
}
