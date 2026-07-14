/**
 * 主 TUI 组件（支持双模式渲染）
 *
 * 模式 1（默认）：Alternate Screen Buffer + ScrollableList 虚拟化滚动
 * 模式 2（--no-alternate-buffer）：Static 历史 + 动态 pending（屏幕阅读器友好）
 *
 * 布局：
 * - 消息区域（上方）：MainContent 双模式渲染
 * - 底部固定区域：工具状态 / 对话框或输入框 / 状态栏
 */

import React, { useState, useCallback, useEffect, useRef, useMemo } from "react";
import useApp from "../ink/hooks/use-app.js";
import { KeypressProvider, useKeypress, KeypressPriority, type Key } from "./contexts/KeypressContext.tsx";
import { KeybindingProvider, useKeybindings } from "./contexts/KeybindingContext.tsx";
import { AccessibilityProvider } from "./accessibility/AccessibilityContext.tsx";
import { ScrollProvider, useScrollState } from "./contexts/ScrollProvider.tsx";
import { TerminalProvider, useTerminalDimensions } from "./contexts/TerminalContext.tsx";
import { MouseProvider, enableMouseEvents, disableMouseEvents } from "./contexts/MouseContext.tsx";
import { OverflowProvider } from "./contexts/OverflowContext.tsx";
import { UIStateProvider, useUIActions, useUIState } from "./contexts/UIStateContext.tsx";
import { StreamingProvider } from "./contexts/StreamingContext.tsx";
import { ConfigProvider, type ConfigContextValue } from "./contexts/ConfigContext.tsx";
import { SessionProvider, type SessionContextValue } from "./contexts/SessionContext.tsx";
import { SettingsProvider } from "./contexts/SettingsContext.tsx";
import { AlternateBufferQuittingDisplay } from "./components/AlternateBufferQuittingDisplay.tsx";
import { DefaultAppLayout } from "./components/DefaultAppLayout.tsx";
import { MainScreenLayout } from "./components/MainScreenLayout.tsx";
import type { StartupWarning } from "./components/Notifications.tsx";
import type { StateBridge } from "./state-bridge.ts";
import type { Message, Usage } from "../llm/types.ts";
import type { HistoryItem } from "./types.ts";
import { StreamingState } from "./types.ts";
import { deriveStreamingState } from "./derive-streaming-state.ts";
import { useTerminalIntegration } from "./hooks/useTerminalIntegration.ts";
import { useMessageQueue } from "./hooks/useMessageQueue.ts";
import { useExitConfirm } from "./hooks/useExitConfirm.ts";
import { messagesToHistoryItems, isPlaceholderMessage, isHiddenFromDisplay, buildStaticItems, splitLiveToolItems, capLiveToolItems } from "./history-adapter.ts";
import { getLogger } from "../debug/logger.ts";
import { DEFAULT_TERM_WIDTH } from "./markdown.ts";

// ── 向后兼容导出（供 app.ts 过渡期使用） ──

/** @deprecated 使用 HistoryItem 替代 */
export type DisplayItem =
  | { kind: "message"; message: Message }
  | { kind: "system"; text: string }
  | { kind: "command"; input: string; output: string | null };

/** @deprecated 使用 messagesToHistoryItems 替代 */
export function messagesToDisplayItems(msgs: Message[]): DisplayItem[] {
  return msgs
    .filter(m => !isHiddenFromDisplay(m))
    .map(m => ({ kind: "message" as const, message: m }));
}

// 重新导出供外部使用
export { isPlaceholderMessage, messagesToHistoryItems };

/** TUI 回调接口 */
export interface TUICallbacks {
  onUserInput: (text: string, opts?: { displayCommand?: string }) => Promise<void>;
  onSlashCommand: (cmd: string, args: string) => Promise<void>;
  onInterrupt: () => void;
  /** 首次启动引导完成：写 settings.json + 热加载 Provider（见 app.ts） */
  onCompleteOnboarding?: (result: import("./components/OnboardingDialog.tsx").OnboardingResult) => void;
  /** MCP 管理器引用（/mcp 交互面板用；稳定引用，非响应式状态） */
  mcpManager?: import("../mcp/manager.ts").MCPManager;
  /** 会话状态引用（/mcp 面板启用/禁用用；稳定引用） */
  sessionState?: import("../session/state.ts").SessionState;
  /** 推理强度旋钮 setter（/effort 面板用） */
  setEffort?: (level: import("../llm/effort.ts").EffortSetting, persist?: boolean) => void;
  /** 思考开关旋钮 setter（/think 面板用） */
  setThinking?: (setting: import("../llm/effort.ts").ThinkingSetting, persist?: boolean) => void;
  /** 读取当前 effort 运行时态 + 能力（/effort 面板展示用） */
  getEffortState?: () => {
    runtime: import("../llm/effort.ts").EffortSetting;
    applied: import("../llm/effort.ts").EffortLevel | undefined;
    isAuto: boolean;
    capability: import("../llm/effort.ts").EffortCapability;
  };
  /** 读取当前 thinking 运行时态 + 能力（/think 面板展示用） */
  getThinkingState?: () => {
    runtime: import("../llm/effort.ts").ThinkingSetting;
    applied: boolean;
    capability: import("../llm/effort.ts").EffortCapability;
  };
  /** Hook 系统引用（/hooks 面板用；稳定引用） */
  hookSystem?: import("../hook/system.ts").HookSystem;
  /** 应用配置引用（/config 面板用；稳定引用） */
  config?: import("../config/config.ts").Config;
  /** 统一命令注册表引用（/commands、/help 面板用；稳定引用） */
  unifiedRegistry?: import("../command/unified-registry.ts").UnifiedCommandRegistry;
  /** Shift+Tab 权限模式循环切换（切 config.permissionMode + 刷状态栏 + 瞬时提示） */
  onCyclePermissionMode?: () => void;
  /** /export 面板选择后执行导出 */
  onExportConversation?: (target: "clipboard" | "file", format: "md" | "json" | "both") => void;
}

