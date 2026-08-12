/**
 * 思考模式快捷切换面板（/think 无参时打开）
 *
 * 选项固定（on/auto/off），结构同 EffortDialog 更简单。
 * - 当前生效项用 ● 标记
 * - on/off 用 ✻/✧ 同族字形，auto 用 ◌（未定）
 */

import React from "react";
import Box from "@sid-code/tui-renderer/components/Box.tsx";
import Text from "@sid-code/tui-renderer/components/Text.tsx";
import { theme } from "../semantic-colors.ts";
import { BaseSelectionList, type SelectionListItem } from "./shared/BaseSelectionList.tsx";
import {
  ARROW_PROMPT,
  TODO_COMPLETED,
  THINKING_ON,
  THINKING_OFF,
  EFFORT_AUTO,
} from "../constants/figures.ts";
import { useKeypress, KeypressPriority, type Key } from "../contexts/KeypressContext.tsx";
import type { ThinkingSetting } from "@sid-code/core/llm/effort.ts";

interface ThinkingState {
  runtime: ThinkingSetting;
  applied: boolean;
  capability: import("@sid-code/core/llm/effort.ts").EffortCapability;
}

interface ThinkDialogProps {
  onClose: () => void;
  getThinkingState?: () => ThinkingState;
  setThinking?: (setting: ThinkingSetting, persist?: boolean) => void;
}

// value: "auto" 代表 undefined（跟随默认）
interface ThinkItem extends SelectionListItem<string> {
  glyph: string;
  label: string;
  desc: string;
}

const OPTIONS: ThinkItem[] = [
  { value: "on", key: "on", glyph: THINKING_ON, label: "on", desc: "强制开启扩展思考" },
  {
    value: "auto",
    key: "auto",
    glyph: EFFORT_AUTO,
    label: "auto",
    desc: "跟随 effort 设置自动决定",
  },
  { value: "off", key: "off", glyph: THINKING_OFF, label: "off", desc: "关闭扩展思考" },
];

export const ThinkDialog: React.FC<ThinkDialogProps> = ({
  onClose,
  getThinkingState,
  setThinking,
}) => {
  useKeypress(KeypressPriority.Critical, (key: Key) => {
    if (key.name === "escape") {
      onClose();
      return true;
    }
    return false;
  });

  const state = getThinkingState?.();

  // 能力门控：模型不支持思考开关时直接说明
  if (state && !state.capability.supportsThinkingToggle) {
    return (
      <Box
        flexDirection="column"
        borderStyle="round"
        borderColor={theme.ui.active}
        paddingX={1}
        paddingY={0}
      >
        <Text bold color={theme.ui.active}>
          思考模式
        </Text>
        <Box marginTop={1}>
          <Text color={theme.text.secondary}>
            当前模型不支持显式思考开关（如内置推理模型）。思考行为由模型自身决定。
          </Text>
        </Box>
        <Box marginTop={1}>
          <Text italic>Esc 关闭</Text>
        </Box>
      </Box>
    );
  }

  const currentValue = state?.runtime ?? "auto";
  const initialIndex = Math.max(
    0,
    OPTIONS.findIndex((o) => o.value === currentValue),
  );

  let statusLine = "";
  if (state) {
    const runtimeText = state.runtime ?? "auto";
    if (state.runtime === undefined) {
      statusLine = `当前: auto → ${state.applied ? "on" : "off"}（跟随默认）`;
    } else {
      statusLine = `当前: ${runtimeText}`;
    }
  }

  const handleSelect = (value: string) => {
    const setting: ThinkingSetting = value === "auto" ? undefined : (value as ThinkingSetting);
    setThinking?.(setting);
    onClose();
  };

  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor={theme.ui.active}
      paddingX={1}
      paddingY={0}
    >
      <Text bold color={theme.ui.active}>
        思考模式
      </Text>
      {statusLine && <Text color={theme.text.secondary}>{statusLine}</Text>}
      <Box marginTop={1} flexDirection="column">
        <BaseSelectionList<string, ThinkItem>
          items={OPTIONS}
          initialIndex={initialIndex}
          onSelect={handleSelect}
          isFocused={true}
          showNumbers={false}
          maxItemsToShow={6}
          selectedIndicator={ARROW_PROMPT}
          renderItem={(item, { isSelected }) => {
            const isCurrent = item.value === currentValue;
            return (
              <Box>
                <Text color={isSelected ? theme.ui.focus : theme.text.primary}>
                  {item.glyph} {item.label}
                </Text>
                <Text color={theme.text.secondary}> {item.desc}</Text>
                {isCurrent && <Text color={theme.ui.active}> {TODO_COMPLETED} 当前</Text>}
              </Box>
            );
          }}
        />
      </Box>
      <Box marginTop={1}>
        <Text italic>↑↓ 导航 · Enter 切换 · Esc 取消</Text>
      </Box>
    </Box>
  );
};
