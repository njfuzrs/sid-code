/**
 * 设置对话框
 * 显示和编辑应用配置项
 */

import React, { useState, useMemo } from 'react';
import Box from "../../ink/components/Box.js";
import Text from "../../ink/components/Text.js";
import { theme } from '../semantic-colors.ts';
import { RadioButtonSelect } from './shared/RadioButtonSelect.tsx';
import { useKeypress, KeypressPriority, type Key } from '../contexts/KeypressContext.tsx';

interface SettingItem {
  key: string;
  label: string;
  value: string;
  description?: string;
}

interface SettingsDialogProps {
  onClose: () => void;
  settings: SettingItem[];
  onSettingChange: (key: string, value: string) => void;
}

export const SettingsDialog: React.FC<SettingsDialogProps> = ({
  onClose,
  settings,
  onSettingChange,
}) => {
  const [selectedIndex, setSelectedIndex] = useState(0);

  const items = useMemo(() =>
    settings.map((s, i) => ({
      label: `${s.label}: ${s.value}`,
      value: i,
      key: s.key,
      description: s.description,
    })),
    [settings]
  );

  useKeypress(KeypressPriority.Critical, (key: Key) => {
    if (key.name === 'escape') {
      onClose();
      return true;
    }
    return false;
  });

  const handleSelect = (index: number) => {
    const setting = settings[index];
    // 简化版：仅支持切换布尔值
    if (setting.value === 'true' || setting.value === 'false') {
      const newValue = setting.value === 'true' ? 'false' : 'true';
      onSettingChange(setting.key, newValue);
    }
  };

  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor={theme.ui.active}
      paddingX={1}
      paddingY={1}
    >
      <Text bold color={theme.ui.active}>设置</Text>
      <Text>使用 ↑↓ 导航，Enter 切换，Esc 关闭</Text>
      <Box marginTop={1}>
        <RadioButtonSelect
          items={items}
          initialIndex={selectedIndex}
          onSelect={handleSelect}
          onHighlight={(index) => setSelectedIndex(index)}
          isFocused={true}
          maxItemsToShow={8}
        />
      </Box>
    </Box>
  );
};
