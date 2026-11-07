/**
 * 定时唤醒消息组件（`_meta.origin = "scheduled-prompt"`）
 *
 * 渲染 `schedule_wakeup` / `/loop` / `cron_create` 到点后注入的这一轮。
 *
 * ## 为什么不能复用 UserMessage
 *
 * 这条**不是用户敲的**。改动前它渲染成 `> …`，用户看到的是「没人说话，agent 自己开始
 * 干活」——2026-11-07 的会话里用户的反应是「这根本就不是用户输入的话，不知道从哪里冒出来
 * 的」。走专用渲染后，与真实用户输入靠**两个通道**区分（L2.1 双通道）：
 *   字形 `›`（ARROW_PROMPT）vs `>`（USER_PROMPT）
 *   颜色 `theme.text.secondary` vs 正文色
 *
 * ## 视觉约束（src/ui/CLAUDE.md）
 *
 * - 字形从 `figures.ts` 取，不用 emoji（L1.1）
 * - 单行、不加边框、`paddingLeft` 与其它消息对齐（L2.2 / L2.3）
 * - 宽度用 `stringWidth` 算，不用 `.length`（CJK 下会漂，L2.3）
 * - 文案只给「是谁触发的 + 干了什么」，详情由模型这一轮的回复体现
 */

import React from "react";
import { Box } from "../../render-port/components.ts";
import { Text } from "../../render-port/components.ts";
import { theme } from "../../semantic-colors.ts";
import { stringWidth } from "../../render-port/text.ts";
import { ARROW_PROMPT } from "../../constants/figures.ts";
import { describeScheduledOrigin } from "@sid-code/core/query/scheduled-prompt.ts";

interface ScheduledPromptMessageProps {
  /** 触发它的定时任务 id */
  taskId: string;
  /** 任务来源：loop / cron_create / schedule_wakeup / unknown */
  origin: string;
  /** 原始 prompt 首行（不含引擎拼的来源头） */
  preview: string;
  /** 终端宽度（用于把预览截成一行） */
  width: number;
}

/**
 * 按终端列宽截断（CJK 按 2 列算），超出时末尾补 `…`。
 *
 * 不用 `text.slice(0, n)`：那按码点切，中文会被切成半个字宽的行，
 * 换行后右侧参差（L2.3 记过的坑）。
 */
function truncateToWidth(text: string, maxWidth: number): string {
  if (maxWidth <= 0) return "";
  if (stringWidth(text) <= maxWidth) return text;
  const ELLIPSIS = "…";
  const budget = maxWidth - stringWidth(ELLIPSIS);
  if (budget <= 0) return ELLIPSIS;
  let out = "";
  let used = 0;
  // for...of 按码点迭代，避免切坏代理对（emoji 在 prompt 里也常见）
  for (const ch of text) {
    const w = stringWidth(ch);
    if (used + w > budget) break;
    out += ch;
    used += w;
  }
  return `${out}${ELLIPSIS}`;
}

export const ScheduledPromptMessage: React.FC<ScheduledPromptMessageProps> = ({
  taskId,
  origin,
  preview,
  width,
}) => {
  const prefix = `${ARROW_PROMPT} `;
  const prefixWidth = stringWidth(prefix);
  // 标签走共享函数：origin=loop 显示「/loop 定时任务」，与来源头文案同源，
  // 两处各写一套措辞迟早漂移。TUI 恒中文（language 传 undefined → 默认中文）。
  const label = describeScheduledOrigin(
    origin === "loop" || origin === "cron_create" || origin === "schedule_wakeup"
      ? origin
      : "unknown",
    undefined,
  );
  const head = taskId ? `${label} · ${taskId}` : label;
  // 单行：label + id + 预览首行。预留 2 列避免恰好卡在行尾时终端多折一行。
  const body = truncateToWidth(`${head} · ${preview}`, Math.max(0, width - prefixWidth - 2));

  return (
    <Box flexDirection="row" marginBottom={1} paddingLeft={0} alignSelf="flex-start" width={width}>
      <Box width={prefixWidth} flexShrink={0}>
        <Text color={theme.text.secondary}>{prefix}</Text>
      </Box>
      <Box flexGrow={1}>
        <Text wrap="truncate-end" color={theme.text.secondary}>
          {body}
        </Text>
      </Box>
    </Box>
  );
};
