/**
 * 会话回退选择器（P2-1，对标 claude-code 的 Esc+Esc rewind/checkpoint）
 *
 * 两阶段交互：
 *   阶段 1（选点）：列出最近 N 个回退点（每点 = 一轮用户输入前的锚点），↑↓ 选、Enter 进入阶段 2。
 *   阶段 2（选模式）：对选中的点选择回退范围——
 *     - 仅对话：截断对话到该轮之前（不动文件）。
 *     - 对话+代码：额外把文件回滚到该轮登记时的快照（无快照则自动降级为仅对话）。
 *
 * Esc：阶段 2 退回阶段 1；阶段 1 关闭面板。
 * 回退执行后短暂回显结果（丢弃多少消息 / 回滚多少文件）再关闭。
 */

import React, { useState } from "react";
import Box from "@sid-code/tui-renderer/components/Box.tsx";
import Text from "@sid-code/tui-renderer/components/Text.tsx";
import { theme } from "../semantic-colors.ts";
import { BaseSelectionList, type SelectionListItem } from "./shared/BaseSelectionList.tsx";
import { ARROW_PROMPT } from "../constants/figures.ts";
import { useKeypress, KeypressPriority, type Key } from "../contexts/KeypressContext.tsx";
import type { RewindPointInfo, RewindResultInfo, RewindUIMode } from "../App.tsx";

interface RewindDialogProps {
  onClose: () => void;
  getRewindPoints?: () => RewindPointInfo[];
  onRewind?: (id: number, mode: RewindUIMode) => Promise<RewindResultInfo | null>;
}

interface PointItem extends SelectionListItem<number> {
  point: RewindPointInfo;
}

type ModeValue = RewindUIMode;

/** 模式中文标签（结果回显用，与选项 label 同源避免两处漂移）。 */
const MODE_LABELS: Record<RewindUIMode, string> = {
  code: "仅代码",
  conversation: "仅对话",
  "conversation-and-code": "对话 + 代码",
};
interface ModeItem extends SelectionListItem<ModeValue> {
  label: string;
  desc: string;
}

