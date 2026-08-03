/**
 * TodoPanel — TUI 任务清单面板
 *
 * 在输入框上方实时显示：
 * 1. TodoWrite 工具的当前任务清单进度
 * 2. 后台 Shell/Agent 任务状态（对标 cc TaskListV2 / TeammateSpinnerLine）
 *
 * 视觉语言（对标 claude-code）：
 * - checkbox 用 ○◐● 几何字形族（填充度表达状态递进），不用彩色 emoji
 * - 完成态 strikethrough + dim，进行中 bold + 品牌色，待办常态
 * - 顶部一行极简进度条 ▰▱，进度一眼可见
 *
 * 实时性（本次修复重点）：
 * - 运行中任务用 useAnimationFrame(keepAlive) 驱动共享时钟，每秒重渲：
 *   ① 耗时秒数实时跳动（用 startTime 与当前墙钟实算，不再依赖事件快照冻结值）
 *   ② 旋转字形动画表达「活着、在动」
 * - 数据层已打通 token/工具次数实时回写（见 sub-agent.ts / headless.ts），
 *   此处直接展示真实进度，并新增「当前活动」行（⎿ 读取 xxx）。
 * - a11y 模式完全关动画：静态字形 + 不取帧（屏幕阅读器会把逐帧变化读成噪声）。
 *
 * fix_type: behavior_change（视觉重构 + 实时性修复，§0.3）
 */

import React, { useEffect, useRef } from "react";
import Box from "../../ink/components/Box.js";
import Text from "../../ink/components/Text.js";
import { useAnimationFrame } from "../../ink/hooks/use-animation-frame.js";
import { useKeybindings } from "../contexts/KeybindingContext.tsx";
import { shouldShowHint, markHintShown } from "../../config/app-config.ts";
import type { TodoItem } from "../../tool/todo-write.ts";
import type { TaskDisplayInfo } from "../App.tsx";
import { theme } from "../semantic-colors.ts";
import { stringWidth } from "../../ink/stringWidth.js";
import { useIsAccessibilityEnabled } from "../accessibility/AccessibilityContext.tsx";
import { useExpandLevel } from "../contexts/UIStateContext.tsx";
import { formatLargeNumber } from "../utils/format-number.ts";
import { formatDuration } from "../utils/format-duration.ts";
import {
  TODO_PENDING,
  TODO_IN_PROGRESS,
  TODO_COMPLETED,
  PROGRESS_FILLED,
  PROGRESS_EMPTY,
  ARROW_PROMPT,
  ERROR_MARK,
  TREE_BRANCH,
  TASK_SPINNER_FRAMES,
  TASK_KILLED_MARK,
} from "../constants/figures.ts";

/** 「Ctrl+X 划掉已完成」提示的 hint 计数键（app-config 通用衰减计数）。 */
const DISMISS_HINT_KEY = "taskPanelDismiss";
/** 该提示的显示次数上限，超过后不再打扰（L4.C 渐进衰减，与 ErrorPanel/InputArea 同档）。 */
const DISMISS_HINT_MAX_SHOWS = 3;

interface TodoPanelProps {
  todos: TodoItem[];
  /** 后台任务列表 */
  tasks: TaskDisplayInfo[];
  /** 终端宽度，用于截断长文本 */
  termWidth: number;
  /** 最大显示行数，超出则截断 */
  maxDisplay?: number;
  /** Ctrl+T 隐藏后台任务面板（仅隐藏 UI，任务照常运行）。默认 false=显示。 */
  tasksHidden?: boolean;
}

/** 截断文本到指定显示宽度（CJK 安全：按 stringWidth 列宽累计，非码点数） */
function truncate(text: string, maxLen: number): string {
  if (stringWidth(text) <= maxLen) return text;
  // 预留 1 列给省略号，逐字符累计显示宽度
  const budget = Math.max(1, maxLen - 1);
  let width = 0;
  let result = "";
  for (const ch of text) {
    const cw = stringWidth(ch);
    if (width + cw > budget) break;
    width += cw;
    result += ch;
  }
  return result + "…";
}

/** 极简进度条：宽度固定，按完成比例填充 ▰/▱ */
function ProgressBar({ completed, total, width = 10 }: { completed: number; total: number; width?: number }) {
  if (total <= 0) return null;
  const ratio = Math.max(0, Math.min(1, completed / total));
  const filled = Math.min(width, Math.round(ratio * width));
  const empty = Math.max(0, width - filled);
  const allDone = completed >= total;
  return (
    <Text>
      <Text color={allDone ? theme.status.success : theme.ui.active}>
        {PROGRESS_FILLED.repeat(filled)}
      </Text>
      <Text color={theme.ui.dark}>{PROGRESS_EMPTY.repeat(empty)}</Text>
    </Text>
  );
}

