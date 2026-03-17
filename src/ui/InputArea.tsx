/**
 * 输入区域组件
 * 使用可见光标字符（inverse 样式）标记光标位置，
 * 支持历史记录（↑↓）和 Emacs 快捷键（Ctrl+A/E/U/K）。
 */

import React, { useReducer, useCallback, useRef, useEffect } from "react";
import { Box, Text, useInput } from "ink";
import { getLogger } from "../debug/logger.ts";

interface InputAreaProps {
  onSubmit: (text: string) => void;
  isLoading: boolean;
}

const PLACEHOLDER = "输入消息或 /help 查看命令...";
const MAX_HISTORY = 100;

// ── 文本输入状态管理 ──────────────────────────────────────────────

interface InputState {
  value: string;
  cursorOffset: number;
  history: string[];
  historyIndex: number; // -1 表示当前输入，0+ 表示历史记录
  savedInput: string;   // 进入历史浏览前保存当前输入
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
      // Ctrl+K：删除光标到行尾
      return { ...state, value: state.value.slice(0, state.cursorOffset) };
    case "kill-to-start":
      // Ctrl+U：删除光标到行首
      return { ...state, value: state.value.slice(state.cursorOffset), cursorOffset: 0 };
    case "history-up": {
      if (state.history.length === 0) return state;
      const newIdx = state.historyIndex + 1;
      if (newIdx >= state.history.length) return state;
      // 首次进入历史浏览，保存当前输入
      const saved = state.historyIndex === -1 ? state.value : state.savedInput;
      const histValue = state.history[newIdx];
      return { ...state, value: histValue, cursorOffset: histValue.length, historyIndex: newIdx, savedInput: saved };
    }
    case "history-down": {
      if (state.historyIndex <= -1) return state;
      const newIdx = state.historyIndex - 1;
      if (newIdx === -1) {
        // 回到当前输入
        return { ...state, value: state.savedInput, cursorOffset: state.savedInput.length, historyIndex: -1 };
      }
      const histValue = state.history[newIdx];
      return { ...state, value: histValue, cursorOffset: histValue.length, historyIndex: newIdx };
    }
    case "reset": {
      // 提交时将当前值加入历史
      const newHistory = state.value.trim()
        ? [state.value.trim(), ...state.history].slice(0, MAX_HISTORY)
        : state.history;
      return { value: "", cursorOffset: 0, history: newHistory, historyIndex: -1, savedInput: "" };
    }
  }
}

// ── 组件 ──────────────────────────────────────────────────────────

export function InputArea({ onSubmit, isLoading }: InputAreaProps) {
  const lastSubmittedRef = useRef<string>("");
  const log = getLogger();
  const prevLoadingRef = useRef(isLoading);
  const [state, dispatch] = useReducer(inputReducer, {
    value: "", cursorOffset: 0, history: [], historyIndex: -1, savedInput: "",
  });

  // 记录 isLoading 状态变化
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

    setTimeout(() => {
      lastSubmittedRef.current = "";
    }, 1000);
  }, [state.value, onSubmit]);

  // 处理键盘输入
  useInput((input, key) => {
    if (key.return) {
      handleSubmit();
      return;
    }
    // ↑↓ 历史浏览
    if (key.upArrow) {
      dispatch({ type: "history-up" });
      return;
    }
    if (key.downArrow) {
      dispatch({ type: "history-down" });
      return;
    }
    if (key.leftArrow) {
      dispatch({ type: "move-left" });
      return;
    }
    if (key.rightArrow) {
      dispatch({ type: "move-right" });
      return;
    }
    if (key.backspace || key.delete) {
      dispatch({ type: "delete" });
      return;
    }
    // Emacs 快捷键
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

  if (isLoading) {
    return (
      <Box borderStyle="single" borderColor="gray" paddingX={1}>
        <Text dimColor>等待响应中...</Text>
      </Box>
    );
  }

  // 使用 inverse 样式渲染可见光标
  const showPlaceholder = state.value.length === 0;
  const before = state.value.slice(0, state.cursorOffset);
  const cursorChar = state.value[state.cursorOffset] || " ";
  const after = state.value.slice(state.cursorOffset + 1);

  return (
    <Box borderStyle="single" borderColor="cyan" paddingX={1}>
      <Text color="cyan" bold>{">"} </Text>
      <Box flexGrow={1}>
        {showPlaceholder ? (
          <>
            <Text inverse> </Text>
            <Text dimColor>{PLACEHOLDER}</Text>
          </>
        ) : (
          <>
            <Text>{before}</Text>
            <Text inverse>{cursorChar}</Text>
            <Text>{after}</Text>
          </>
        )}
      </Box>
    </Box>
  );
}
