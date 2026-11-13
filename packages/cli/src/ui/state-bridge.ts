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
  isMonitorTask,
  onTaskChanged,
  offTaskChanged,
} from "@sid-code/core/task/index.ts";
import { peekScheduler } from "@sid-code/core/cron/scheduler.ts";

/**
 * 定时唤醒 → 面板行（`WK`，§5.7.3）。
 *
 * 唤醒**不在** task registry：它是调度器里的一条 `CronTask`（没有进程、没有 outputFile），
 * 所以只能从这里合进来。三条约束：
 *
 * 1. **只取 `schedule_wakeup` 的会话级一次性任务**（判据在 `listSessionWakeups()` 里）：
 *    `/loop` 与 `cron_create` 有各自的出口，进「等待态」面板会让人以为 agent 在等它们。
 * 2. **用 `peekScheduler()` 而不是 `getScheduler()`**：后者未初始化时会造一个 onFire 为空的
 *    兜底实例——面板刷新不该有「顺手创建了调度器」这种副作用。
 * 3. **status 用 `"waiting"`**，不是 `"running"`：唤醒没在干活，它在等。混进 running 会让
 *    标题的「N 运行中」虚高，也会让它去订阅 250ms 旋转动画（设计要求是静态 `○`）。
 */
function wakeupDisplayInfos(): TaskDisplayInfo[] {
  const wakeups = peekScheduler()?.listSessionWakeups() ?? [];
  return wakeups
    .filter((t) => typeof t.fireAt === "number")
    .map((t) => ({
      id: t.id,
      type: "wakeup",
      kind: "wakeup",
      status: "waiting",
      // 描述用 prompt 首行：面板一行放不下整段 prompt，完整内容在安排那一刻的工具卡片里。
      description: t.prompt.split("\n")[0]!.trim(),
      startTime: t.createdAt,
      durationMs: 0,
      dueAt: t.fireAt,
    }));
}

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
      if (isMonitorTask(t)) {
        // monitor 是真进程（走 registry），但呈现与 shell 不同：面板要的是
        // 「已收到几条事件 · 还剩多久」，不是耗时（§5.7.3）。
        info.kind = "monitor";
        info.command = t.command;
        info.eventCount = t.eventCount;
        info.deadlineAt = t.deadlineAt;
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
    // 定时唤醒不在 task registry，单独合成一行（`WK`，§5.7.3）。排在真实任务之后：
    // 面板排序（running → 唤醒 → 终态）由 TodoPanel 按 kind/status 重排，
    // 这里只保证「两路数据源都进来了」。
    this.update({ tasks: [...taskInfos, ...wakeupDisplayInfos()] });
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
    // /clear 清空 modelUsage（resetCounters），折算判据随之归零 —— 不置 false 的话
    // 新会话会沿用上一段的 `≈$` 前缀，而它已经没有任何 CNY 计价模型在记账了。
    costFxConverted: false,
    cacheSavingsUSD: 0,
    // 吞吐列在同一生命周期：/clear 清空 modelUsage 后 total_gen_elapsed_ms / 样本数一起归零，
    // 上游会重新推一个 undefined（`undefined` = 无样本，Footer 不渲染该列），这里先落到哨兵。
    outputTps: undefined,
    // D18：命中率与 token/cost 同一生命周期——/clear 清空 modelUsage 后必须一起归零，
    // 否则状态栏会继续显示上一会话的 ⚡N%（`undefined` = 无命中数据，Footer 不渲染该列）。
    cacheHitRate: undefined,
    // /clear 走 sessionState.resetCounters()（清空 modelUsage → requests 归零），
    // 这里同步把展示侧归零，保持「状态栏计量项与上下文一起清空」的既有约定。
    // 这也正是本列选 requests 而非 absoluteTurnCount 的理由之一：后者不被 resetCounters
    // 清零，会出现「token/cost 已归零、轮次还在数」的自相矛盾。
    totalRequests: 0,
    discardedRequests: 0,
    // 上下文三件的哨兵值（调用点会立即 merge contextDisplayState() 覆盖为
    // 「常驻开销估算」——/clear 只清消息历史，system prompt + 工具 schema 还在，
    // 状态栏应回落到初始占用而非隐藏；哨兵仅兜底未来新增的不 merge 调用点）。
    contextPercent: 0,
    // P1-2/P1-5：0 / "none" 表示"上游还没推送过"，Footer 会退回只显示 contextPercent
    contextTriggerPercent: 0,
    contextLevel: "none",
    // 估算标记哨兵：false = 校准值（/clear 不清 calibrationFactor，口径校准跨会话有效）
    contextEstimated: false,
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
