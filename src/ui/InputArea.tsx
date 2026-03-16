/**
 * 输入区域组件
 * 使用 ink v6 的 useCursor() 控制终端真实光标位置，解决 IME 预编辑文本布局偏移问题。
 * 内联实现文本状态管理（useTextInputState 未从 @inkjs/ui 公开导出）。
 */

import React, { useReducer, useCallback, useRef, useEffect } from "react";
import { Box, Text, useInput, useCursor } from "ink";
import stringWidth from "string-width";
import { getLogger } from "../debug/logger.ts";

interface InputAreaProps {
  onSubmit: (text: string) => void;
  isLoading: boolean;
  /** 终端高度（用于计算光标 y 坐标） */
  termHeight: number;
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

export function InputArea({ onSubmit, isLoading, termHeight }: InputAreaProps) {
  const lastSubmittedRef = useRef<string>("");
  const log = getLogger();
  const prevLoadingRef = useRef(isLoading);
  const { setCursorPosition } = useCursor();
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

    // 防止重复提交相同内容
    if (trimmed === lastSubmittedRef.current) {
      log.warn("UI:INPUT", `重复内容被拦截: "${trimmed.slice(0, 50)}"`);
      return;
    }

    log.info("UI:INPUT", `提交输入: "${trimmed.slice(0, 100)}"${trimmed.length > 100 ? '...' : ''}`);
    lastSubmittedRef.current = trimmed;
    onSubmit(trimmed);
    dispatch({ type: "reset" });

    // 1秒后清除防重复标记
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
    // 普通字符输入（排除控制键组合）
    if (input && !key.ctrl && !key.meta) {
      dispatch({ type: "insert", text: input });
    }
  }, { isActive: !isLoading });

  // 设置终端真实光标位置
  // buildCursorSuffix: moveUp = visibleLineCount - y
  // ink 渲染后光标在最后一行末尾，moveUp=N 表示从那里往上 N 行
  // 布局（从下往上）：状态栏(1行, y=termHeight-1) + border底(1行) + 输入内容(1行)
  // 输入内容行需要 moveUp=2（跳过状态栏 + border 底线），所以 y = termHeight - 2
  if (!isLoading) {
    const prefixWidth = 1 + 1 + 2; // border(1) + padding(1) + "> "(2)
    const textBeforeCursor = state.value.slice(0, state.cursorOffset);
    const cursorX = prefixWidth + stringWidth(textBeforeCursor);
    const cursorY = termHeight - 2;
    setCursorPosition({ x: cursorX, y: cursorY });
  } else {
    setCursorPosition(undefined); // 加载中隐藏光标
  }

  if (isLoading) {
    return (
      <Box borderStyle="single" borderColor="gray" paddingX={1}>
        <Text dimColor>等待响应中...</Text>
      </Box>
    );
  }

  // 渲染输入文本（不用 chalk.inverse 模拟光标，终端真实光标由 useCursor 控制）
  const showPlaceholder = state.value.length === 0;

  return (
    <Box borderStyle="single" borderColor="cyan" paddingX={1}>
      <Text color="cyan" bold>{">"} </Text>
      <Box flexGrow={1}>
        {showPlaceholder ? (
          <Text dimColor>{PLACEHOLDER}</Text>
        ) : (
          <Text>{state.value}</Text>
        )}
      </Box>
    </Box>
  );
}
