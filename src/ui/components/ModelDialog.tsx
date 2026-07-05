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
import { TODO_COMPLETED, ARROW_PROMPT } from '../constants/figures.ts';
import { useKeypress, KeypressPriority, type Key } from '../contexts/KeypressContext.tsx';

interface ModelOption {
  name: string;
  provider: string;
  description?: string;
}

interface ModelDialogProps {
  onClose: () => void;
  currentModel: string;
  availableModels: ModelOption[];
  onModelSelect: (modelName: string) => void;
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
}) => {
  useKeypress(KeypressPriority.Critical, (key: Key) => {
    if (key.name === 'escape') {
      onClose();
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
        <Text dimColor italic>↑↓ 导航 · Enter 切换 · Esc 取消</Text>
      </Box>
    </Box>
  );
};
