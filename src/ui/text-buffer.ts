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
  /** Emacs kill ring：环形缓冲，最新在尾部，容量上限 KILL_RING_MAX */
  killRing: string[];
  /** yank-pop 游标：指向上次 yank 取用的 killRing 下标，-1 表示未处于 yank 序列 */
  killRingIndex: number;
  /** 仅在紧邻 yank 后为 true，允许 yank-pop（emacs 语义：yank-pop 只在 yank 序列内有效） */
  lastActionWasYank: boolean;
  /** 上次 yank/yank-pop 实际插入的文本，供 yank-pop 撤销上次插入用 */
  lastYankText: string;
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
/** kill ring 容量上限（对标 emacs 默认 kill-ring-max=60，这里取 32 够用） */
const KILL_RING_MAX = 32;

/** 把一段被删文本推入 kill ring（尾部为最新，超容量时丢弃最旧）。返回新数组。 */
function pushKill(ring: string[], text: string): string[] {
  if (!text) return ring;
  const next = [...ring, text];
  return next.length > KILL_RING_MAX ? next.slice(next.length - KILL_RING_MAX) : next;
}

// ── Reducer ──────────────────────────────────────────────────────

type Action =
  | { type: "insert"; text: string }
  | { type: "delete-backward" }
  | { type: "delete-forward" }
  | { type: "move"; direction: "left" | "right" | "up" | "down" | "home" | "end" | "wordLeft" | "wordRight" }
  | { type: "kill-line" }
  | { type: "kill-to-start" }
  | { type: "kill-word-before" }
  | { type: "yank" }
  | { type: "yank-pop" }
  | { type: "history-up" }
  | { type: "history-down" }
  | { type: "reset" }
  | { type: "set-text"; text: string }
  // ── Vim 动作（现有 action 无法表达的最小补充；移动/退格等复用现有 move/delete-*）──
  | { type: "vim-delete-line" }              // dd：删整逻辑行
  | { type: "vim-delete-to-line-end" }       // D / d$：删到行末
  | { type: "vim-open-line"; above: boolean } // o / O：下方(上方)开新行并把光标置于其上
  | { type: "vim-move-line-first-nonblank" }  // ^：移到行首第一个非空白字符
  // Vim 引擎原子写回：完整 vim 状态机在外部对 {lines,cursor} 求值后，用本 action 一次性
  // 写回结果（行数组 + 精确光标）。区别于 set-text（光标只能落末尾），vim 的 motion/operator
  // 需要把光标停在任意位置，故需要携带 row/col 的原子入口。
  | { type: "vim-set-buffer"; lines: string[]; cursorRow: number; cursorCol: number };

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

function baseReducer(state: TextBufferState, action: Action): TextBufferState {
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
      const line = state.lines[state.cursorRow];
      const killed = line.slice(state.cursorCol);
      const newLines = [...state.lines];
      newLines[state.cursorRow] = line.slice(0, state.cursorCol);
      return { ...state, lines: newLines, preferredCol: null, killRing: pushKill(state.killRing, killed) };
    }

    case "kill-to-start": {
      const line = state.lines[state.cursorRow];
      const killed = line.slice(0, state.cursorCol);
      const newLines = [...state.lines];
      newLines[state.cursorRow] = line.slice(state.cursorCol);
      return { ...state, lines: newLines, cursorCol: 0, preferredCol: null, killRing: pushKill(state.killRing, killed) };
    }

    case "kill-word-before": {
      // 删除光标前一个词（到前词边界），并入 kill ring。
      const line = state.lines[state.cursorRow];
      if (state.cursorCol > 0) {
        const boundary = findPrevWordBoundary(line, state.cursorCol);
        const killed = line.slice(boundary, state.cursorCol);
        const newLines = [...state.lines];
        newLines[state.cursorRow] = line.slice(0, boundary) + line.slice(state.cursorCol);
        return {
          ...state,
          lines: newLines,
          cursorCol: boundary,
          preferredCol: null,
          killRing: pushKill(state.killRing, killed),
        };
      }
      // 行首:合并到上一行(不入环,与 delete-backward 语义一致)
      if (state.cursorRow > 0) {
        const newLines = [...state.lines];
        const prevLen = newLines[state.cursorRow - 1].length;
        newLines[state.cursorRow - 1] += newLines[state.cursorRow];
        newLines.splice(state.cursorRow, 1);
        return { ...state, lines: newLines, cursorRow: state.cursorRow - 1, cursorCol: prevLen, preferredCol: null };
      }
      return state;
    }

    case "yank": {
      // 把 kill ring 最近一次弹到光标处;记录本次插入范围供 yank-pop 撤销。
      if (state.killRing.length === 0) return state;
      const lastIdx = state.killRing.length - 1;
      const text = state.killRing[lastIdx];
      const inserted = baseReducer(state, { type: "insert", text });
      return {
        ...inserted,
        killRing: state.killRing,       // insert 会清 historyIndex,但 killRing 需原样保留
        killRingIndex: lastIdx,
        lastActionWasYank: true,
        lastYankText: text,
      };
    }

    case "yank-pop": {
      // 仅在紧邻 yank 后有效:撤销上次 yank 插入的文本,改插 killRing 里更早的一条(回绕)。
      if (!state.lastActionWasYank || state.killRing.length === 0) return state;
      // 先撤销上次插入的 lastYankText(删除光标前 lastYankText.length 个字符)。
      const removeLen = state.lastYankText.length;
      let s: TextBufferState = state;
      for (let i = 0; i < removeLen; i++) {
        s = baseReducer(s, { type: "delete-backward" });
      }
      // 游标回退一格(回绕到末尾),取更早的一条。
      const nextIdx = (state.killRingIndex - 1 + state.killRing.length) % state.killRing.length;
      const text = state.killRing[nextIdx];
      const inserted = baseReducer(s, { type: "insert", text });
      return {
        ...inserted,
        killRing: state.killRing,
        killRingIndex: nextIdx,
        lastActionWasYank: true,
        lastYankText: text,
      };
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
        // kill ring 跨提交保留(emacs 语义:提交后仍可 yank 之前删的内容)
        killRing: state.killRing,
        killRingIndex: -1,
        lastActionWasYank: false,
        lastYankText: "",
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

    case "vim-delete-line": {
      // dd：删当前逻辑行。删后光标落在同下标行（末行则上移一行），列夹到行末。
      if (state.lines.length === 1) {
        return { ...state, lines: [""], cursorCol: 0, preferredCol: null };
      }
      const newLines = [...state.lines];
      newLines.splice(state.cursorRow, 1);
      const newRow = Math.min(state.cursorRow, newLines.length - 1);
      const newCol = Math.min(state.cursorCol, newLines[newRow].length);
      return { ...state, lines: newLines, cursorRow: newRow, cursorCol: newCol, preferredCol: null };
    }

    case "vim-delete-to-line-end": {
      // D / d$：从光标删到行末（保留光标位置，vim 语义光标停在删除后行末字符上）。
      const line = state.lines[state.cursorRow];
      const newLines = [...state.lines];
      newLines[state.cursorRow] = line.slice(0, state.cursorCol);
      return { ...state, lines: newLines, preferredCol: null };
    }

    case "vim-open-line": {
      // o / O：在下方(above=false)或上方(above=true)插入空行，光标移到新行行首（调用方切 insert 模式）。
      const insertAt = action.above ? state.cursorRow : state.cursorRow + 1;
      const newLines = [...state.lines];
      newLines.splice(insertAt, 0, "");
      return { ...state, lines: newLines, cursorRow: insertAt, cursorCol: 0, preferredCol: null };
    }

    case "vim-move-line-first-nonblank": {
      // ^：移到行首第一个非空白字符（全空白行则到行末）。
      const line = state.lines[state.cursorRow];
      let col = 0;
      while (col < line.length && /\s/.test(line[col])) col++;
      return { ...state, cursorCol: col, preferredCol: null };
    }

    case "vim-set-buffer": {
      // Vim 引擎原子写回：外部状态机已算好完整 {lines, cursor}，这里直接落地并夹紧越界。
      const lines = action.lines.length > 0 ? action.lines : [""];
      const row = Math.max(0, Math.min(action.cursorRow, lines.length - 1));
      const col = Math.max(0, Math.min(action.cursorCol, lines[row].length));
      return { ...state, lines, cursorRow: row, cursorCol: col, preferredCol: null };
    }
  }
}

