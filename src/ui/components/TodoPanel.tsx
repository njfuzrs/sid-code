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

import React from "react";
import Box from "../../ink/components/Box.js";
import Text from "../../ink/components/Text.js";
import { useAnimationFrame } from "../../ink/hooks/use-animation-frame.js";
import type { TodoItem } from "../../tool/todo-write.ts";
import type { TaskDisplayInfo } from "../App.tsx";
import { theme } from "../semantic-colors.ts";
import { stringWidth } from "../../ink/stringWidth.js";
import { useIsAccessibilityEnabled } from "../accessibility/AccessibilityContext.tsx";
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

interface TodoPanelProps {
  todos: TodoItem[];
  /** 后台任务列表 */
  tasks: TaskDisplayInfo[];
  /** 终端宽度，用于截断长文本 */
  termWidth: number;
  /** 最大显示行数，超出则截断 */
  maxDisplay?: number;
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
      {activityLine && (
        <Box flexDirection="row" paddingLeft={2}>
          <Text color={theme.text.secondary} dimColor>{`${TREE_BRANCH} `}</Text>
          <Text color={theme.text.secondary} dimColor>{truncate(activityLine, maxContentLen - 6)}</Text>
        </Box>
      )}
    </Box>
  );
});

export const TodoPanel = React.memo(function TodoPanel({
  todos,
  tasks,
  termWidth,
  maxDisplay = 8,
}: TodoPanelProps) {
  const hasTodos = todos && todos.length > 0;
  const hasTasks = tasks && tasks.length > 0;
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
    const visibleTasks = [...running, ...terminal.slice(-3)];

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
        </Box>
        {!compactMode &&
          visibleTasks.slice(0, 5).map((task) => (
            <TaskRow key={task.id} task={task} maxContentLen={maxContentLen} />
          ))}
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
