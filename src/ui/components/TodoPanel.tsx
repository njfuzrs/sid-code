/**
 * TodoPanel — TUI 任务清单面板
 *
 * 在输入框上方实时显示：
 * 1. TodoWrite 工具的当前任务清单进度
 * 2. 后台 Shell/Agent 任务状态（对标 cc TaskListV2）
 *
 * 视觉语言（对标 claude-code）：
 * - checkbox 用 ○◐● 几何字形族（填充度表达状态递进），不用彩色 emoji
 * - 完成态 strikethrough + dim，进行中 bold + 品牌色，待办常态
 * - 顶部一行极简进度条 ▰▱，进度一眼可见
 *
 * fix_type: behavior_change（视觉重构，§0.3）
 */

import React from "react";
import Box from "../../ink/components/Box.js";
import Text from "../../ink/components/Text.js";
import type { TodoItem } from "../../tool/todo-write.ts";
import type { TaskDisplayInfo } from "../App.tsx";
import { theme } from "../semantic-colors.ts";
import { stringWidth } from "../../ink/stringWidth.js";
import { formatLargeNumber } from "../utils/format-number.ts";
import {
  TODO_PENDING,
  TODO_IN_PROGRESS,
  TODO_COMPLETED,
  PROGRESS_FILLED,
  PROGRESS_EMPTY,
  ARROW_PROMPT,
  ERROR_MARK,
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

/** 格式化毫秒为人类可读的时长 */
function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const sec = Math.round(ms / 1000);
  if (sec < 60) return `${sec}s`;
  const min = Math.floor(sec / 60);
  const remainSec = sec % 60;
  return remainSec > 0 ? `${min}m${remainSec}s` : `${min}m`;
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

/** 单条后台任务渲染 */
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

  // 状态字形：运行中 ◐ / 完成 ● / 失败 ✘ / 终止 ●(警告色)
  const statusIcon = isRunning
    ? TODO_IN_PROGRESS
    : isFailed
    ? ERROR_MARK
    : isKilled
    ? TODO_COMPLETED
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
      : task.type;

  const desc =
    task.description ||
    (task.type === "local_shell" && task.command ? truncate(task.command, 40) : "");

  const progressText =
    isRunning && task.progress
      ? ` ${task.progress.toolUseCount}t·${formatLargeNumber(task.progress.tokenCount)}`
      : "";

  const durationText = ` ${formatDuration(task.durationMs)}`;

  const summaryLine = task.progressSummary ? task.progressSummary : null;

  return (
    <Box flexDirection="column">
      <Box flexDirection="row">
        <Box width={2} flexShrink={0}>
          <Text color={statusColor} bold={isRunning}>{statusIcon}</Text>
        </Box>
        <Text>
          <Text color={theme.ui.active} dimColor>{`[${label}] `}</Text>
          <Text color={isRunning ? theme.text.primary : theme.text.secondary} dimColor={!isRunning}>
            {truncate(desc, maxContentLen - 25)}
          </Text>
          <Text color={theme.text.secondary} dimColor>{progressText}{durationText}</Text>
        </Text>
      </Box>
      {summaryLine && (
        <Box flexDirection="row" paddingLeft={2}>
          <Text color={theme.text.secondary} dimColor>{truncate(summaryLine, maxContentLen - 4)}</Text>
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
    const inProgress = todos.filter((t) => t.status === "in_progress").length;
    const total = todos.length;

    let visibleTodos = todos;
    let hiddenCount = 0;
    const maxTodoDisplay = Math.min(maxDisplay, 6);
    if (!compactMode && todos.length > maxTodoDisplay) {
      const inProgressItems = todos.filter((t) => t.status === "in_progress");
      const pendingItems = todos.filter((t) => t.status === "pending");
      const completedItems = todos.filter((t) => t.status === "completed");
      const remainingSlots = maxTodoDisplay - inProgressItems.length;
      const pendingSlots = Math.min(pendingItems.length, Math.max(1, Math.floor(remainingSlots * 0.7)));
      const completedSlots = remainingSlots - pendingSlots;
      visibleTodos = [
        ...inProgressItems,
        ...pendingItems.slice(0, pendingSlots),
        ...completedItems.slice(-Math.max(0, completedSlots)),
      ];
      hiddenCount = total - visibleTodos.length;
    }

    todoSection = (
      <Box flexDirection="column">
        {/* 标题行：箭头引导 + 标题 + 进度条 + 计数 */}
        <Box flexDirection="row">
          <Text color={theme.ui.active}>{`${ARROW_PROMPT} `}</Text>
          <Text bold color={theme.text.primary}>任务</Text>
          <Text>{"  "}</Text>
          <ProgressBar completed={completed} total={total} />
          <Text color={theme.text.secondary}>{`  ${completed}/${total}`}</Text>
          {inProgress > 0 && (
            <Text color={theme.ui.active}>{`  ${TODO_IN_PROGRESS}${inProgress}`}</Text>
          )}
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

    taskSection = (
      <Box flexDirection="column">
        <Box flexDirection="row">
          <Text color={theme.ui.active}>{`${ARROW_PROMPT} `}</Text>
          <Text bold color={theme.text.primary}>后台</Text>
          {running.length > 0 && (
            <Text color={theme.text.secondary}>{`  ${running.length} 运行中`}</Text>
          )}
          {running.length === 0 && tasks.length > 0 && (
            <Text color={theme.text.secondary}>{`  ${tasks.length} 已完成`}</Text>
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
    <Box flexDirection="column" paddingLeft={1}>
      {todoSection}
      {hasTodos && hasTasks && <Box height={1} /> /* 分隔间距 */}
      {taskSection}
    </Box>
  );
});
