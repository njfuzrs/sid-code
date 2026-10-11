/**
 * Bridge 准入确认对话框（D14）
 *
 * `--bridge` 首次连某个端点时必须由本机的人确认（见 core/bridge/admission.ts）。
 * 此前这一步用 readline 在终端问 `继续吗？[y/N]`，与 TUI 里的其余审批框不是一套样式。
 * Bridge 模式本身不进主 TUI，所以这里用一个**只挂这一个对话框**的临时 TUI 实例来问，
 * 答完即卸载，再进入 Bridge 常驻循环（见 runBridgeAdmissionDialog）。
 *
 * 安全默认（src/ui/CLAUDE.md L4-E）：初始聚焦「拒绝」，Esc = 拒绝。
 */

import React from "react";
import { Box } from "../render-port/components.ts";
import { Text } from "../render-port/components.ts";
import { theme } from "../semantic-colors.ts";
import { BaseSelectionList, type SelectionListItem } from "./shared/BaseSelectionList.tsx";
import { ARROW_PROMPT } from "../constants/figures.ts";
import { useKeypress, KeypressPriority, type Key } from "../contexts/KeypressContext.tsx";

interface ChoiceItem extends SelectionListItem<boolean> {
  label: string;
  desc: string;
}

const OPTIONS: ChoiceItem[] = [
  { value: true, key: "yes", label: "是，允许该端点控制本机", desc: "记住这个地址，下次不再询问" },
  { value: false, key: "no", label: "拒绝", desc: "不连接并退出" },
];

interface Props {
  /** buildConfirmPrompt() 产出的说明文案（已剥掉 URL 里的 token） */
  message: string;
  onDecision: (allowed: boolean) => void;
}

export const BridgeAdmissionDialog: React.FC<Props> = ({ message, onDecision }) => {
  useKeypress(KeypressPriority.Critical, (key: Key) => {
    if (key.name === "escape") {
      onDecision(false);
      return true;
    }
    return false;
  });

  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor={theme.status.warning}
      paddingX={1}
      paddingY={0}
    >
      <Text bold color={theme.status.warning}>
        首次连接该 Bridge 端点
      </Text>
      <Box marginTop={1} flexDirection="column">
        {message.split("\n").map((line, i) => (
          <Text key={i} color={theme.text.secondary}>
            {line || " "}
          </Text>
        ))}
      </Box>
      <Box marginTop={1} flexDirection="column">
        <BaseSelectionList<boolean, ChoiceItem>
          items={OPTIONS}
          initialIndex={1}
          onSelect={(v) => onDecision(v)}
          isFocused={true}
          showNumbers={false}
          maxItemsToShow={2}
          selectedIndicator={ARROW_PROMPT}
          renderItem={(item, { isSelected }) => (
            <Box>
              <Text color={isSelected ? theme.ui.focus : theme.text.primary}>{item.label}</Text>
              <Text color={theme.text.secondary}> {item.desc}</Text>
            </Box>
          )}
        />
      </Box>
      <Box marginTop={1}>
        <Text italic>Esc 拒绝</Text>
      </Box>
    </Box>
  );
};
