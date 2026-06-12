/**
 * 主题选择对话框
 * 允许用户切换 UI 主题
 */

import React from 'react';
import Box from "../../ink/components/Box.js";
import Text from "../../ink/components/Text.js";
import { theme } from '../semantic-colors.ts';
import { RadioButtonSelect } from './shared/RadioButtonSelect.tsx';
import { useKeypress, KeypressPriority, type Key } from '../contexts/KeypressContext.tsx';

interface ThemeOption {
  name: string;
  type: 'light' | 'dark';
  description?: string;
}

interface ThemeDialogProps {
  onClose: () => void;
  currentTheme: string;
  availableThemes: ThemeOption[];
  onThemeSelect: (themeName: string) => void;
}

export const ThemeDialog: React.FC<ThemeDialogProps> = ({
  onClose,
  currentTheme,
  availableThemes,
  onThemeSelect,
}) => {
  const items = availableThemes.map((t, i) => ({
    label: t.name,
    sublabel: t.type === 'light' ? '亮色' : '暗色',
    value: t.name,
    key: `theme-${i}`,
    description: t.description,
  }));

  const initialIndex = items.findIndex(item => item.value === currentTheme);

  useKeypress(KeypressPriority.Critical, (key: Key) => {
    if (key.name === 'escape') {
      onClose();
      return true;
    }
    return false;
  });

  const handleSelect = (themeName: string) => {
    onThemeSelect(themeName);
    // 关闭由外部 onThemeSelect 回调统一处理
  };

  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor={theme.ui.active}
      paddingX={1}
      paddingY={1}
    >
      <Text bold color={theme.ui.active}>选择主题</Text>
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