/** 相对时间格式化（简短，秒/分/时前）。 */
function formatRelative(ts: number, now: number): string {
  const sec = Math.max(0, Math.floor((now - ts) / 1000));
  if (sec < 60) return `${sec}s 前`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m 前`;
  const hr = Math.floor(min / 60);
  return `${hr}h 前`;
}

export const RewindDialog: React.FC<RewindDialogProps> = ({ onClose, getRewindPoints, onRewind }) => {
  const points = getRewindPoints?.() ?? [];
  // 阶段：选点 → 选模式 → 回显结果。
  const [selectedPoint, setSelectedPoint] = useState<RewindPointInfo | null>(null);
  const [result, setResult] = useState<RewindResultInfo | null>(null);
  const [busy, setBusy] = useState(false);
  const now = Date.now();

  useKeypress(KeypressPriority.Critical, (key: Key) => {
    if (busy) return true; // 回退执行中吞键，防重入
    if (key.name === "escape") {
      if (selectedPoint) {
        // 阶段 2 → 退回阶段 1
        setSelectedPoint(null);
      } else {
        onClose();
      }
      return true;
    }
    return false;
  });

  // 无回退点：直接说明并允许 Esc 关闭。
  if (points.length === 0) {
    return (
      <Box flexDirection="column" borderStyle="round" borderColor={theme.ui.active} paddingX={1} paddingY={0}>
        <Text bold color={theme.ui.active}>会话回退</Text>
        <Box marginTop={1}>
          <Text color={theme.text.secondary}>暂无可回退的历史轮次。</Text>
        </Box>
        <Box marginTop={1}>
          <Text italic>Esc 关闭</Text>
        </Box>
      </Box>
    );
  }

  // 回退结果回显。
  if (result) {
    const modeText = MODE_LABELS[result.mode];
    const touchedCode = result.mode === "code" || result.mode === "conversation-and-code";
    const touchedConversation = result.mode !== "code";
    return (
      <Box flexDirection="column" borderStyle="round" borderColor={theme.status.success} paddingX={1} paddingY={0}>
        <Text bold color={theme.status.success}>已回退（{modeText}）</Text>
        <Box marginTop={1} flexDirection="column">
          {touchedConversation && (
            <Text color={theme.text.secondary}>丢弃了 {result.messagesDropped} 条消息</Text>
          )}
          {touchedCode && (
            result.fileRestoreSkipped
              ? (
                <Text color={theme.status.warning}>
                  {touchedConversation ? "无文件快照可回滚（仅回退了对话）" : "无文件快照可回滚（未做任何改动）"}
                </Text>
              )
              : <Text color={theme.text.secondary}>回滚了 {result.filesRestored} 个文件</Text>
          )}
        </Box>
        <Box marginTop={1}>
          <Text italic>Esc 关闭</Text>
        </Box>
      </Box>
    );
  }

  // 阶段 2：模式选择。
  if (selectedPoint) {
    // 三档（对齐 CC Esc+Esc 菜单）：代码 / 对话 / 两者。
    // 「仅代码」放第一档——最常用：留着上下文不重说，只撤销模型改坏的文件。
    const modeItems: ModeItem[] = [
      {
        value: "code",
        key: "code-only",
        label: "仅代码",
        desc: selectedPoint.hasSnapshot ? "只把文件回滚到该轮快照，保留对话" : "该轮无文件快照，无可回滚内容",
      },
      { value: "conversation", key: "conv", label: "仅对话", desc: "截断对话到该轮之前，不动文件" },
      {
        value: "conversation-and-code",
        key: "both",
        label: "对话 + 代码",
        desc: selectedPoint.hasSnapshot ? "同时把文件回滚到该轮快照" : "该轮无文件快照，将仅回退对话",
      },
    ];
    const handleModeSelect = async (mode: ModeValue) => {
      if (!onRewind) { onClose(); return; }
      setBusy(true);
      try {
        const r = await onRewind(selectedPoint.id, mode);
        if (r) setResult(r);
        else onClose(); // 点已失效
      } catch {
        onClose();
      } finally {
        setBusy(false);
      }
    };
    return (
      <Box flexDirection="column" borderStyle="round" borderColor={theme.ui.active} paddingX={1} paddingY={0}>
        <Text bold color={theme.ui.active}>回退范围</Text>
        <Text color={theme.text.secondary} wrap="truncate-end">
          目标轮次: {selectedPoint.inputPreview || "(空输入)"}
        </Text>
        <Box marginTop={1} flexDirection="column">
          <BaseSelectionList<ModeValue, ModeItem>
            items={modeItems}
            initialIndex={0}
            onSelect={handleModeSelect}
            isFocused={!busy}
            showNumbers={false}
            maxItemsToShow={modeItems.length}
            selectedIndicator={ARROW_PROMPT}
            renderItem={(item, { isSelected }) => (
              <Box>
                <Text color={isSelected ? theme.ui.focus : theme.text.primary}>{item.label}</Text>
                <Text color={theme.text.secondary}>  {item.desc}</Text>
              </Box>
            )}
          />
        </Box>
        <Box marginTop={1}>
          <Text italic>{busy ? "回退中…" : "↑↓ 导航 · Enter 确认 · Esc 返回"}</Text>
        </Box>
      </Box>
    );
  }

  // 阶段 1：回退点选择。
  const pointItems: PointItem[] = points.map((p) => ({
    value: p.id,
    key: String(p.id),
    point: p,
  }));
  const handlePointSelect = (id: number) => {
    const p = points.find((x) => x.id === id);
    if (p) setSelectedPoint(p);
  };
  return (
    <Box flexDirection="column" borderStyle="round" borderColor={theme.ui.active} paddingX={1} paddingY={0}>
      <Text bold color={theme.ui.active}>会话回退</Text>
      <Text color={theme.text.secondary}>选择回退到哪一轮之前（最新在上）</Text>
      <Box marginTop={1} flexDirection="column">
        <BaseSelectionList<number, PointItem>
          items={pointItems}
          initialIndex={0}
          onSelect={handlePointSelect}
          isFocused={true}
          showNumbers={false}
          maxItemsToShow={10}
          selectedIndicator={ARROW_PROMPT}
          renderItem={(item, { isSelected }) => {
            const p = item.point;
            return (
              <Box>
                <Text color={isSelected ? theme.ui.focus : theme.text.primary} wrap="truncate-end">
                  {p.inputPreview || "(空输入)"}
                </Text>
                <Text color={theme.text.secondary}>  {formatRelative(p.timestamp, now)}</Text>
                {p.hasSnapshot && <Text color={theme.text.secondary}> · 有快照</Text>}
              </Box>
            );
          }}
        />
      </Box>
      <Box marginTop={1}>
        <Text italic>↑↓ 导航 · Enter 选择 · Esc 取消</Text>
      </Box>
    </Box>
  );
};
