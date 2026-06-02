/**
 * 子代理状态隔离
 * 核心原则：默认隔离一切，调用者显式 opt-in 共享
 */

import type { AppState } from "./app-state.ts";
import type { Store } from "./store.ts";
import { createChildAbortController } from "../utils/abort-controller.ts";

/** 子代理上下文选项 */
export interface SubagentContextOptions {
  /** 是否共享父代理的 setAppState（同步子代理共享，异步子代理不共享） */
  shareSetAppState?: boolean;
  /** 是否共享父代理的 AbortController */
  shareAbortController?: boolean;
}

/** 子代理上下文 */
export interface SubagentContext {
  /** 读取 AppState */
  getAppState: () => AppState;
  /** 修改 AppState（异步子代理默认为 no-op） */
  setAppState: (updater: (prev: AppState) => AppState) => void;
  /** 始终连接到根 Store 的 setState，用于注册/清理后台任务 */
  setAppStateForTasks: (updater: (prev: AppState) => AppState) => void;
  /** 子代理的 AbortController */
  abortController: AbortController;
}

/**
 * 创建子代理上下文
 *
 * - setAppState：异步子代理默认 no-op，同步子代理可 opt-in 共享
 * - setAppStateForTasks：始终连接到根 Store（无论嵌套多深）
 * - abortController：新建，父 abort 单向传播到子
 */
export function createSubagentContext(
  rootStore: Store<AppState>,
  parentAbortSignal?: AbortSignal,
  options: SubagentContextOptions = {},
): SubagentContext {
  const { shareSetAppState = false, shareAbortController = false } = options;

  // 用 createChildAbortController 替代手写监听器：
  // 同样实现父 → 子单向传播，但子完成/取消时自动清理父上的监听器，
  // 防止长生命周期的父（主会话）累积死监听器导致内存泄漏。
  const abortController =
    parentAbortSignal && !shareAbortController
      ? createChildAbortController(parentAbortSignal).controller
      : new AbortController();

  const getAppState = () => rootStore.getState();

  const setAppState = shareSetAppState
    ? rootStore.setState
    : (_updater: (prev: AppState) => AppState) => { /* no-op for async subagents */ };

  const setAppStateForTasks = rootStore.setState;

  return {
    getAppState,
    setAppState,
    setAppStateForTasks,
    abortController,
  };
}