/** 权限请求信息 */
export interface PermissionRequestInfo {
  toolName: string;
  toolInput: unknown;
  description: string;
  resolve: (answer: "yes" | "no" | "always") => void;
  /**
   * 与该工具相关的不可达规则（对标 cc Unreachable Rules）。
   * 每条含被阴影规则、覆盖它的规则、严重度(blocked/shadowed)。可选——无阴影时省略。
   */
  shadowedRules?: ShadowedRuleInfo[];
}

/** 传给 UI 的阴影规则展示信息（从 permission 层投影，避免 UI 直接依赖权限内部类型） */
export interface ShadowedRuleInfo {
  /** 被阴影的规则字符串，如 "Bash(ls:*)" */
  rule: string;
  /** 覆盖它的规则来源，如 "projectSettings" */
  bySource: string;
  /** 覆盖它的规则行为 */
  byBehavior: "allow" | "deny" | "ask";
  /** blocked=被 deny 完全拦截；shadowed=被 ask 遮蔽仍弹窗 */
  severity: "blocked" | "shadowed";
}

/** Shell 命令确认请求信息 */
export interface ShellConfirmRequestInfo {
  commands: string[];
  resolve: (confirmed: boolean) => void;
}

/** Plan Mode 审批请求信息 */
export interface PlanApprovalRequestInfo {
  planFilePath: string;
  planContent: string;
  resolve: (decision: "approve" | "reject") => void;
}

/** AskUserQuestion 单题（投影给 UI 的展示结构，不直接依赖工具层类型） */
export interface AskQuestionInfo {
  question: string;
  header: string;
  options: Array<{ label: string; description?: string; preview?: string }>;
  multiSelect?: boolean;
}

/**
 * AskUserQuestion 交互请求信息（对标 cc AskUserQuestionPermissionRequest）。
 * 模型用 ask_user_question 工具发起结构化提问，TUI 弹出多题多选对话框收集答案。
 */
export interface AskUserQuestionRequestInfo {
  questions: AskQuestionInfo[];
  /**
   * 用户作答完成后回灌：answers 按"问题文本 → 答案"映射（多选以 ", " 连接）。
   * notes（可选）按"问题文本 → 备注"映射，仅当用户补了自由备注时存在。
   * decision="cancelled" 表示用户 ESC 放弃，此时 answers/notes 省略。
   */
  resolve: (
    result:
      | { decision: "answered"; answers: Record<string, string>; notes?: Record<string, string> }
      | { decision: "cancelled" },
  ) => void;
}

/** 统一错误面板条目 */
export interface ErrorPanelItem {
  /** 去重键（同 id 替换旧的） */
  id: string;
  /** 错误分类码（映射 error-messages.ts 文案表） */
  code?: string;
  /** 简短错误标题 */
  title: string;
  /** 详细信息（可折叠展示） */
  detail?: string;
  /** 建议解决方案 */
  suggestion: string;
  /** 出现时间戳 */
  timestamp: number;
}

/** TUI 状态（由外部 App 驱动） */
export interface TUIState {
  messages: Message[];
  /** @deprecated 使用 historyItems 替代 */
  displayItems: DisplayItem[];
  /** HistoryItem 渲染数据（新类型系统） */
  historyItems: HistoryItem[];
  isLoading: boolean;
  toolName: string | null;
  toolInput: unknown;
  isToolExecuting: boolean;
  model: string;
  provider: string;
  usage: Usage;
  /** 末次输入 token（stock 口径），用于状态栏展示当前上下文大小。避免与 usage.inputTokens（flow 累计）混淆。 */
  stockInputTokens: number;
  costUSD: number;
  /** 10.3：会话累计缓存节省金额（美元） */
  cacheSavingsUSD: number;
  costLimit: number;
  contextPercent: number;
  permissionMode: string;
  /** 是否处于计划模式（用于 TUI 状态标签显示） */
  isPlanMode: boolean;
  gitBranch: string;
  /**
   * 推理强度展示态（状态栏 effort 列）。null = 当前模型不支持档位切换（不显示该列）。
   * level = 解析后的展示档位；isAuto = 是否 auto 态（未显式设档，跟随模型默认）。
   * 由 App.setEffortRuntime / setModel 经 tuiStateUpdater 推送，派生到 ConfigContext。
   */
  effortDisplay: { level: import("../llm/effort.ts").EffortLevel; isAuto: boolean } | null;
  /**
   * 思考开关展示态（状态栏 thinking 列）。null = 当前模型不支持思考开关（不显示该列）。
   * on = 实际是否开启；isAuto = 是否 auto 态（跟随 provider 默认）。
   */
  thinkingDisplay: { on: boolean; isAuto: boolean } | null;
  /** /goal：目标状态展示态（状态栏 goal 列）。null = 无活跃目标 */
  goalDisplay: { turnsUsed: number; maxTurns: number; status: string } | null;
  statusMessage: string;
  permissionRequest: PermissionRequestInfo | null;
  shellConfirmRequest: ShellConfirmRequestInfo | null;
  planApprovalRequest: PlanApprovalRequestInfo | null;
  askUserQuestionRequest: AskUserQuestionRequestInfo | null;
  debug: boolean;
  lastToolResult: { toolName: string; isError: boolean; elapsedMs: number } | null;
  /** 流式输出的完整文本 */
  streamingText: string;
  /** 新增：流式思考内容（独立于 streamingText，对标 Claude Code） */
  streamingThinking: string;
  /** 流式思考开始时间戳（ms）。首个 thinking token 到达时记录，用于计时器起点对齐。
   *  undefined = 尚未开始思考或已清零 */
  streamingThinkingStartMs?: number;
  /** 是否正在流式输出 */
  isStreaming: boolean;
  /** 兼容旧接口：流式输出的未完成行预览 */
  streamingLine: string;
  /** 滚动百分比（0-100），100 表示在底部 */
  scrollPercent?: number;
  /** 是否正在退出（切换到退出回显模式） */
  isQuitting: boolean;
  /** Copy Mode：禁用鼠标事件，允许终端原生文本选择 */
  copyModeEnabled: boolean;
  /** 所有已注册命令（补全用） */
  commands: Array<{ name: string; aliases: string[]; description: string; requiresArgs?: boolean }>;
  /** 当前工作目录（@ 文件补全用） */
  cwd: string;
  /**
   * 会话任务名（终端标题用）。首条用户消息提交时由本地启发式即时填入,
   * 之后后台小模型(Haiku)生成更凝练的标题覆盖。null = 尚无会话,标题回退到 cwd 末段。
   */
  sessionTitle?: string | null;
  /**
   * 本轮回合开始时的会话累计 outputTokens 起点。
   * 底部 spinner 显示「本轮新增」= usage.outputTokens − 此值,与 Footer 的「会话总账」区分开。
   * 每个用户回合开始时刷新。
   */
  turnStartOutputTokens?: number;
  /** 当前打开的对话框类型，null 表示无对话框 */
  activeDialog: import("../command/types.ts").DialogType | null;
  /** 可用模型列表（对话框用） */
  availableModels: Array<{ name: string; provider: string; description?: string }>;
  /** 当前 todo 列表（来自 TodoWrite 工具，供 TUI 面板显示） */
  todos: import("../tool/todo-write.ts").TodoItem[];
  /** 当前后台任务列表（Shell/Agent，供 TUI 面板实时显示） */
  tasks: TaskDisplayInfo[];
  /** CM3/CM4：LLM 重试/限流状态（null = 无重试）。 */
  retryStatus: RetryStatusInfo | null;
  /** 统一错误面板：常驻底部直到用户手动关闭（Ctrl+E） */
  errorPanel: ErrorPanelItem[];
  /**
   * 首次启动引导标记：为 true 时 EmptyLogo 显示配置引导、自动弹出 OnboardingDialog。
   * 用户完成配置（onCompleteOnboarding）后置 false。
   */
  needsOnboarding?: boolean;
  /**
   * 配置校验诊断（见 config._validationDiagnostics）转换成的启动横幅列表。
   * App 构造时算好的一次性初始值，不随会话更新；由 Notifications 组件渲染、
   * 按任意键关闭。needsOnboarding 为真时为空数组（避免和引导对话框重复提示）。
   */
  startupWarnings?: StartupWarning[];
}