/** 单条 todo 渲染 */
const TodoRow = React.memo(function TodoRow({
  item,
  maxContentLen,
}: {
  item: TodoItem;
  maxContentLen: number;
}) {
  const isCompleted = item.status === "completed";
  const isInProgress = item.status === "in_progress";

  const icon = isCompleted
    ? TODO_COMPLETED
    : isInProgress
    ? TODO_IN_PROGRESS
    : TODO_PENDING;

  const iconColor = isCompleted
    ? theme.status.success
    : isInProgress
    ? theme.ui.active
    : theme.text.secondary;

  // 进行中优先显示 activeForm（现在分词形式，更生动），否则用 content
  const label = isInProgress && item.activeForm ? item.activeForm : item.content;

  return (
    <Box flexDirection="row">
      <Box width={2} flexShrink={0}>
        <Text color={iconColor} bold={isInProgress}>{icon}</Text>
      </Box>
      <Text
        color={isInProgress ? theme.text.primary : theme.text.secondary}
        bold={isInProgress}
        strikethrough={isCompleted}
        dimColor={isCompleted}
      >
        {truncate(label, maxContentLen)}
      </Text>
    </Box>
  );
});

/**
 * 单条后台任务渲染。
 *
 * 运行中任务订阅共享时钟（useAnimationFrame，keepAlive）：
 * - 每秒重渲 → 耗时用 startTime 与当前墙钟实算（不再冻结在事件快照）
 * - 旋转字形动画表达「活着」
 * 终态任务不订阅时钟（intervalMs=null → 不取帧、不驱动时钟），耗时定格。
 */
const TaskRow = React.memo(function TaskRow({
  task,
  maxContentLen,
}: {
  task: TaskDisplayInfo;
  maxContentLen: number;
}) {
  const isRunning = task.status === "running";
  const isFailed = task.status === "failed";
  const isKilled = task.status === "killed";
  const a11y = useIsAccessibilityEnabled();
  // P2-4：Ctrl+O verbose 覆盖子代理详情。expandLevel≥1 时展开最近工具活动序列，
  // =0 折叠为单行 activityLine（对齐 cc verbose 语义：Ctrl+O 统管子代理详略）。
  const expandLevel = useExpandLevel();
  const verbose = expandLevel >= 1;

  // 运行中订阅共享时钟（a11y 关动画 → 不订阅）。250ms 重渲一次：
  // 旋转字形每帧推进一个象限(平滑转动)，耗时秒数也随之实时刷新。
  const animate = isRunning && !a11y;
  const [tickRef, tickTime] = useAnimationFrame(animate ? 250 : null);

  // 旋转字形帧：帧周期与重渲间隔(250ms)一致——每次重渲推进一个象限。
  // 否则按更短周期取帧、却跨过整数个周期回到同一帧 → 看似静止。
  const spinnerFrame = animate
    ? TASK_SPINNER_FRAMES[Math.floor(tickTime / 250) % TASK_SPINNER_FRAMES.length]
    : TODO_IN_PROGRESS;

  // 状态字形：运行中 旋转◐ / 完成 ● / 失败 ✘ / 终止 ⊘
  const statusIcon = isRunning
    ? spinnerFrame
    : isFailed
    ? ERROR_MARK
    : isKilled
    ? TASK_KILLED_MARK
    : TODO_COMPLETED;

  const statusColor = isRunning
    ? theme.ui.active
    : isFailed
    ? theme.status.error
    : isKilled
    ? theme.status.warning
    : theme.status.success;

  const label =
    task.type === "local_agent" && task.agentType
      ? `AG ${task.agentType}`
      : task.type === "local_shell"
      ? "SH"
      : task.type === "local_workflow"
      ? // state-bridge 传入 agentType="workflow:<名字>",剥前缀显示为 "WF <名字>",
        // 与 "AG"/"SH" 风格统一;无名字时退回 "WF"。
        `WF ${task.agentType?.replace(/^workflow:/, "") ?? ""}`.trimEnd()
      : task.type;

  const desc =
    task.description ||
    (task.type === "local_shell" && task.command ? truncate(task.command, 40) : "");

  // 耗时：运行中用 startTime 与当前墙钟实算（tickTime 仅触发重渲，不参与计算，
  // 因其相对时钟起点而非 epoch）；终态用快照 durationMs 定格。
  // 读取 tickTime 建立依赖，确保动画态每秒重算。
  void tickTime;
  const elapsedMs = isRunning ? Date.now() - task.startTime : task.durationMs;
  const durationText = formatDuration(elapsedMs);

  // 统计：真实工具次数 + token + 耗时，清晰分隔且带单位（旧版 "0t·0 19s" 含义晦涩）。
  const stats: string[] = [];
  if (isRunning && task.progress) {
    if (task.progress.toolUseCount > 0) stats.push(`${task.progress.toolUseCount} 工具`);
    if (task.progress.tokenCount > 0) stats.push(`${formatLargeNumber(task.progress.tokenCount)} token`);
  }
  stats.push(durationText);
  const statsText = stats.join(" · ");

  // 当前活动行（运行中且有活动文案时）：优先 progressSummary，否则 lastActivity。
  const activityLine = isRunning
    ? task.progressSummary || task.lastActivity || null
    : task.progressSummary || null;

  return (
    <Box flexDirection="column">
      <Box flexDirection="row">
        <Box width={2} flexShrink={0} ref={tickRef}>
          {/* ref 挂在字形容器上做视口可见性检测；离屏时动画自动暂停 */}
          <Text color={statusColor} bold={isRunning}>{statusIcon}</Text>
        </Box>
        <Box flexGrow={1}>
          <Text>
            <Text color={theme.ui.active} dimColor>{`[${label}] `}</Text>
            <Text color={isRunning ? theme.text.primary : theme.text.secondary} dimColor={!isRunning}>
              {truncate(desc, Math.max(10, maxContentLen - 24))}
            </Text>
          </Text>
        </Box>
        <Text color={theme.text.secondary} dimColor>{statsText}</Text>
      </Box>
      {/* verbose（Ctrl+O expandLevel≥1）且有工具活动序列：逐行展开最近活动。
          否则折叠为单行 activityLine。 */}
      {verbose && task.recentActivities && task.recentActivities.length > 0 ? (
        task.recentActivities.map((act, i) => (
          <Box key={i} flexDirection="row" paddingLeft={2}>
            <Text color={theme.text.secondary} dimColor>{`${TREE_BRANCH} `}</Text>
            <Text color={theme.text.secondary} dimColor>{truncate(act, maxContentLen - 6)}</Text>
          </Box>
        ))
      ) : activityLine ? (
        <Box flexDirection="row" paddingLeft={2}>
          <Text color={theme.text.secondary} dimColor>{`${TREE_BRANCH} `}</Text>
          <Text color={theme.text.secondary} dimColor>{truncate(activityLine, maxContentLen - 6)}</Text>
        </Box>
      ) : null}
    </Box>
  );
});

