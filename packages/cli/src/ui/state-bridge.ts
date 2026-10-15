/**
 * 类型安全的状态桥接器
 * 用事件驱动替代 50ms 轮询，外部调用 update() 时立即触发 React 状态更新
 */

import { EventEmitter } from "events";
import type { TUIState, TaskDisplayInfo } from "./App.tsx";
import {
  getPanelVisibleTasks,
  isAgentTask,
  isShellTask,
  isWorkflowTask,
  onTaskChanged,
  offTaskChanged,
} from "@sid-code/core/task/index.ts";

/**
 * 流式合帧窗口。32ms ≈ 30fps：逐字输出肉眼看不出差别，而 flash 类模型
 * 150 tok/s 下每窗口约合并 5 个 token。取 16ms 只能合并约 2 个，收益减半。
 */
export const STREAM_FLUSH_MS = 32;

export class StateBridge extends EventEmitter {
  current: TUIState;
  /** 任务变更监听器引用（用于清理） */
  private _taskChangeHandler: (() => void) | null = null;

  constructor(initial: TUIState) {
    super();
    this.current = initial;

    // M5: 订阅任务变更事件，自动同步到 TUI 状态（事件驱动刷新）
    this._taskChangeHandler = () => this.updateTasks();
    onTaskChanged(this._taskChangeHandler);
  }

  /** 取消任务变更订阅 */
  detach(): void {
    if (this._taskChangeHandler) {
      offTaskChanged(this._taskChangeHandler);
      this._taskChangeHandler = null;
    }
    if (this._streamFlushTimer !== null) {
      clearTimeout(this._streamFlushTimer);
      this._streamFlushTimer = null;
    }
  }

  /** 流式合帧定时器；非 null = 有已合并进 current、但尚未 emit 的流式状态 */
  private _streamFlushTimer: ReturnType<typeof setTimeout> | null = null;

  /** 更新状态并触发事件（立即 emit；同时带出所有待发的流式状态） */
  update(patch: Partial<TUIState>): void {
    if (this._streamFlushTimer !== null) {
      clearTimeout(this._streamFlushTimer);
      this._streamFlushTimer = null;
    }
    this.current = { ...this.current, ...patch };
    this.emit("change", this.current);
  }

  /**
   * 流式 token 专用的合帧更新：current 同步合并，emit 合并到每 STREAM_FLUSH_MS 一次。
   *
   * 为什么需要：update() 每次 emit 都会 setState → 整棵 App 树 reconcile。流式回调
   * 一个 token 调一次，实测 3600 token 的一轮触发 3615 次 update（1:1），React
   * workLoopSync 占 profile 16.3s/57s。tui 底座的 16ms 节流只节流写屏，省不掉 reconcile。
   *
   * 三条不能改的约束：
   * - **current 必须同步合并**：app.ts 里大量代码同步读 `bridge.current`（retryStatus /
   *   displayItems 等），延后合并会让它们读到旧值。
   * - **任何 update() 都会先带出待发状态**（它 emit 的就是含流式字段的 current），
   *   所以流式结束、工具开始等状态切换不会被延后，也不会出现「先看到工具卡片、
   *   后补出最后几个 token」的乱序。
   * - **定时器是 leading-less 的固定窗口**，不是 debounce：持续流式时每个窗口必出一帧，
   *   不会因为 token 一直来就一直不刷。
   */
  updateStreaming(patch: Partial<TUIState>): void {
    this.current = { ...this.current, ...patch };
    if (this._streamFlushTimer !== null) return;
    this._streamFlushTimer = setTimeout(() => {
      this._streamFlushTimer = null;
      this.emit("change", this.current);
    }, STREAM_FLUSH_MS);
    // 不因合帧定时器阻止进程退出
    this._streamFlushTimer.unref?.();
  }