/** CM3/CM4：LLM 重试/限流状态信息（驱动 RetryStatus 组件实时倒计时）。 */
export interface RetryStatusInfo {
  /** 事件类型：retry 通用重试 / rate_limit 限流 / overloaded 过载 / fallback 降级。 */
  kind: "retry" | "rate_limit" | "overloaded" | "fallback";
  /** 当前尝试次数（1-based）。 */
  attempt: number;
  /** 退避延迟（毫秒），用于倒计时。 */
  delayMs: number;
  /** 重试预计开始的绝对时间戳（Date.now() + delayMs），组件据此实时倒计时。 */
  retryAtMs: number;
  /** 模型名。 */
  model: string;
  /** 原始错误描述（可选）。 */
  error?: string;
  /** 降级目标模型（kind=fallback 时）。 */
  fallbackModel?: string;
}

/** TUI 友好的任务显示信息 */
export interface TaskDisplayInfo {
  id: string;
  type: string;
  status: string;
  description: string;
  agentType?: string;
  command?: string;
  progress?: { toolUseCount: number; tokenCount: number };
  /** 当前/最近一次活动文案（如「读取 src/foo.ts」），运行中实时展示 */
  lastActivity?: string;
  /** 周期性进度摘要（M5 opt-in） */
  progressSummary?: string;
  /** 任务起始时间戳（ms）。运行中由前端本地 tick 实时计算耗时，不再依赖快照。 */
  startTime: number;
  /** 任务结束时间戳（ms）。终态后耗时定格到此值，避免回看时持续增长。 */
  endTime?: number;
  /** 耗时快照（ms）。终态展示用；运行中前端用 startTime 实时计算覆盖。 */
  durationMs: number;
}

interface AppProps {
  initialState: TUIState;
  callbacks: TUICallbacks;
  bridge: StateBridge;
  /** 是否启用 alternate buffer 全屏模式；默认 false → 主屏 Static 渲染（ADR-040） */
  alternateBuffer?: boolean;
}

// ── 流式虚拟 HistoryItem（用于在列表末尾插入流式内容） ──
const STREAMING_ITEM_ID = -1;

