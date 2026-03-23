/**
 * 模型选择对话框
 * 允许用户切换 LLM 模型
 */

import React from 'react';
import { Box, Text } from 'ink';
import { theme } from '../semantic-colors.ts';
import { RadioButtonSelect } from './shared/RadioButtonSelect.tsx';
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

export const ModelDialog: React.FC<ModelDialogProps> = ({
  onClose,
  currentModel,
  availableModels,
  onModelSelect,
}) => {
  const items = availableModels.map((m, i) => ({
    label: m.name,
    sublabel: m.provider,
    value: m.name,
    key: `model-${i}`,
    description: m.description,
  }));

  const initialIndex = items.findIndex(item => item.value === currentModel);

  useKeypress(KeypressPriority.Critical, (key: Key) => {
    if (key.name === 'escape') {
      onClose();
      return true;
    }
    return false;
  });

  const handleSelect = (modelName: string) => {
    onModelSelect(modelName);
    onClose();
  };

  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor={theme.ui.active}
      paddingX={1}
      paddingY={1}
    >
      <Text bold color={theme.ui.active}>选择模型</Text>
      <Text dimColor>使用 ↑↓ 导航，Enter 选择，Esc 取消</Text>
      <Box marginTop={1}>
        <RadioButtonSelect
          items={items}
          initialIndex={initialIndex >= 0 ? initialIndex : 0}
          onSelect={handleSelect}
          isFocused={true}
          maxItemsToShow={8}
        />
      </Box>
    </Box>
  );
};
