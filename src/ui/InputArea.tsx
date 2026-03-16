/**
 * 输入区域组件
 * 使用可见光标字符（inverse 样式）标记光标位置，
 * 兼容非全屏模式（无需绝对坐标定位）。
 */

import React, { useReducer, useCallback, useRef, useEffect } from "react";
import { Box, Text, useInput } from "ink";
import { getLogger } from "../debug/logger.ts";

interface InputAreaProps {
  onSubmit: (text: string) => void;
  isLoading: boolean;
}

const PLACEHOLDER = "输入消息或 /help 查看命令...";

// ── 文本输入状态管理 ──────────────────────────────────────────────

interface InputState {
  value: string;
  cursorOffset: number;
}

type InputAction =
  | { type: "insert"; text: string }
  | { type: "delete" }
  | { type: "move-left" }
  | { type: "move-right" }
  | { type: "reset" };

function inputReducer(state: InputState, action: InputAction): InputState {
  switch (action.type) {
    case "insert":
      return {
        value: state.value.slice(0, state.cursorOffset) + action.text + state.value.slice(state.cursorOffset),
        cursorOffset: state.cursorOffset + action.text.length,
      };
    case "delete": {
      if (state.cursorOffset === 0) return state;
      const offset = state.cursorOffset - 1;
      return {
        value: state.value.slice(0, offset) + state.value.slice(offset + 1),
        cursorOffset: offset,
      };
    }
    case "move-left":
      return { ...state, cursorOffset: Math.max(0, state.cursorOffset - 1) };
    case "move-right":
      return { ...state, cursorOffset: Math.min(state.value.length, state.cursorOffset + 1) };
    case "reset":
      return { value: "", cursorOffset: 0 };
  }
}

// ── 组件 ──────────────────────────────────────────────────────────

export function InputArea({ onSubmit, isLoading }: InputAreaProps) {
  const lastSubmittedRef = useRef<string>("");
  const log = getLogger();
  const prevLoadingRef = useRef(isLoading);
  const [state, dispatch] = useReducer(inputReducer, { value: "", cursorOffset: 0 });

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