/** 内部 App 组件（在 Provider 内部，可使用 useKeypress） */
function TUIAppInner({ initialState, callbacks, bridge, alternateBuffer }: AppProps) {
  const { exit } = useApp();
  const [state, setState] = useState<TUIState>(initialState);
  const isSubmittingRef = useRef(false);
  // 流式状态 ref 镜像：供 handleSubmit 闭包读取最新值，决定输入入队还是直送
  const streamingStateRef = useRef<StreamingState>(StreamingState.Idle);

  // 从 TUIState 派生 StreamingState（上移到 handleSubmit 之前，供输入排队判断）。
  // 派生逻辑抽到 deriveStreamingState 纯函数便于单测；含 isLoading→Connecting 分支
  // 以消灭「回车后到首字到达」的首字延迟盲区。
  const streamingState = useMemo((): StreamingState => {
    return deriveStreamingState({
      isLoading: state.isLoading,
      isStreaming: state.isStreaming,
      isToolExecuting: state.isToolExecuting,
      permissionRequest: state.permissionRequest,
      shellConfirmRequest: state.shellConfirmRequest,
      planApprovalRequest: state.planApprovalRequest,
      askUserQuestionRequest: state.askUserQuestionRequest,
    });
  }, [state.permissionRequest, state.shellConfirmRequest, state.planApprovalRequest, state.askUserQuestionRequest, state.isStreaming, state.isToolExecuting, state.isLoading]);
  // 同步到 ref，供 handleSubmit 闭包读取最新流式态
  streamingStateRef.current = streamingState;
  const log = getLogger();
  const { getScrollState } = useScrollState();
  const { toggleRenderMarkdown, cycleExpandLevel, setShowIsExpandableHint, setCtrlCPressedOnce } = useUIActions();
  const { ctrlCPressedOnce, expandLevel } = useUIState();
  const { matchBinding } = useKeybindings();

  // v2：思考折叠状态。两种模式默认折叠成一行（对标 claude-code，思考不占满屏）。
  // ctrl+o 统一切换折叠/展开（与工具结果阶梯展开同键）。
  // - AB 模式：即时切换，重渲虚拟列表所有项。
  // - Static 模式：切换影响后续打印的项（已打印进 scrollback 的项无法重渲）。
  const defaultCollapsed = true;
  const [thinkCollapsed, setThinkCollapsed] = useState(defaultCollapsed);

  useEffect(() => {
    log.info("UI:APP", "TUIApp 组件已挂载（Alternate Buffer 模式）");

    // 启动延迟预取（首屏渲染完成后后台预热）
    import("../entrypoints/deferred-prefetch.ts").then(({ startDeferredPrefetches }) => {
      startDeferredPrefetches(true);
    }).catch(() => { /* 静默失败 */ });

    // 标记首屏渲染完成
    import("../utils/startup-profiler.ts").then(({ profileCheckpoint }) => {
      profileCheckpoint("render_complete");
    }).catch(() => { /* 静默失败 */ });

    return () => { log.info("UI:APP", "TUIApp 组件已卸载"); };
  }, []);

  // 事件驱动状态同步
  useEffect(() => {
    const onChange = (newState: TUIState) => {
      setState(newState);
    };
    bridge.on("change", onChange);
    return () => { bridge.off("change", onChange); };
  }, [bridge]);

  // 后台任务面板驱逐兜底：独立于主循环的 1s 定时器（对标 claude-code
  // CoordinatorAgentStatus.tsx 的 setInterval(1000) 驱逐 tick）。
  //
  // 根因：evictTerminalTasks() 此前只在 queryLoop 循环开头 + finally 收尾调用，都受
  // 主循环生命周期约束——① 主循环卡在长工具执行（如 30s bash）时，缓冲期到点的任务
  // 要等下一轮循环开头才清（视觉延迟）；② 主循环已结束时靠 finally 的 force 兜底（已修）。
  // cc 的做法是把驱逐挂在**面板组件的独立定时器**上：只要面板还有任务就每秒检查，
  // 完全不依赖主循环转没转。这里补齐这一层——面板有终止态任务时启动 1s tick，调用
  // evictTerminalTasks()（非 force，尊重 60s 缓冲期），驱逐发生时 registry 的
  // notifyTaskChanged → bridge.updateTasks 自动刷新面板。无终止态任务时不启动定时器
  //（避免空转）。这样"缓冲期到点"与"面板消失"之间的延迟被压到 ≤1s，且不依赖主循环。
  const hasTerminalTask = state.tasks.some(t => t.status !== "running");
  useEffect(() => {
    if (!hasTerminalTask) return;
    const timer = setInterval(() => {
      import("../task/index.ts")
        .then(({ evictTerminalTasks }) => evictTerminalTasks())
        .catch(() => { /* 驱逐兜底失败不影响 UI */ });
    }, 1000);
    return () => clearInterval(timer);
  }, [hasTerminalTask]);

  // 触发退出：先设置 isQuitting=true 让 Ink 渲染最终帧，再延迟退出
  const triggerQuit = useCallback(() => {
    log.info("UI:APP", "触发退出，切换到退出回显模式");
    bridge.update({ isQuitting: true });
    // 延迟 100ms 让 Ink 渲染最终帧到主缓冲区
    setTimeout(() => {
      exit();
    }, 100);
  }, [bridge, exit]);

  // Ctrl+C 二次确认退出：按一次提示「再按一次退出」,窗口内再按才真退出,超时/继续输入则取消。
  // 此前 Ctrl+C 单击即退,误触直接丢会话——ExitWarning 与 setCtrlCPressedOnce 也因无人接线成了死代码。
  const { press: pressCtrlC, cancel: cancelCtrlCConfirm } = useExitConfirm({
    pressedOnce: ctrlCPressedOnce,
    setPressedOnce: setCtrlCPressedOnce,
    onConfirm: triggerQuit,
  });

  // Ctrl+C 处理（Critical 优先级）：
  // ① 正在流式/工具执行 → 第一次 Ctrl+C 先中断当前操作(不退出),让用户能停下跑飞的任务而不丢会话;
  //    如果 abort 无效（如 openai parseSSE hang），第二次 Ctrl+C 直接强制退出（逃生口）;
  // ② 空闲(或已中断) → 走二次确认:首次提示、窗口内再按一次才退出。
  const abortAlreadyFired = useRef(false);
  const abortResetTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useKeypress(KeypressPriority.Critical, (key: Key) => {
    const b = matchBinding(key);
    if (b?.action !== "app:quit") return false;

    const busy = state.isLoading || state.isStreaming || state.isToolExecuting;
    if (busy) {
      // Fix 3: 如果上一次中断后仍然 busy（abort 无效），直接走强制退出逃生口
      if (abortAlreadyFired.current) {
        log.warn("UI:APP", "abort 无效，强制退出（逃生口）");
        triggerQuit();
        return true;
      }

      log.info("UI:APP", "用户按下 Ctrl+C，正忙——中断当前操作（不退出）");
      callbacks.onInterrupt();
      abortAlreadyFired.current = true;
      // 3s 后自动重置（如果 abort 生效了，状态会变 idle，重置也无害）
      // 清理旧定时器防止快速连按累积
      if (abortResetTimerRef.current) clearTimeout(abortResetTimerRef.current);
      abortResetTimerRef.current = setTimeout(() => {
        abortAlreadyFired.current = false;
        abortResetTimerRef.current = null;
      }, 3000);
      // 中断也清掉可能残留的退出确认态,避免「中断后下一次单击直接退出」的误判。
      cancelCtrlCConfirm();
      return true;
    }

    // 从 busy→idle 时重置 abort 标记
    abortAlreadyFired.current = false;
    if (abortResetTimerRef.current) {
      clearTimeout(abortResetTimerRef.current);
      abortResetTimerRef.current = null;
    }

    log.info("UI:APP", ctrlCPressedOnce ? "用户二次按下 Ctrl+C，退出" : "用户按下 Ctrl+C，提示再按一次退出");
    pressCtrlC();
    return true;
  });
  // 卸载时清理 abort 重置定时器
  useEffect(() => () => {
    if (abortResetTimerRef.current) clearTimeout(abortResetTimerRef.current);
  }, []);

  // 退出确认态下，用户按任意「非 Ctrl+C」可见字符键 → 立即取消退出意图（对标 ExitWarning「或继续输入以取消」）。
  // 放在 Critical 之后、其它 handler 之前；只取消、不消费按键（return false），让字符照常进输入框。
  useKeypress(KeypressPriority.High, (key: Key) => {
    if (!ctrlCPressedOnce) return false;
    // Ctrl+C 自身由上面的 handler 处理（二次确认退出），这里不插手。
    const b = matchBinding(key);
    if (b?.action === "app:quit") return false;
    // 任意实际输入（可插入字符或回车）都视为「继续操作」→ 取消退出确认。
    if (key.insertable || key.name === "return" || key.name === "enter") {
      log.info("UI:APP", "退出确认态下用户继续输入，取消退出");
      cancelCtrlCConfirm();
    }
    return false;
  });

  // Copy Mode 切换（Ctrl+S 进入，任意非导航键退出）
  // 仅 alternate buffer 全屏模式有意义；主屏模式鼠标从未被抢、原生选择一直可用，Ctrl+S 为 no-op（ADR-040）
  useKeypress(KeypressPriority.High, (key: Key) => {
    const b = matchBinding(key);
    if (b?.action === "app:toggleCopyMode") {
      if (!alternateBuffer) return false;
      const next = !state.copyModeEnabled;
      log.info("UI:APP", `Copy Mode ${next ? "启用" : "禁用"}`);
      bridge.update({ copyModeEnabled: next });
      if (next) {
        disableMouseEvents();
      } else {
        enableMouseEvents();
      }
      return true;
    }
    if (state.copyModeEnabled) {
      const navKeys = new Set(["pageup", "pagedown", "up", "down", "home", "end"]);
      if (!navKeys.has(key.name || "")) {
        log.info("UI:APP", "Copy Mode 退出（非导航键）");
        bridge.update({ copyModeEnabled: false });
        enableMouseEvents();
        return false;
      }
    }
    return false;
  });

  // Alt+M 切换 Markdown 渲染
  useKeypress(KeypressPriority.High, (key: Key) => {
    const b = matchBinding(key);
    if (b?.action === "app:toggleMarkdown") {
      log.info("UI:APP", "切换 Markdown 渲染模式");
      toggleRenderMarkdown();
      return true;
    }
    return false;
  });

  // Ctrl+O 统一展开/收起折叠内容（对标 claude-code：单键管所有折叠区）：
  // 工具结果阶梯展开（0 折叠 → 1 更多 → 2 全展开 → 0），思考块与 expandLevel 同步：
  // expandLevel=0 时折叠思考，≥1 时展开思考。两者周期对齐，不再割裂。
  const showHintTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useKeypress(KeypressPriority.High, (key: Key) => {
    const b = matchBinding(key);
    if (b?.action === "app:toggleHeight") {
      log.info("UI:APP", "统一展开/收起折叠内容（Ctrl+O）");
      // TO4：工具结果阶梯循环展开级别。
      cycleExpandLevel();
      // 思考块由 useEffect 跟随 expandLevel 同步，此处不再独立切换。
      setShowIsExpandableHint(true);
      // 快速连按时清旧定时器再启新，防止定时器累积
      if (showHintTimerRef.current) clearTimeout(showHintTimerRef.current);
      showHintTimerRef.current = setTimeout(() => {
        setShowIsExpandableHint(false);
        showHintTimerRef.current = null;
      }, 3000);
      return true;
    }
    return false;
  });
  // 卸载时清理定时器
  useEffect(() => () => {
    if (showHintTimerRef.current) clearTimeout(showHintTimerRef.current);
  }, []);

  // 思考块折叠状态跟随 expandLevel 同步：level=0 折叠，≥1 展开。
  // 用 useEffect 保证单一事实源，消除三值/二值周期不对齐问题。
  useEffect(() => {
    setThinkCollapsed(expandLevel === 0);
  }, [expandLevel]);

  // Esc 中断当前流式响应/工具执行
  useKeypress(KeypressPriority.High, (key: Key) => {
    const isInterruptible =
      (state.isLoading || state.isStreaming || state.isToolExecuting) &&
      !state.permissionRequest &&
      !state.shellConfirmRequest &&
      !state.askUserQuestionRequest &&
      !state.activeDialog;

    if (!isInterruptible) return false;
    const b = matchBinding(key);
    if (b?.action !== "app:interrupt") return false;

    log.info("UI:APP", "用户按下 Esc，请求中断当前操作");
    callbacks.onInterrupt();
    return true;
  });

  // 关闭统一错误面板（对齐项目惯例：走 matchBinding 派发而非组件内硬编码按键判断，
  // 保证用户在 keybindings.json 重绑该 action 后依然生效）。
  useKeypress(KeypressPriority.High, (key: Key) => {
    if (state.errorPanel.length === 0) return false;
    const b = matchBinding(key);
    if (b?.action !== "app:dismissError") return false;
    log.info("UI:APP", "用户关闭统一错误面板");
    handleDismissErrorPanel();
    return true;
  });

  // 底层分发：真正把一条输入送到 App 业务层（斜杠命令 / 普通输入）。
  // 被 handleSubmit（直送）与消息队列（接续）共用。
  const dispatchInput = useCallback(async (text: string) => {
    log.info("UI:INPUT", `dispatchInput: "${text.slice(0, 100)}"`);
    if (text.startsWith("/")) {
      const [cmd, ...rest] = text.slice(1).split(" ");
      if (cmd === "exit" || cmd === "quit") { triggerQuit(); return; }
      await callbacks.onSlashCommand(cmd, rest.join(" "));
    } else {
      await callbacks.onUserInput(text);
    }
  }, [callbacks]);

  // 多条输入排队：流式响应中提交的普通输入入队，当前轮结束（Idle）后自动接续。
  // 对标 cc 的 now>next>later——这里实现 next（用户输入排队），系统通知不抢占。
  const { enqueue, queueLength } = useMessageQueue({
    streamingState,
    onSend: dispatchInput,
  });

  const handleSubmit = useCallback(async (text: string) => {
    log.info("UI:INPUT", `handleSubmit: "${text.slice(0, 100)}"`);
    if (isSubmittingRef.current) return;

    // 用户提交输入 → 取消任何待确认的 Ctrl+C 退出意图（对标 cc：继续操作即视为放弃退出）。
    cancelCtrlCConfirm();

    // 流式进行中：斜杠命令仍直送（/exit、/clear 等需即时生效），普通输入入队接续。
    const busy = streamingStateRef.current !== StreamingState.Idle;
    if (busy && !text.startsWith("/")) {
      log.info("UI:INPUT", "流式中，输入入队等待接续");
      enqueue(text);
      return;
    }

    isSubmittingRef.current = true;
    try {
      await dispatchInput(text);
    } catch (err: any) {
      log.error("UI:INPUT", `handleSubmit 异常`, { error: err.message });
    } finally {
      isSubmittingRef.current = false;
    }
  }, [dispatchInput, enqueue, cancelCtrlCConfirm]);

  const isEmpty = state.historyItems.length === 0 && !state.isStreaming;
  // 使用响应式终端尺寸（resize 时自动触发重渲染）
  const { width: termWidth, height: rows } = useTerminalDimensions();

  // TM2/TM3/TM4：终端集成接线（标题 / tab 状态圆点 / 响应完成通知）。
  // 标题任务名优先用会话任务名（首条消息启发式 + 后台 Haiku 升级,见 app.ts）,
  // 尚无会话时回退到 cwd 末段,便于多窗口区分。
  const titleHint = useMemo(() => {
    if (state.sessionTitle && state.sessionTitle.trim()) return state.sessionTitle.trim();
    const parts = (state.cwd || "").split(/[/\\]/).filter(Boolean);
    return parts.length ? parts[parts.length - 1] : "sid-code";
  }, [state.sessionTitle, state.cwd]);
  useTerminalIntegration({ streamingState, titleHint });

  // 派生 ConfigContext 值
  const configValue = useMemo((): ConfigContextValue => ({
    model: state.model,
    provider: state.provider,
    permissionMode: state.permissionMode,
    isPlanMode: state.isPlanMode,
    gitBranch: state.gitBranch,
    debug: state.debug,
    cwd: state.cwd,
    commands: state.commands,
    availableModels: state.availableModels,
    effortDisplay: state.effortDisplay,
    thinkingDisplay: state.thinkingDisplay,
    goalDisplay: state.goalDisplay,
  }), [state.model, state.provider, state.permissionMode, state.isPlanMode, state.gitBranch, state.debug, state.cwd, state.commands, state.availableModels, state.effortDisplay, state.thinkingDisplay, state.goalDisplay]);

  // 派生 SessionContext 值
  const sessionValue = useMemo((): SessionContextValue => ({
    usage: state.usage,
    costUSD: state.costUSD,
    costLimit: state.costLimit,
    contextPercent: state.contextPercent,
    turnStartOutputTokens: state.turnStartOutputTokens,
  }), [state.usage, state.costUSD, state.costLimit, state.contextPercent, state.turnStartOutputTokens]);

  // 构建包含流式内容的完整 HistoryItem 数组
  const listData = useMemo((): HistoryItem[] => {
    const items: HistoryItem[] = [];

    // 插入 AppHeader 作为第一个 item（仅当有消息时显示）
    if (state.historyItems.length > 0) {
      items.push({
        id: -2,
        type: "app_header",
        version: require("../../package.json").version,
      });
    }

    items.push(...state.historyItems);

    if (state.isStreaming && state.streamingText) {
      // 插入一个虚拟的流式 HistoryItem
      items.push({
        id: STREAMING_ITEM_ID,
        type: "assistant",
        text: "__streaming__",
      });
    }
    return items;
  }, [state.historyItems, state.isStreaming, state.streamingText]);

  // 主屏 Static 模式专用：仅**已终结**历史（含 app_header，不含流式虚拟项、不含执行中活项）。
  // 流式内容在 MainScreenLayout 动态区单独渲染，完成后才并入 historyItems → 进 Static（ADR-040）。
  //
  // 关键：executing 状态的工具组（tool_use 已入 ctxMgr、tool_result 未到的中间态）必须
  // 从 Static 剥离——否则它被一次性打印进 scrollback，工具完成后 log-update 的 cell diff
  // 擦不掉已滚出视口的旧行，导致 `⏺ task_list`/`⏺ task_output` 幽灵行永久残留。
  // 剥出的 live 项改由动态区渲染（每帧重绘、永不提交 scrollback）。
  const { committed: committedHistoryItems, live: liveToolItemsRaw } = useMemo(
    () => splitLiveToolItems(state.historyItems),
    [state.historyItems],
  );
  // 动态区 live 活项视口封顶（根治幽灵行残留）：live 活项虽在动态区渲染，但动态区同样受
  // log-update"擦不掉 scrollback"的物理限制（见 capLiveToolItems / MainScreenLayout 注释）。
  // 并行多工具时若 live 活项高度超过视口，早期 executing 行会溢出 scrollback 永久残留。
  // 这里按视口高度派生一个预算：动态区还要容纳 streaming/thinking/composer/footer/对话框，
  // 故 live 活项只取视口的约 1/3，且封顶在 [3, 12] 行区间（极小终端至少给 3 行，大终端也不
  // 无限铺）。超出的工具由 MainScreenLayout 用一行「… +N 个工具执行中」摘要代替。
  const liveToolRowsBudget = Math.max(3, Math.min(12, Math.floor(rows / 3)));
  const { visible: liveToolItems, hiddenToolCount: hiddenLiveToolCount } = useMemo(
    () => capLiveToolItems(liveToolItemsRaw, liveToolRowsBudget),
    [liveToolItemsRaw, liveToolRowsBudget],
  );
  const staticItems = useMemo(
    (): HistoryItem[] => buildStaticItems(committedHistoryItems, require("../../package.json").version),
    [committedHistoryItems],
  );

  // key 提取器
  const keyExtractor = useCallback((item: HistoryItem, _index: number): string => {
    if (item.id === STREAMING_ITEM_ID) return "streaming-tail";
    return `hi-${item.id}-${item.type}`;
  }, []);

  // 高度估算
  const estimatedItemHeight = useCallback((index: number): number => {
    const item = listData[index];
    if (!item) return 1;

    if (item.id === STREAMING_ITEM_ID) {
      const effectiveWidth = Math.max(1, termWidth - 12);
      return Math.max(1, Math.ceil((state.streamingText?.length || 0) / effectiveWidth));
    }

    switch (item.type) {
      case "app_header":
        return 10; // Logo + 版本 + Tip + margins
      case "user":
      case "command":
        return Math.max(1, Math.ceil((item.text?.length || 0) / Math.max(1, termWidth - 12)));
      case "assistant":
      case "assistant_content": {
        const effectiveWidth = Math.max(1, termWidth - 12);
        return Math.max(1, Math.ceil(((item.text?.length || 0) * 1.3) / effectiveWidth));
      }
      case "tool_group":
        return item.tools.length * 2;
      case "thinking":
        return Math.max(2, (item.thought.text?.split("\n").length || 0) + 1);
      default:
        return 1;
    }
  }, [listData, termWidth, state.streamingText]);

  // 获取滚动百分比
  const scrollState = getScrollState();
  const scrollPercent = scrollState ? scrollState.percent : undefined;

  // ── 对话框回调 ──
  const handleDialogClose = useCallback(() => {
    bridge.update({ activeDialog: null });
  }, [bridge]);

  const handleDismissErrorPanel = useCallback(() => {
    bridge.update({ errorPanel: [] });
  }, [bridge]);

  const handleModelSelect = useCallback((modelName: string) => {
    // 通过斜杠命令切换模型（复用已有逻辑）。附加 -p 持久化到 settings.json：
    // 对话框选择是用户主动、有意的模型选择（区别于临时试用），理应跨会话保留——
    // 这正是"切了模型重开却回退"痛点的正解。命令行快捷切换仍默认不持久化，需显式 -p。
    callbacks.onSlashCommand("model", `${modelName} -p`);
    bridge.update({ activeDialog: null });
  }, [callbacks, bridge]);

  const handleThemeSelect = useCallback((themeName: string) => {
    // 附加 -p 持久化：对话框选主题是用户主动、有意的偏好选择，理应跨会话保留
    // （与 handleModelSelect 同构）。命令行 /theme <name> 仍默认不持久化，需显式 -p。
    callbacks.onSlashCommand("theme", `${themeName} -p`);
    bridge.update({ activeDialog: null });
  }, [callbacks, bridge]);

  // Shift+Tab 权限模式循环切换：转交 app.ts 的 cyclePermissionMode（切模式 + 刷状态栏 + 提示）。
  const handleCyclePermissionMode = useCallback(() => {
    callbacks.onCyclePermissionMode?.();
  }, [callbacks]);

  // 首次启动引导完成：交给 app.ts 回调写盘 + 热加载 Provider
  const handleCompleteOnboarding = useCallback(
    (result: import("./components/OnboardingDialog.tsx").OnboardingResult) => {
      callbacks.onCompleteOnboarding?.(result);
    },
    [callbacks],
  );

  // 首次启动引导：needsOnboarding 且当前无其它对话框时，自动弹出 OnboardingDialog
  useEffect(() => {
    if (state.needsOnboarding && !state.activeDialog) {
      bridge.update({ activeDialog: "onboarding" });
    }
  }, [state.needsOnboarding, state.activeDialog, bridge]);

  // 可用模型列表（从 config 中获取）
  const availableModels = useMemo(() => {
    return state.availableModels ?? [];
  }, [state.availableModels]);

  // 可用主题列表
  const availableThemes = useMemo(() => {
    try {
      const { themeManager } = require("../ui/themes/theme-manager.ts");
      return themeManager.getAvailableThemes().map((t: any) => ({
        name: t.name,
        type: t.type as "light" | "dark",
        description: t.description,
      }));
    } catch {
      return [];
    }
  }, []);

  const currentTheme = useMemo(() => {
    try {
      const { themeManager } = require("../ui/themes/theme-manager.ts");
      return themeManager.getActiveTheme().name;
    } catch {
      return "";
    }
  }, []);

  // 退出回显模式
  if (state.isQuitting) {
    // 主屏模式：历史已在终端 scrollback，退出直接 unmount，无需重画（ADR-040）
    if (!alternateBuffer) return null;
    return (
      <AlternateBufferQuittingDisplay
        historyItems={state.historyItems}
        streamingText={state.isStreaming ? state.streamingText : undefined}
      />
    );
  }

  // ── 固定高度布局 ──
  return (
    <ConfigProvider value={configValue}>
    <SessionProvider value={sessionValue}>
    <StreamingProvider
      streamingState={streamingState}
      streamingText={state.streamingText}
      streamingThinking={state.streamingThinking}
      toolName={state.toolName}
      toolInput={state.toolInput}
      isToolExecuting={state.isToolExecuting}
      lastToolResult={state.lastToolResult}
      statusMessage={state.statusMessage}
    >
      {alternateBuffer ? (
        <DefaultAppLayout
          listData={listData}
          streamingText={state.streamingText}
          streamingThinking={state.streamingThinking}
          streamingThinkingStartMs={state.streamingThinkingStartMs}
          thinkCollapsed={thinkCollapsed}
          isStreaming={state.isStreaming}
          isEmpty={isEmpty}
          termWidth={termWidth}
          rows={rows}
          estimatedItemHeight={estimatedItemHeight}
          keyExtractor={keyExtractor}
          copyModeEnabled={state.copyModeEnabled}
          statusMessage={state.statusMessage}
          retryStatus={state.retryStatus}
          errorPanel={state.errorPanel}
          onDismissErrorPanel={handleDismissErrorPanel}
          permissionRequest={state.permissionRequest}
          shellConfirmRequest={state.shellConfirmRequest}
          planApprovalRequest={state.planApprovalRequest}
          askUserQuestionRequest={state.askUserQuestionRequest}
          isLoading={state.isLoading}
          commands={state.commands}
          cwd={state.cwd}
          onSubmit={handleSubmit}
          queuedCount={queueLength}
          onExitRequest={triggerQuit}
          onCyclePermissionMode={handleCyclePermissionMode}
          permissionMode={state.permissionMode}
          isPlanMode={state.isPlanMode}
          gitBranch={state.gitBranch}
          debug={state.debug}
          usage={state.usage}
          stockInputTokens={state.stockInputTokens}
          costUSD={state.costUSD}
          cacheSavingsUSD={state.cacheSavingsUSD}
          costLimit={state.costLimit}
          contextPercent={state.contextPercent}
          model={state.model}
          scrollPercent={scrollPercent}
          activeDialog={state.activeDialog}
          onDialogClose={handleDialogClose}
          availableModels={availableModels}
          onModelSelect={handleModelSelect}
          availableThemes={availableThemes}
          currentTheme={currentTheme}
          onThemeSelect={handleThemeSelect}
          onCompleteOnboarding={handleCompleteOnboarding}
          mcpManager={callbacks.mcpManager}
          sessionState={callbacks.sessionState}
          callbacks={callbacks}
          provider={state.provider}
          todos={state.todos}
          tasks={state.tasks}
          startupWarnings={state.startupWarnings}
        />
      ) : (
        <MainScreenLayout
          staticItems={staticItems}
          liveToolItems={liveToolItems}
          hiddenLiveToolCount={hiddenLiveToolCount}
          streamingText={state.streamingText}
          streamingThinking={state.streamingThinking}
          streamingThinkingStartMs={state.streamingThinkingStartMs}
          thinkCollapsed={thinkCollapsed}
          isStreaming={state.isStreaming}
          isEmpty={isEmpty}
          termWidth={termWidth}
          keyExtractor={keyExtractor}
          statusMessage={state.statusMessage}
          retryStatus={state.retryStatus}
          errorPanel={state.errorPanel}
          onDismissErrorPanel={handleDismissErrorPanel}
          permissionRequest={state.permissionRequest}
          shellConfirmRequest={state.shellConfirmRequest}
          planApprovalRequest={state.planApprovalRequest}
          askUserQuestionRequest={state.askUserQuestionRequest}
          isLoading={state.isLoading}
          commands={state.commands}
          cwd={state.cwd}
          onSubmit={handleSubmit}
          queuedCount={queueLength}
          onExitRequest={triggerQuit}
          onCyclePermissionMode={handleCyclePermissionMode}
          permissionMode={state.permissionMode}
          isPlanMode={state.isPlanMode}
          gitBranch={state.gitBranch}
          debug={state.debug}
          usage={state.usage}
          stockInputTokens={state.stockInputTokens}
          costUSD={state.costUSD}
          cacheSavingsUSD={state.cacheSavingsUSD}
          costLimit={state.costLimit}
          contextPercent={state.contextPercent}
          model={state.model}
          activeDialog={state.activeDialog}
          onDialogClose={handleDialogClose}
          availableModels={availableModels}
          onModelSelect={handleModelSelect}
          availableThemes={availableThemes}
          currentTheme={currentTheme}
          onThemeSelect={handleThemeSelect}
          onCompleteOnboarding={handleCompleteOnboarding}
          mcpManager={callbacks.mcpManager}
          sessionState={callbacks.sessionState}
          callbacks={callbacks}
          provider={state.provider}
          todos={state.todos}
          tasks={state.tasks}
          startupWarnings={state.startupWarnings}
        />
      )}
    </StreamingProvider>
    </SessionProvider>
    </ConfigProvider>
  );
}


