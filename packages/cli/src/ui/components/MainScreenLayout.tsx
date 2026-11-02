/**
 * 主屏渲染布局（ADR-040，默认模式）
 *
 * 对标 claude-code 外部用户默认 REPL：
 * - 已完成历史用 Ink <Static> 一次性打印进终端 scrollback（print-and-forget），
 *   落入终端真实行缓冲 → 边流式边可用鼠标原生选中复制、原生无限滚动。
 * - 仅"正在生成的流式消息 + 输入框 + 状态栏/对话框"留在小动态区（log-update 只重绘这几行）。
 * - 不设固定 height / 不 overflow hidden：内容自然纵向增长，旧行滚出进终端 scrollback。
 *
 * 与 DefaultAppLayout（--alternate-buffer 全屏虚拟滚动）互斥；不抢鼠标、无 Copy Mode。
 * 底部区域与全屏布局共享 BottomRegion，本文件只保留消息区（Static 历史 + 流式思考/正文）。
 */

import React, { memo } from "react";
import { Box } from "../render-port/components.ts";
import { Static } from "../render-port/components.ts";
import { HistoryItemDisplay } from "./HistoryItemDisplay.tsx";
import { StreamingMessage } from "./StreamingMessage.tsx";
import { ThinkingMessage } from "./messages/ThinkingMessage.tsx";
import { EmptyLogo } from "./EmptyLogo.tsx";
import { BottomRegion, type BottomRegionSharedProps } from "./BottomRegion.tsx";
import type { HistoryItem } from "../types.ts";

interface MainScreenLayoutProps extends Omit<BottomRegionSharedProps, "scrollPercent"> {
  /**
   * 全部历史项（含 app_header + 执行中的 tool_group，但不含流式虚拟项）；进 <Static> 打印到 scrollback。
   * 执行中工具作为普通 tool_group 直接在此列表，完成时原地 reconcile 成终态（对齐 cc inline 路）。
   * 不做静动拆分/视口封顶（那套自创缝补已删除，见 App.tsx staticItems 注释与根治方案 §6.3）。
   */
  staticItems: HistoryItem[];
  /** 流式输出文本 */
  streamingText: string;
  /** v2：流式思考内容（独立于 streamingText） */
  streamingThinking: string;
  /** v2：流式思考开始时间戳（ms），透传给 ThinkingMessage 计时器 */
  streamingThinkingStartMs?: number;
  /** v2：思考块折叠状态（Static 模式始终 false） */
  thinkCollapsed: boolean;
  /** 是否正在流式输出 */
  isStreaming: boolean;
  /** key 提取器（供 Static 子项 key） */
  keyExtractor: (item: HistoryItem, index: number) => string;
  /** 仍未完成首次配置（向导关掉后 EmptyLogo 常驻引导行） */
  needsOnboarding?: boolean;
}

export const MainScreenLayout: React.FC<MainScreenLayoutProps> = memo(function MainScreenLayout({
  staticItems,
  streamingText,
  streamingThinking,
  streamingThinkingStartMs,
  thinkCollapsed,
  isStreaming,
  keyExtractor,
  needsOnboarding,
  ...bottom
}) {
  const { isEmpty, termWidth, cwd, gitBranch, model, activeDialog } = bottom;
  // 流式正文**不做视口裁剪**：渲染完整 streamingText，靠 StreamingMarkdown 的
  // 稳定前缀切分 + log-update fork 的增量增长路径防闪烁（见 StreamingMarkdown.tsx）。
  // 旧的 tailToFitByBlocks 视口窗口已废弃——那是 stock ink 时代的 workaround，
  // 导致流式中只见尾部一小段。完成后整条进 <Static> → scrollback，原生上滚回看。
  const hasText = isStreaming && !!streamingText;
  const hasThinking = isStreaming && !!streamingThinking;
  // 思考恒折叠为单行摘要（对标 cc）：ThinkingMessage 内部只渲染一行摘要 + 字符数 + 实时计时，
  // 高度稳定、全程零跳动。把全文传给它即可，由它自行折叠。
  const thinkingCollapsed = true;

  return (
    // 根 Box 不设固定高度 / 不 overflow hidden：让内容顺序增长，Static 落 scrollback、动态区在末尾。
    <Box flexDirection="column" width={termWidth}>
      {/* 历史区：Static print-and-forget → 终端 scrollback（原生可选/可滚） */}
      <Static items={staticItems}>
        {(item: HistoryItem, index: number) => (
          <HistoryItemDisplay
            key={keyExtractor(item, index)}
            item={item}
            prevItem={index > 0 ? staticItems[index - 1] : undefined}
            terminalWidth={termWidth}
            thinkCollapsed={thinkCollapsed}
            thinkExpandable={false}
          />
        )}
      </Static>

      {/* 动态区（log-update 只重绘这部分，历史不动）：欢迎屏 / 流式思考 / 流式正文作为
          底部区域留白区的最前几块，与其后瞬态块、输入框统一由 gap 隔 1 行（见 BottomRegion）。 */}
      <BottomRegion
        {...bottom}
        paddingBottom={1}
        leading={
          <>
            {/* 空会话：欢迎屏（首条消息到达后即随 Static 滚走） */}
            {isEmpty ? (
              <EmptyLogo
                termWidth={termWidth}
                cwd={cwd}
                gitBranch={gitBranch}
                model={model}
                onboarding={
                  activeDialog === "onboarding" ? "open" : needsOnboarding ? "pending" : undefined
                }
              />
            ) : null}

            {/* 执行中工具不再单独渲染：作为普通 tool_group（status=executing）随 staticItems 进 Static，
                完成时原地 reconcile 成终态（对齐 cc inline 路「同一 keyed 行原地变态」）。此前的独立
                动态区 live 渲染 + 视口封顶摘要是自创缝补（治标，见根治方案 §6.3），已删除。 */}

            {/* v2：流式思考区域 — 独立于 streamingText（对标 Claude Code）
                思考在正文之前渲染（模型先思考后回答），顺序与语义一致。
                思考全程折叠为单行摘要（thinkingCollapsed 恒为 true），实时计时原地更新、
                高度恒定 → 页面零跳动；不再有「纯思考逐字展开 → 正文开始时塌缩」的高度突变。
                Static 模式 ctrl+o 无法重渲已打印项，故折叠态不显示展开提示（showExpandHint=false）。 */}
            {hasThinking && streamingThinking ? (
              <ThinkingMessage
                text={streamingThinking}
                width={termWidth}
                collapsed={thinkingCollapsed}
                streaming={isStreaming}
                thinkingStartMs={streamingThinkingStartMs}
                showExpandHint={false}
              />
            ) : null}

            {/* 正在生成的流式消息（完成后由父层并入 staticItems，此处清空）
                渲染完整 streamingText，不做视口裁剪；防闪烁由 StreamingMarkdown 的稳定前缀切分负责。 */}
            {hasText && streamingText ? (
              <StreamingMessage fullText={streamingText} maxWidth={termWidth} />
            ) : null}
          </>
        }
      />
    </Box>
  );
});
