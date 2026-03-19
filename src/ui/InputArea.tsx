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
 *   2. 粘贴的文本内容作为若干事件（可能含 \r\n、ANSI 颜色码等）
 *   3. ESC[201~ 作为一个事件（PASTE_END）
 *
 * 关键：Ink 的 use-input.js 会对 input 做两个变换：
 *   - 构造的 key 对象不含 sequence/raw 字段
 *   - 以 ESC 开头的 input 被 slice(1) 去掉前缀
 * 因此 PASTE_START/END 到达回调时 input 为 "[200~"/"[201~"。
 *
 * 粘贴内容中的 ANSI 颜色码（如 ESC[31m）会被 Ink 解析为独立的
 * ctrl 事件（input=""），我们在粘贴状态下跳过空 input 事件。
 *
 * 防御机制：
 *   - 5s 超时保护：PASTE_END 不来时强制插入已累积文本
 *   - 超时冷却期：500ms 内丢弃残留事件，避免被当作普通输入
 *   - 控制字符清理：Tab/\x00-\x1f 等控制字符被清理
 */

import React, { useReducer, useCallback, useRef, useEffect } from "react";
import { Box, Text, useInput, useStdout } from "ink";
import stringWidth from "string-width";
import { getLogger } from "../debug/logger.ts";

// ── Bracketed Paste Mode ────────────────────────────────────────────
const PASTE_START_SEQ = "\x1b[200~";
const PASTE_END_SEQ = "\x1b[201~";
// Ink 的 use-input.js 会对以 ESC 开头的 input 执行 input.slice(1)，
// 导致 useInput 回调收到的 input 是去掉 ESC 前缀的 "[200~" / "[201~"。
// 同时 use-input.js 构造的 key 对象不包含 sequence/raw 字段，
// 所以必须同时匹配去掉 ESC 后的序列。
const PASTE_START_STRIPPED = "[200~";
const PASTE_END_STRIPPED = "[201~";
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

  // 超时冷却期标记：超时 finishPaste 后，后续残留的粘贴文本和 PASTE_END 仍会到达，
  // 需要在短暂窗口内丢弃这些事件，避免它们被当作普通输入插入。
  const pasteCooldownRef = useRef(false);
  const pasteCooldownTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  /** 清理粘贴状态 + timer */
  const finishPaste = useCallback((textToInsert: string, isTimeout = false) => {
    if (pasteTimerRef.current) {
      clearTimeout(pasteTimerRef.current);
      pasteTimerRef.current = null;
    }
    isPastingRef.current = false;
    pasteBufferRef.current = "";

    // 漏洞6修复：超时触发时，进入冷却期丢弃残留事件
    if (isTimeout) {
      pasteCooldownRef.current = true;
      if (pasteCooldownTimerRef.current) clearTimeout(pasteCooldownTimerRef.current);
      // 500ms 冷却期足以让终端缓冲区中的残留事件全部到达
      pasteCooldownTimerRef.current = setTimeout(() => {
        pasteCooldownRef.current = false;
        pasteCooldownTimerRef.current = null;
      }, 500);
    }

    if (textToInsert.length > 0) {
      dispatch({ type: "insert", text: textToInsert });
    }
  }, []);

  /** 开始粘贴：设置状态 + 启动超时保护 */
  const startPaste = useCallback(() => {
    isPastingRef.current = true;
    pasteBufferRef.current = "";
    // 取消冷却期（新粘贴开始了）
    if (pasteCooldownTimerRef.current) {
      clearTimeout(pasteCooldownTimerRef.current);
      pasteCooldownTimerRef.current = null;
    }
    pasteCooldownRef.current = false;
    // 5 秒超时保护：如果终端异常导致 PASTE_END 永远不来
    pasteTimerRef.current = setTimeout(() => {
      if (isPastingRef.current) {
        log.warn("UI:INPUT", `粘贴超时（5s），强制插入: ${pasteBufferRef.current.length} 字符`);
        finishPaste(pasteBufferRef.current, true);
      }
    }, 5000);
  }, [finishPaste]);

  /**
   * 清理粘贴文本：
   * - 换行（\r\n / \r / \n）→ 空格
   * - Tab → 空格
   * - 控制字符（\x00-\x1f 除空格外已处理的 \t \r \n）→ 删除
   */
  const cleanPasteText = (raw: string): string =>
    raw
      .replace(/\r\n/g, "\n")
      .replace(/\r/g, "\n")
      .replace(/\n/g, " ")
      .replace(/\t/g, " ")
      // eslint-disable-next-line no-control-regex
      .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, "");

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
      if (pasteCooldownTimerRef.current) {
        clearTimeout(pasteCooldownTimerRef.current);
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
  // 以 (input, key) 传入此回调。
  //
  // 重要：Ink 的 use-input.js 有两个行为影响粘贴检测：
  //   1. 构造的 key 对象不包含 sequence/raw 字段（只有布尔标志）
  //   2. 对以 ESC 开头的 input 执行 input.slice(1)，去掉 ESC 前缀
  // 因此 PASTE_START "\x1b[200~" 到达回调时 input="[200~"，
  //       PASTE_END   "\x1b[201~" 到达回调时 input="[201~"。
  // 粘贴文本本身不以 ESC 开头，所以 input 保持完整。
  useInput((input, key) => {
    // ── 粘贴开始 ──
    // 匹配 Ink 去掉 ESC 后的 "[200~"，同时兼容原始序列（以防 Ink 版本变化）
    if (input === PASTE_START_STRIPPED || input === PASTE_START_SEQ) {
      startPaste();
      log.debug("UI:INPUT", "粘贴开始 (bracketed paste)");
      return;
    }

    // ── 粘贴结束 ──
    // 漏洞5修复：无论是否在粘贴状态，都拦截 PASTE_END，避免 [201~ 被当作普通输入插入。
    // 场景：超时 finishPaste 后 PASTE_END 姗姗来迟，或终端异常发送了孤立的 PASTE_END。
    if (input === PASTE_END_STRIPPED || input === PASTE_END_SEQ) {
      if (isPastingRef.current) {
        log.debug("UI:INPUT", `粘贴完成: ${pasteBufferRef.current.length} 字符`);
        finishPaste(pasteBufferRef.current);
      } else {
        // 非粘贴状态收到 PASTE_END，静默丢弃
        log.debug("UI:INPUT", "收到孤立的 PASTE_END，已丢弃");
      }
      // 收到正常的 PASTE_END 时，结束冷却期
      pasteCooldownRef.current = false;
      if (pasteCooldownTimerRef.current) {
        clearTimeout(pasteCooldownTimerRef.current);
        pasteCooldownTimerRef.current = null;
      }
      return;
    }

    // ── 漏洞6修复：冷却期内丢弃残留事件 ──
    // 超时 finishPaste 后，残留的粘贴文本事件仍会到达，
    // 在冷却期内全部丢弃，直到 PASTE_END 到达或冷却期结束。
    if (pasteCooldownRef.current) {
      return;
    }

    // ── 粘贴中：累积文本 ──
    if (isPastingRef.current) {
      // 漏洞4修复：跳过空 input（如 ANSI 颜色码产生的 ctrl 事件 input=""）
      if (input) {
        pasteBufferRef.current += cleanPasteText(input);
      }
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
