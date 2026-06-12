/**
 * TodoPanel — TUI 任务清单面板
 *
 * 在输入框上方实时显示：
 * 1. TodoWrite 工具的当前任务清单进度（已有）
 * 2. 后台 Shell/Agent 任务状态（新增，对标 cc TaskListV2）
 *
 * fix_type: new_module（§0.3 L≥3 流程）
 */

import React from "react";
import Box from "../../ink/components/Box.js";
import Text from "../../ink/components/Text.js";
import type { TodoItem } from "../../tool/todo-write.ts";
import type { TaskDisplayInfo } from "../App.tsx";
import { theme } from "../semantic-colors.ts";

interface TodoPanelProps {
  todos: TodoItem[];
  /** 后台任务列表 */
  tasks: TaskDisplayInfo[];
  /** 终端宽度，用于截断长文本 */
  termWidth: number;
  /** 最大显示行数，超出则截断 */
  maxDisplay?: number;
}

/** 截断文本到指定宽度 */
function truncate(text: string, maxLen: number): string {
  if (text.length <= maxLen) return text;
  return text.slice(0, maxLen - 1) + "…";
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

/** 单条 todo 渲染 */
const TodoRow = React.memo(function TodoRow({
  item,
  index,
  maxContentLen,
}: {
  item: TodoItem;
  index: number;
  maxContentLen: number;
}) {
  const icon =
    item.status === "completed" ? "✅" :
    item.status === "in_progress" ? "🔄" :
    "⬜";
  const color =
    item.status === "completed" ? theme.text.secondary :
    item.status === "in_progress" ? theme.status.info :
    theme.text.secondary;

  return (
    <Box flexDirection="row">
      <Text dimColor={item.status === "completed"}>
        <Text color={color} bold={item.status === "in_progress"}>
          {icon}
        </Text>
        {" "}
        {truncate(item.content, maxContentLen)}
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
  const statusIcon =
    task.status === "completed" ? "✅" :
    task.status === "failed" ? "❌" :
    task.status === "killed" ? "🛑" :
    "⏳";
  const statusColor =
    task.status === "completed" ? theme.text.secondary :
    task.status === "failed" ? theme.status.error :
    task.status === "killed" ? theme.status.warning :
    theme.status.info;
  const isRunning = task.status === "running";

  const label = task.type === "local_agent" && task.agentType
    ? `AG ${task.agentType}`
    : task.type === "local_shell"
    ? "SH"
    : task.type;

  const desc = task.description || (task.type === "local_shell" && task.command
    ? truncate(task.command, 40)
    : "");

  const progressText = isRunning && task.progress
    ? ` (${task.progress.toolUseCount}t/${task.progress.tokenCount}tk)`
    : "";

  const durationText = ` ${formatDuration(task.durationMs)}`;

  const summaryLine = task.progressSummary
    ? task.progressSummary
    : null;

  return (
    <Box flexDirection="column">
      <Box flexDirection="row">
        <Text dimColor={!isRunning}>
          <Text color={statusColor} bold={isRunning}>{statusIcon}</Text>
          <Text dimColor> [{label}]</Text>
          {" "}
          <Text dimColor={!isRunning}>
            {truncate(desc, maxContentLen - 25)}
          </Text>
          <Text dimColor>{progressText}{durationText}</Text>
        </Text>
      </Box>
      {summaryLine && (
        <Box flexDirection="row" paddingLeft={4}>
          <Text dimColor>{truncate(summaryLine, maxContentLen - 4)}</Text>
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
        <Box flexDirection="row">
          <Text bold>📋 任务</Text>
          <Text dimColor>
            {" "}({completed}/{total})
          </Text>
          {inProgress > 0 && (
            <Text color={theme.status.info}> 🔄{inProgress}</Text>
          )}
          {hiddenCount > 0 && (
            <Text dimColor> …+{hiddenCount}</Text>
          )}
        </Box>
        {!compactMode && visibleTodos.map((item, i) => (
          <TodoRow
            key={i}
            item={item}
            index={i}
            maxContentLen={maxContentLen}
          />
        ))}
      </Box>
    );
  }

  // ── 后台任务部分 ──
  let taskSection: React.ReactNode = null;
  if (hasTasks) {
    // 只显示非终态任务 + 最近完成的
    const running = tasks.filter(t => t.status === "running");
    const terminal = tasks.filter(t => t.status !== "running");
    // 优先显示运行中，最多展示最近 3 个终态
    const visibleTasks = [...running, ...terminal.slice(-3)];

    taskSection = (
      <Box flexDirection="column">
        <Box flexDirection="row">
          <Text bold>⚙️ 后台</Text>
          {running.length > 0 && (
            <Text dimColor> ({running.length} 运行中)</Text>
          )}
          {running.length === 0 && tasks.length > 0 && (
            <Text dimColor> ({tasks.length} 已完成)</Text>
          )}
        </Box>
        {!compactMode && visibleTasks.slice(0, 5).map((task) => (
          <TaskRow
            key={task.id}
            task={task}
            maxContentLen={maxContentLen}
          />
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
