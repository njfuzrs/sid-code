/**
 * 模型选择对话框
 * 允许用户切换 LLM 模型
 *
 * 视觉对标 cc /model 面板：
 * - 当前模型用 ● + 品牌色标记（区别于光标指示的 ›）
 * - provider 标签右对齐成列（dim 色）
 * - description 作为 sublabel 展示
 */

import React from 'react';
import Box from "../../ink/components/Box.js";
import Text from "../../ink/components/Text.js";
import stringWidth from "string-width";
import { theme } from '../semantic-colors.ts';
import { BaseSelectionList, type SelectionListItem } from './shared/BaseSelectionList.tsx';
import { TODO_COMPLETED, ARROW_PROMPT, EFFORT_GLYPHS } from '../constants/figures.ts';
import { useKeypress, KeypressPriority, type Key } from '../contexts/KeypressContext.tsx';
import { EFFORT_LEVELS, type EffortLevel, type EffortSetting } from '../../llm/effort.ts';

interface ModelOption {
  name: string;
  provider: string;
  description?: string;
}

interface EffortState {
  runtime: EffortSetting;
  applied: EffortLevel | undefined;
  isAuto: boolean;
  capability: import("../../llm/effort.ts").EffortCapability;
}

interface ModelDialogProps {
  onClose: () => void;
  currentModel: string;
  availableModels: ModelOption[];
  onModelSelect: (modelName: string) => void;
  /** 读取当前 effort 运行时态 + 能力（P2-1 左右键调 effort 用）。缺省则不显示 effort 行。 */
  getEffortState?: () => EffortState;
  /** effort setter（P2-1 左右键实时调整）。persist 语义同 /effort。 */
  setEffort?: (level: EffortSetting, persist?: boolean) => void;
}

/**
 * P2-1：从当前 effort 档位循环到下一档（纯函数，便于单测）。
 * dir=1 右移（增强），dir=-1 左移（减弱），到边界环绕。
 * current 为 null/非法时以 high 兜底。
 */
export function cycleEffort(current: EffortLevel | undefined, dir: 1 | -1): EffortLevel {
  const idx = current ? EFFORT_LEVELS.indexOf(current) : -1;
  const base = idx < 0 ? EFFORT_LEVELS.indexOf('high') : idx;
  const nextIdx = (base + dir + EFFORT_LEVELS.length) % EFFORT_LEVELS.length;
  return EFFORT_LEVELS[nextIdx];
}

/** P2-1：从 effort 状态解析当前生效档位（auto 态取 applied 实际档位）。 */
export function resolveDisplayedEffort(state: EffortState | undefined): EffortLevel | undefined {
  if (!state) return undefined;
  return state.isAuto
    ? state.applied
    : ((state.runtime as EffortLevel | undefined) ?? state.applied);
}

interface ModelItem extends SelectionListItem<string> {
  name: string;
  provider: string;
  description?: string;
  isCurrent: boolean;
}

export const ModelDialog: React.FC<ModelDialogProps> = ({
  onClose,
  currentModel,
  availableModels,
  onModelSelect,
  getEffortState,
  setEffort,
}) => {
  const effortState = getEffortState?.();
  // 仅当模型支持档位切换且回调齐全时，才启用左右键调 effort。
  const effortEnabled = !!(effortState?.capability.supportsEffort && setEffort);

  // 左右方向键循环调整 effort（实时生效，仅当会话；选定模型后由 /effort -p 兜底持久化）。
  // 对齐 claude-code /model：←/→ 在 low→medium→high→xhigh→max 间循环。
  useKeypress(KeypressPriority.Critical, (key: Key) => {
    if (key.name === 'escape') {
      onClose();
      return true;
    }
    if (effortEnabled && (key.name === 'left' || key.name === 'right')) {
      // 以当前生效档位为基准（auto 态取 applied 实际档位）循环切换。
      const current = resolveDisplayedEffort(effortState);
      setEffort?.(cycleEffort(current, key.name === 'right' ? 1 : -1));
      return true;
    }
    return false;
  });

  const handleSelect = (modelName: string) => {
    onModelSelect(modelName);
    // 关闭由外部 onModelSelect 回调统一处理，不再重复调用 onClose
  };

  if (availableModels.length === 0) {
    return (
      <Box flexDirection="column" borderStyle="round" borderColor={theme.ui.active} paddingX={1} paddingY={0}>
        <Text bold color={theme.ui.active}>选择模型</Text>
        <Box marginTop={1}>
          <Text color={theme.text.secondary}>未配置可用模型</Text>
        </Box>
        <Text dimColor>在 ~/.sid-code/settings.json 的 availableModels 数组中添加模型</Text>
        <Box marginTop={1}>
          <Text dimColor italic>Esc 关闭</Text>
        </Box>
      </Box>
    );
  }

  const items: ModelItem[] = availableModels.map((m, i) => ({
    value: m.name,
    key: `model-${i}`,
    name: m.name,
    provider: m.provider,
    description: m.description,
    isCurrent: m.name === currentModel,
  }));

  const initialIndex = Math.max(0, items.findIndex(item => item.isCurrent));

  // 计算模型名列宽（用 stringWidth 处理 CJK/全角），让 provider 标签对齐成列
  const nameColWidth = Math.max(
    ...items.map(it => stringWidth(it.name)),
    0,
  );

  const currentOption = availableModels.find(m => m.name === currentModel);

  // effort 展示态：显示当前生效档位 + 字形；auto 态标注跟随默认。
  const effortDisplayLevel = resolveDisplayedEffort(effortState);

  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor={theme.ui.active}
      paddingX={1}
      paddingY={0}
    >
      <Box>
        <Text bold color={theme.ui.active}>选择模型</Text>
        <Text color={theme.text.secondary}> · {items.length} 个可用</Text>
      </Box>
      {currentOption && (
        <Text color={theme.text.secondary}>
          当前: {currentOption.name} ({currentOption.provider})
        </Text>
      )}
      {effortEnabled && effortDisplayLevel && (
        <Text color={theme.text.secondary}>
          推理强度: <Text color={theme.ui.active}>{EFFORT_GLYPHS[effortDisplayLevel]} {effortDisplayLevel}</Text>
          {effortState?.isAuto ? " (auto)" : ""}
          <Text dimColor> · ←/→ 调整</Text>
        </Text>
      )}
      <Box marginTop={1} flexDirection="column">
        <BaseSelectionList<string, ModelItem>
          items={items}
          initialIndex={initialIndex}
          onSelect={handleSelect}
          isFocused={true}
          showNumbers={false}
          maxItemsToShow={12}
          selectedIndicator={ARROW_PROMPT}
          renderItem={(item, { isSelected }) => {
            // 模型名 + 右侧 pad 到列宽，让 provider 对齐
            const pad = " ".repeat(Math.max(1, nameColWidth - stringWidth(item.name) + 2));
            return (
              <Box>
                <Text color={isSelected ? theme.ui.focus : theme.text.primary}>
                  {item.name}
                </Text>
                <Text color={theme.text.secondary}>{pad}{item.provider}</Text>
                {item.isCurrent && (
                  <Text color={theme.ui.active}> {TODO_COMPLETED} 当前</Text>
                )}
                {item.description && (
                  <Text color={theme.text.secondary}> — {item.description}</Text>
                )}
              </Box>
            );
          }}
        />
      </Box>
      <Box marginTop={1}>
        <Text dimColor italic>
          ↑↓ 导航 · Enter 切换{effortEnabled ? " · ←/→ 调 effort" : ""} · Esc 取消
        </Text>
      </Box>
    </Box>
  );
};
