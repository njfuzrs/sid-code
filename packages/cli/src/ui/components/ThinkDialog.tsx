/**
 * 思考模式快捷切换面板（/think 无参时打开）
 *
 * 选项固定（on/auto/off），结构同 EffortDialog 更简单。
 * - 当前生效项用 ● 标记
 * - 每项后面的「→ xxx」= 选它之后 Footer 会显示的词，与 Footer 同源（utils/thinking-label.ts），
 *   两处说法不会再对不上。恒思考模型上 off 项标「本模型无效」（意图仍会保存，切到可关模型后生效）。
 */

import React from "react";
import { Box } from "../render-port/components.ts";
import { Text } from "../render-port/components.ts";
import { theme } from "../semantic-colors.ts";
import { BaseSelectionList, type SelectionListItem } from "./shared/BaseSelectionList.tsx";
import { ARROW_PROMPT, TODO_COMPLETED } from "../constants/figures.ts";
import { thinkingLabelForSetting, type ThinkingTone } from "../utils/thinking-label.ts";
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
  label: string;
  desc: string;
}

const OPTIONS: ThinkItem[] = [
  { value: "on", key: "on", label: "on", desc: "强制开启扩展思考" },
  // auto 取的是模型默认（effort.ts resolveThinkingState 的 cap.thinkingDefaultOn），与 effort 无关；
  // 此前文案写「跟随 effort 设置」是错的。
  { value: "auto", key: "auto", label: "auto", desc: "跟随模型默认" },
  { value: "off", key: "off", label: "off", desc: "关闭扩展思考" },
];

const toSetting = (value: string): ThinkingSetting =>
  value === "auto" ? undefined : (value as ThinkingSetting);

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
            当前模型没有独立的思考开关，推理深度由 /effort 控制（思考行为由模型自身决定）。
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

  const cap = state?.capability;
  const locked = cap?.thinkingControl === "locked-on";
  // 状态行显示的就是 Footer 当前那个词（同一函数算），不再另写一套「auto → on」。
  let statusLine = "";
  if (state && cap) {
    const now = thinkingLabelForSetting(cap, state.runtime);
    statusLine = locked
      ? `当前: ${now.text}（恒思考模型，关不掉；切到可关闭的模型后 off 生效）`
      : `当前: ${now.text}`;
  }

  const toneColor = (tone: ThinkingTone) =>
    tone === "active"
      ? theme.status.success
      : tone === "warn"
        ? theme.status.warning
        : theme.text.secondary;

  const handleSelect = (value: string) => {
    setThinking?.(toSetting(value));
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
            const preview = cap ? thinkingLabelForSetting(cap, toSetting(item.value)) : null;
            // 恒思考模型上 off 不生效：选项本身置灰，预览词转警告色并写明原因。
            const ineffective = locked && item.value === "off";
            return (
              <Box>
                <Text
                  color={
                    isSelected
                      ? theme.ui.focus
                      : ineffective
                        ? theme.text.secondary
                        : theme.text.primary
                  }
                >
                  {item.label.padEnd(4)}
                </Text>
                <Text color={theme.text.secondary}> {item.desc}</Text>
                {preview && (
                  <Text color={toneColor(preview.tone)}>
                    {" "}
                    → {preview.text}
                    {ineffective ? "（本模型无效）" : ""}
                  </Text>
                )}
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
