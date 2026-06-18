/**
 * StreamingMarkdown —— 流式 markdown 渲染包装（对标 cc StreamingMarkdown）。
 *
 * 设计取舍（见 docs 改造方案 §3.3）：
 * sid-code 跑在 vendor 进来的 cc ink fork 上，但 log-update.ts 仍有
 * 「动态区高度 >= 视口 且 scrollback 行变化 → fullResetSequence_CAUSES_FLICKER」路径，
 * 所以「动态区高度必须 < 终端行数」这一防闪烁不变量依然成立。
 *
 * 因此流式正文先经块级窗口（tailToFitByBlocks，按 marked 块边界做高度预算，
 * 不打碎表格/代码块）裁出尾部可见内容，再交给本组件。本组件只负责把这段
 * 已裁好的文本用 MarkdownAnsi 渲染 —— 块级窗口已把解析成本约束到 O(视口)，
 * 替代了 cc「稳定前缀 useMemo 冻结 + 仅尾块重解析」的增量策略（两者目的一致：
 * 不让每个 delta 重解析全文）。配合 cachedLexer 的 token 缓存，重复内容零重算。
 */

import React from "react";
import { MarkdownAnsi } from "./MarkdownAnsi.tsx";

interface StreamingMarkdownProps {
  /** 已按视口高度做过块级尾部裁剪的可见文本 */
  text: string;
  /** 渲染宽度 */
  terminalWidth: number;
  /** 可用终端高度（代码块流式截断用） */
  availableTerminalHeight?: number;
}

const StreamingMarkdownInternal: React.FC<StreamingMarkdownProps> = ({
  text,
  terminalWidth,
  availableTerminalHeight,
}) => {
  if (!text) return null;
  return (
    <MarkdownAnsi
      text={text}
      isPending={true}
      availableTerminalHeight={availableTerminalHeight}
      terminalWidth={terminalWidth}
      renderMarkdown={true}
    />
  );
};

export const StreamingMarkdown = React.memo(StreamingMarkdownInternal);