/**
 * 顶层 reducer 包装：维护 emacs yank 序列语义。
 * yank / yank-pop 自己管理 lastActionWasYank；其它任何编辑动作执行后都把它清 false，
 * 使 yank-pop 只在紧邻 yank 后生效。reset 走 baseReducer 已显式重置，此处不覆盖。
 */
export type TextBufferAction = Action;

/** 构造一个空的 TextBufferState（供测试/外部初始化用）。 */
export function createInitialState(text = ""): TextBufferState {
  const lines = text ? textToLines(text) : [""];
  const lastRow = lines.length - 1;
  return {
    lines,
    cursorRow: lastRow,
    cursorCol: lines[lastRow].length,
    preferredCol: null,
    history: [],
    historyIndex: -1,
    savedInput: "",
    killRing: [],
    killRingIndex: -1,
    lastActionWasYank: false,
    lastYankText: "",
  };
}

export function textBufferReducer(state: TextBufferState, action: Action): TextBufferState {
  const next = baseReducer(state, action);
  if (action.type === "yank" || action.type === "yank-pop" || action.type === "reset") {
    return next;
  }
  if (next.lastActionWasYank) {
    return { ...next, lastActionWasYank: false };
  }
  return next;
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
  const [state, dispatch] = useReducer(textBufferReducer, {
    lines: [""],
    cursorRow: 0,
    cursorCol: 0,
    preferredCol: null,
    history: [],
    historyIndex: -1,
    savedInput: "",
    killRing: [],
    killRingIndex: -1,
    lastActionWasYank: false,
    lastYankText: "",
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

  const killWordBefore = useCallback(() => {
    dispatch({ type: "kill-word-before" });
  }, []);

  const yank = useCallback(() => {
    dispatch({ type: "yank" });
  }, []);

  const yankPop = useCallback(() => {
    dispatch({ type: "yank-pop" });
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

  // ── Vim 动作 dispatch 封装 ──
  const vimDeleteLine = useCallback(() => dispatch({ type: "vim-delete-line" }), []);
  const vimDeleteToLineEnd = useCallback(() => dispatch({ type: "vim-delete-to-line-end" }), []);
  const vimOpenLine = useCallback((above: boolean) => dispatch({ type: "vim-open-line", above }), []);
  const vimSetBuffer = useCallback(
    (lines: string[], cursorRow: number, cursorCol: number) =>
      dispatch({ type: "vim-set-buffer", lines, cursorRow, cursorCol }),
    [],
  );
  const vimMoveLineFirstNonBlank = useCallback(
    () => dispatch({ type: "vim-move-line-first-nonblank" }),
    [],
  );

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
    killWordBefore,
    yank,
    yankPop,
    historyUp,
    historyDown,
    submit,
    getText: getTextValue,
    isEmpty,
    setText,
    vimDeleteLine,
    vimDeleteToLineEnd,
    vimOpenLine,
    vimMoveLineFirstNonBlank,
    vimSetBuffer,
    visualLines,
    cursorVisual,
    scrollTop,
  };
}