export const TodoPanel = React.memo(function TodoPanel({
  todos,
  tasks,
  termWidth,
  maxDisplay = 8,
  tasksHidden = false,
}: TodoPanelProps) {
  const hasTodos = todos && todos.length > 0;
  // Ctrl+T 隐藏后台任务面板：任务仍在跑，只是不占屏。
  const hasTasks = !tasksHidden && tasks && tasks.length > 0;

  // 「Ctrl+X 划掉已完成」提示的渐进衰减（L4.C）：新用户不知道有这个出口，
  // 教 DISMISS_HINT_MAX_SHOWS 次就该收敛，否则每次任务跑完都唠叨一句。
  // 计数在「面板从非全终态 → 全终态」的上升沿 +1（每批任务完成记一次，而非每帧），
  // 用 ref 锁定本次形态防抖动——套路对齐 InputArea 的 queueHint / shellHint。
  // 键位展示走 keybindings 运行时表，用户在 keybindings.json 重绑后此处同步更新。
  const { bindingFor } = useKeybindings();
  const dismissDisplay = bindingFor("app:dismissTasks")?.display ?? "Ctrl+X";
  const allTerminalNow = hasTasks && tasks.every((t) => t.status !== "running");
  const dismissHintRef = useRef(false);
  const prevAllTerminalRef = useRef(false);
  useEffect(() => {
    if (!prevAllTerminalRef.current && allTerminalNow) {
      dismissHintRef.current = shouldShowHint(DISMISS_HINT_KEY, DISMISS_HINT_MAX_SHOWS);
      if (dismissHintRef.current) markHintShown(DISMISS_HINT_KEY);
    } else if (!allTerminalNow) {
      dismissHintRef.current = false;
    }
    prevAllTerminalRef.current = allTerminalNow;
  }, [allTerminalNow]);
  const showDismissHint = dismissHintRef.current;

  // 提前 return 必须在所有 Hook 之后——否则 hasTasks=false 的帧会少调 Hook，
  // 违反 React Hook 顺序规则（报 "Rendered fewer hooks than expected"）。
  if (!hasTodos && !hasTasks) return null;

  const compactMode = termWidth < 60 || maxDisplay === 0;
  const maxContentLen = Math.max(20, compactMode ? termWidth - 16 : termWidth - 6);

  // ── Todo 部分 ──
  let todoSection: React.ReactNode = null;
  if (hasTodos) {
    const completed = todos.filter((t) => t.status === "completed").length;
    const total = todos.length;

    // 保持原始顺序，仅当超过显示上限时截断（始终保留 in_progress，其余按原始顺序取舍）
    const maxTodoDisplay = Math.min(maxDisplay, 6);
    let visibleTodos = todos;
    let hiddenCount = 0;
    if (!compactMode && todos.length > maxTodoDisplay) {
      const inProgressCount = todos.filter((t) => t.status === "in_progress").length;
      const maxNonInProgress = maxTodoDisplay - inProgressCount;
      let nonInProgressTaken = 0;
      visibleTodos = [];
      for (const item of todos) {
        if (item.status === "in_progress") {
          visibleTodos.push(item);
        } else if (nonInProgressTaken < maxNonInProgress) {
          visibleTodos.push(item);
          nonInProgressTaken++;
        }
      }
      hiddenCount = total - visibleTodos.length;
    }

    const allDone = completed === total && total > 0;

    todoSection = (
      <Box flexDirection="column">
        {/* 标题行：箭头引导 + 标题 + 右对齐进度条 + 计数 */}
        <Box flexDirection="row" marginBottom={1}>
          <Text color={theme.ui.active}>{`${ARROW_PROMPT} `}</Text>
          <Text bold color={theme.text.primary}>任务清单</Text>
          <Box flexGrow={1} />
          <ProgressBar completed={completed} total={total} />
          <Text color={allDone ? theme.status.success : theme.text.secondary}>{`  ${completed}/${total}`}</Text>
          {hiddenCount > 0 && <Text dimColor>{`  …+${hiddenCount}`}</Text>}
        </Box>
        {!compactMode &&
          visibleTodos.map((item, i) => (
            <TodoRow key={i} item={item} maxContentLen={maxContentLen} />
          ))}
      </Box>
    );
  }

  // ── 后台任务部分 ──
  let taskSection: React.ReactNode = null;
  if (hasTasks) {
    const running = tasks.filter((t) => t.status === "running");
    const terminal = tasks.filter((t) => t.status !== "running");
    // 终态只留最近 3 条 + 总渲染上限 5 条：面板是常驻区，不能被历史任务挤满。
    // 但截断必须**可见**（本仓库「无静默截断」原则，L3.3 折叠规范）——此前两处 slice
    // 都不给任何提示，用户看到的是"任务凭空少了"，与问题四「面板不消失」叠加后更困惑：
    // 分不清一条任务是被驱逐了、被划掉了，还是仅仅被挤出可视窗口。
    const windowed = [...running, ...terminal.slice(-3)];
    const visibleTasks = windowed.slice(0, 5);
    const hiddenTaskCount = tasks.length - visibleTasks.length;

    const allTerminal = running.length === 0 && tasks.length > 0;

    taskSection = (
      <Box flexDirection="column">
        <Box flexDirection="row" marginBottom={1}>
          <Text color={theme.ui.active}>{`${ARROW_PROMPT} `}</Text>
          <Text bold color={theme.text.primary}>后台任务</Text>
          <Box flexGrow={1} />
          {running.length > 0 && (
            <Text color={theme.ui.active}>{`${running.length} 运行中`}</Text>
          )}
          {allTerminal && (
            <Text color={theme.status.success}>{`${tasks.length} 已完成`}</Text>
          )}
          {/* 截断提示：与任务清单区的 `…+N` 同格式，用户一眼看出"还有 N 条没显示" */}
          {hiddenTaskCount > 0 && <Text dimColor>{`  …+${hiddenTaskCount}`}</Text>}
        </Box>
        {!compactMode &&
          visibleTasks.map((task) => (
            <TaskRow key={task.id} task={task} maxContentLen={maxContentLen} />
          ))}
        {/* 划掉提示（渐进衰减）：面板全是终态条目时，告知用户有手动出口，
            不必干等驱逐缓冲期。只在 allTerminal 时提示——还有任务在跑时
            Ctrl+X 也只清终态，但此刻用户的注意力在"还在跑的那条"上，提示是噪音。 */}
        {!compactMode && allTerminal && showDismissHint && (
          <Box marginTop={1}>
            <Text dimColor>{`${dismissDisplay} 划掉已完成`}</Text>
          </Box>
        )}
      </Box>
    );
  }

  // ── 拼装显示 ──
  return (
    <Box flexDirection="column" paddingLeft={1} marginTop={1} marginBottom={1}>
      {todoSection}
      {hasTodos && hasTasks && <Box height={1} /> /* 分隔间距 */}
      {taskSection}
    </Box>
  );
});
