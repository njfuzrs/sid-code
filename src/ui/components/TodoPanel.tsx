/**
 * TodoPanel — TUI 任务清单面板
 *
 * 在输入框上方实时显示 TodoWrite 工具的当前任务清单进度。
 * 对标 Claude Code TaskListV2 的核心显示逻辑。
 *
 * fix_type: new_module（§0.3 L≥3 流程）
 */

import React from "react";
import { Box, Text } from "ink";
import type { TodoItem } from "../../tool/todo-write.ts";
import { theme } from "../semantic-colors.ts";

interface TodoPanelProps {
  todos: TodoItem[];
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

/** 单条任务渲染 */
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

export const TodoPanel = React.memo(function TodoPanel({
  todos,
  termWidth,
  maxDisplay = 8,
}: TodoPanelProps) {
  if (!todos || todos.length === 0) return null;

  const completed = todos.filter((t) => t.status === "completed").length;
  const inProgress = todos.filter((t) => t.status === "in_progress").length;
  const total = todos.length;

  // 紧凑模式：终端行数不足时只显示摘要行
  const compactMode = termWidth < 60 || maxDisplay === 0;

  // 截断：超过 maxDisplay 时只显示 in_progress + 最近完成的 + pending 头几条
  let visibleTodos = todos;
  let hiddenCount = 0;
  if (!compactMode && todos.length > maxDisplay) {
    const inProgressItems = todos.filter((t) => t.status === "in_progress");
    const pendingItems = todos.filter((t) => t.status === "pending");
    const completedItems = todos.filter((t) => t.status === "completed");
    // 优先：in_progress → pending 前几条 → completed 最后几条
    const remainingSlots = maxDisplay - inProgressItems.length;
    const pendingSlots = Math.min(pendingItems.length, Math.max(1, Math.floor(remainingSlots * 0.7)));
    const completedSlots = remainingSlots - pendingSlots;
    visibleTodos = [
      ...inProgressItems,
      ...pendingItems.slice(0, pendingSlots),
      ...completedItems.slice(-Math.max(0, completedSlots)),
    ];
    hiddenCount = total - visibleTodos.length;
  }

  // 每行最大内容宽度
  const maxContentLen = Math.max(20, compactMode ? termWidth - 16 : termWidth - 6);

  return (
    <Box flexDirection="column" paddingLeft={1}>
      {/* 摘要行 */}
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

      {/* 任务详情行 */}
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
});
