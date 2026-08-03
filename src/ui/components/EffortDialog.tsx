/**
 * 推理强度快捷切换面板（/effort 无参时打开）
 *
 * 选项固定（low/medium/high/xhigh/max/auto），无外部数据，用轻量 Dialog + RadioButtonSelect。
 * - 当前生效档位用 ● 标记（区别于光标指示的 ›）
 * - 每档用 ▁▃▅▇█ 柱状字形表达强度递进（元原则①：同族填充度递进）
 * - 底部 hint 提示 -p 持久化
 */

import React from "react";
import Box from "../../ink/components/Box.js";
import Text from "../../ink/components/Text.js";
import { theme } from "../semantic-colors.ts";
import { BaseSelectionList, type SelectionListItem } from "./shared/BaseSelectionList.tsx";
import {
  ARROW_PROMPT,
  TODO_COMPLETED,
  EFFORT_LOW,
  EFFORT_MEDIUM,
  EFFORT_HIGH,
  EFFORT_XHIGH,
  EFFORT_MAX,
  EFFORT_AUTO,
} from "../constants/figures.ts";
import { useKeypress, KeypressPriority, type Key } from "../contexts/KeypressContext.tsx";
import { getSelectableEfforts, type EffortLevel, type EffortSetting } from "../../llm/effort.ts";

interface EffortState {
  runtime: EffortSetting;
  applied: import("../../llm/effort.ts").EffortLevel | undefined;
  isAuto: boolean;
  capability: import("../../llm/effort.ts").EffortCapability;
}

interface EffortDialogProps {
  onClose: () => void;
  getEffortState?: () => EffortState;
  setEffort?: (level: EffortSetting, persist?: boolean) => void;
}

// value: "auto" 代表 undefined（跟随默认）
interface EffortItem extends SelectionListItem<string> {
  glyph: string;
  label: string;
  desc: string;
}

/** 全量档位元数据（展示文案 + 字形）。实际列出哪几档由模型能力决定，见 buildOptions。 */
const LEVEL_META: Record<EffortLevel, { glyph: string; desc: string }> = {
  low: { glyph: EFFORT_LOW, desc: "快速响应，跳过深度推理" },
  medium: { glyph: EFFORT_MEDIUM, desc: "平衡模式" },
  high: { glyph: EFFORT_HIGH, desc: "深度推理（多数模型默认）" },
  xhigh: { glyph: EFFORT_XHIGH, desc: "更深推理（介于 high 与 max）" },
  max: { glyph: EFFORT_MAX, desc: "最大推理深度" },
};

/**
 * 按当前模型**真实可选**的档位构建选项（+ 末尾固定的 auto）。
 *
 * 此前这里是写死的 5 档常量，与模型无关——于是 o-series 上会列出它压根没有的 xhigh/max，
 * 用户选了被静默钳制成 high（面板显示 max、实发 high）。改为读 getSelectableEfforts，
 * 档位列表与模型一一配对；auto 始终保留（它是"不下发、跟随模型默认"，任何模型都成立）。
 */
export function buildOptions(levels: EffortLevel[]): EffortItem[] {
  const items: EffortItem[] = levels.map((lv) => ({
    value: lv,
    key: lv,
    glyph: LEVEL_META[lv].glyph,
    label: lv,
    desc: LEVEL_META[lv].desc,
  }));
  items.push({ value: "auto", key: "auto", glyph: EFFORT_AUTO, label: "auto", desc: "跟随模型默认" });
  return items;
}

export const EffortDialog: React.FC<EffortDialogProps> = ({ onClose, getEffortState, setEffort }) => {
  useKeypress(KeypressPriority.Critical, (key: Key) => {
    if (key.name === "escape") {
      onClose();
      return true;
    }
    return false;
  });

  const state = getEffortState?.();

  // 能力门控：模型不支持档位切换时直接说明
  if (state && !state.capability.supportsEffort) {
    return (
      <Box flexDirection="column" borderStyle="round" borderColor={theme.ui.active} paddingX={1} paddingY={0}>
        <Text bold color={theme.ui.active}>推理强度</Text>
        <Box marginTop={1}>
          <Text color={theme.text.secondary}>
            当前模型不支持推理强度档位切换（无 reasoning_effort / thinking budget 能力）。
          </Text>
        </Box>
        <Box marginTop={1}>
          <Text dimColor italic>Esc 关闭</Text>
        </Box>
      </Box>
    );
  }

  // 档位列表按当前模型能力生成（不再是写死的 5 档）。state 缺失时给全量，保持旧兜底行为。
  const levels: EffortLevel[] = state
    ? getSelectableEfforts(state.capability)
    : ["low", "medium", "high", "xhigh", "max"];
  const options = buildOptions(levels);

  // 当前生效档位（auto 时用 "auto"）
  const currentValue = state?.runtime ?? "auto";
  const initialIndex = Math.max(0, options.findIndex((o) => o.value === currentValue));

  // 当前状态描述行
  let statusLine = "";
  if (state) {
    const runtimeText = state.runtime ?? "auto";
    if (state.isAuto) {
      statusLine = `当前: auto → ${state.applied}（跟随模型默认）`;
    } else {
      statusLine = `当前: ${runtimeText}`;
    }
  }
  // 直接告知「本模型支持哪几档」，比原来的「支持 max: 是/否」信息量更大：
  // 用户一眼能看出列表为何只有 3 档，而不是怀疑面板少了东西。
  const levelsLine = state ? `本模型可选档位: ${levels.join(" / ")} / auto` : "";

  const handleSelect = (value: string) => {
    const setting: EffortSetting = value === "auto" ? undefined : (value as EffortSetting);
    setEffort?.(setting);
    onClose();
  };

  return (
    <Box flexDirection="column" borderStyle="round" borderColor={theme.ui.active} paddingX={1} paddingY={0}>
      <Text bold color={theme.ui.active}>推理强度</Text>
      {statusLine && <Text color={theme.text.secondary}>{statusLine}</Text>}
      {levelsLine && <Text color={theme.text.secondary}>{levelsLine}</Text>}
      <Box marginTop={1} flexDirection="column">
        <BaseSelectionList<string, EffortItem>
          items={options}
          initialIndex={initialIndex}
          onSelect={handleSelect}
          isFocused={true}
          showNumbers={false}
          maxItemsToShow={8}
          selectedIndicator={ARROW_PROMPT}
          renderItem={(item, { isSelected }) => {
            const isCurrent = item.value === currentValue;
            return (
              <Box>
                <Text color={isSelected ? theme.ui.focus : theme.text.primary}>
                  {item.glyph} {item.label}
                </Text>
                <Text color={theme.text.secondary}>  {item.desc}</Text>
                {isCurrent && <Text color={theme.ui.active}> {TODO_COMPLETED} 当前</Text>}
              </Box>
            );
          }}
        />
      </Box>
      <Box marginTop={1}>
        <Text dimColor italic>↑↓ 导航 · Enter 切换 · Esc 取消（持久化用 /effort &lt;档位&gt; -p）</Text>
      </Box>
    </Box>
  );
};