/** 顶层 TUI 组件：包裹 Provider 层 */
export function TUIApp(props: AppProps) {
  const selectionWarningTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastSelectionWarning = useRef(0);
  const handleSelectionWarning = useCallback(() => {
    const now = Date.now();
    if (now - lastSelectionWarning.current < 2000) return;
    lastSelectionWarning.current = now;

    props.bridge.update({
      statusMessage: "按 Ctrl+S 进入 Copy Mode 以选择和复制文本",
    });
    if (selectionWarningTimer.current) clearTimeout(selectionWarningTimer.current);
    selectionWarningTimer.current = setTimeout(() => {
      props.bridge.update({ statusMessage: "" });
      selectionWarningTimer.current = null;
    }, 3000);
  }, [props.bridge]);

  return (
    <TerminalProvider>
      <KeypressProvider>
        <MouseProvider mouseEventsEnabled={props.alternateBuffer === true} onSelectionWarning={handleSelectionWarning}>
          <ScrollProvider>
            <OverflowProvider>
              <SettingsProvider>
                <UIStateProvider>
                  <AccessibilityProvider>
                    <KeybindingProvider>
                      <TUIAppInner {...props} />
                    </KeybindingProvider>
                  </AccessibilityProvider>
                </UIStateProvider>
              </SettingsProvider>
            </OverflowProvider>
          </ScrollProvider>
        </MouseProvider>
      </KeypressProvider>
    </TerminalProvider>
  );
}