  /** 从 Task 注册表拉取最新任务列表并更新 TUI 状态。
   *
   *  经 isPanelVisible 过滤（见 task/types.ts）＝ 两段：
   *  ① `isPanelTask`（后台任务闸门）：前台子代理已由 tool_result 渲染成
   *     `⏺ sub_agent explore` 工具卡片，不能再上后台任务面板（否则同一子代理渲染两遍）。
   *     这里是**渲染端兜底**——源头 sub-agent.ts 已标 isBackgrounded=false，但将来若新增
   *     一条子代理注册路径又忘记标，这层过滤仍然拦得住。
   *  ② `!dismissed`（用户手动划掉）：Ctrl+X 划掉的终态条目立即从面板消失，
   *     不必等驱逐缓冲期——这是"面板不立即消失"的手动出口。任务本体仍在 registry，
   *     `bg_task_list` / `task_output` 照常查得到。 */
  updateTasks(): void {
    const all = getPanelVisibleTasks();
    const taskInfos: TaskDisplayInfo[] = all.map((t) => {
      const info: TaskDisplayInfo = {
        id: t.id,
        type: t.type,
        status: t.status,
        description: t.description,
        startTime: t.startTime,
        endTime: t.endTime,
        durationMs: (t.endTime ?? Date.now()) - t.startTime,
      };
      if (isAgentTask(t)) {
        info.agentType = t.agentType;
        if (t.progress) {
          info.progress = {
            toolUseCount: t.progress.toolUseCount,
            tokenCount: t.progress.tokenCount,
          };
          if (t.progress.lastActivity?.activityDescription) {
            info.lastActivity = t.progress.lastActivity.activityDescription;
          }
        }
        if (t.progressSummary) {
          info.progressSummary = t.progressSummary;
        }
        // 子代理 verbose 详情（Ctrl+O expandLevel≥1 展开）：透传最近工具活动序列。
        if (t.progress?.recentActivities?.length) {
          info.recentActivities = t.progress.recentActivities
            .map((a) => a.activityDescription || a.toolName)
            .filter((s): s is string => !!s);
        }
      }
      if (isShellTask(t)) {
        info.command = t.command;
      }
      if (isWorkflowTask(t)) {
        // workflow 任务:用 agentType 槽位展示 workflow 名,进度展示 agent 调用数 + 当前 phase
        info.agentType = `workflow:${t.workflowName}`;
        info.progress = {
          toolUseCount: t.agentCount ?? 0,
          tokenCount: t.progress?.tokenCount ?? 0,
        };
        if (t.currentPhase) {
          info.lastActivity = `phase: ${t.currentPhase}`;
        }
      }
      return info;
    });
    this.update({ tasks: taskInfos });
  }
}

/** /clear 后用于恢复空白会话视图的状态补丁 */
export function getConversationClearedPatch(): Partial<TUIState> {
  return {
    messages: [],
    displayItems: [],
    historyItems: [],
    toolName: null,
    toolInput: null,
    isToolExecuting: false,
    usage: { inputTokens: 0, outputTokens: 0 },
    stockInputTokens: 0,
    costUSD: 0,
    cacheSavingsUSD: 0,
    // /clear 走 sessionState.resetCounters()（清空 modelUsage → requests 归零），
    // 这里同步把展示侧归零，保持「状态栏计量项与上下文一起清空」的既有约定。
    // 这也正是本列选 requests 而非 absoluteTurnCount 的理由之一：后者不被 resetCounters
    // 清零，会出现「token/cost 已归零、轮次还在数」的自相矛盾。
    totalRequests: 0,
    discardedRequests: 0,
    contextPercent: 0,
    // P1-2/P1-5：0 / "none" 表示"上游还没推送过"，Footer 会退回只显示 contextPercent
    contextTriggerPercent: 0,
    contextLevel: "none",
    statusMessage: "",
    lastToolResult: null,
    streamingText: "",
    streamingThinking: "",
    isStreaming: false,
    streamingLine: "",
    permissionRequest: null,
    shellConfirmRequest: null,
    // P1-2：对照完整 TUIState 补齐遗漏字段——否则 /clear 时若有待审批计划，
    // 审批框不消失（planApprovalRequest 最该修）；加载态/Copy 模式/plan 模式标志亦可能残留。
    planApprovalRequest: null,
    askUserQuestionRequest: null,
    conflictRequest: null,
    isLoading: false,
    copyModeEnabled: false,
    isPlanMode: false,
    // /clear 后本轮输出基线归零——否则 Composer 用旧 turnStartOutputTokens 作差，
    // 清空会话后首条消息的"本轮输出 token"会算出负数或虚高（App.tsx:160 字段，Composer.tsx:177 作差）。
    turnStartOutputTokens: 0,
    activeDialog: null,
    // /clear 后 goal 状态栏列归零：否则旧 /goal 目标进度残留
    goalDisplay: null,
    // /clear 后流式思考时间戳归零：否则下次思考计时起点漂移
    streamingThinkingStartMs: undefined,
    // /clear 后滚动位置重置：回到底部
    scrollPercent: undefined,
    // /clear 后会话标题重置：新对话不应沿用旧标题
    sessionTitle: null,
    todos: [],
    tasks: [],
    retryStatus: null,
    errorPanel: [],
  };
}
