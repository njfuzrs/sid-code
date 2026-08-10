/**
 * 配置总览面板（/config 无参时打开）
 *
 * 状态机：
 *   list   → 按功能领域分组的配置项列表（值 + 来源标记）
 *   detail → 单项详情（当前值/来源/说明/关联命令）
 *
 * 只做浏览，不直接改配置（改配置引导到对应命令，如 /model、/effort）。
 * 来源标记只标可靠可知的（默认/已配置/会话/环境变量），不臆测用户 vs 项目。
 */

import React, { useState, useMemo } from "react";
import Box from "../../ink/components/Box.js";
import Text from "../../ink/components/Text.js";
import stringWidth from "string-width";
import { theme } from "../semantic-colors.ts";
import type { Color } from "../../ink/styles.ts";
import { useKeypress, KeypressPriority, type Key } from "../contexts/KeypressContext.tsx";
import { BaseSelectionList, type SelectionListItem } from "./shared/BaseSelectionList.tsx";
import { ARROW_PROMPT } from "../constants/figures.ts";
import {
  extractConfigItems,
  sourceLabel,
  type ConfigItemInfo,
  type ConfigSource,
} from "../utils/config-items.ts";
import type { Config } from "../../config/config.ts";

interface ConfigDialogProps {
  onClose: () => void;
  config: Config;
  sessionState?: import("../../session/state.ts").SessionState;
  /** 运行时旋钮展示态（可选，来自 TUIState），用于 effort/think/permissionMode 当前值 */
  runtime?: {
    effortDisplay?: string;
    thinkingDisplay?: string;
    permissionMode?: string;
  };
}

type ViewState = { type: "list" } | { type: "detail"; item: ConfigItemInfo };

interface ConfigListItem extends SelectionListItem<string> {
  info: ConfigItemInfo;
  /** 是否为其所在分组的首项（用于渲染分组标题） */
  isGroupFirst: boolean;
}

/** 来源标记颜色。 */
function sourceColor(source: ConfigSource): Color {
  switch (source) {
    case "default":
      return theme.text.secondary;
    case "configured":
      return theme.ui.active;
    case "session":
      return theme.status.warning;
    case "env":
      return theme.text.secondary;
  }
}

export const ConfigDialog: React.FC<ConfigDialogProps> = ({ onClose, config, runtime }) => {
  const [view, setView] = useState<ViewState>({ type: "list" });

  const configItems = useMemo(() => extractConfigItems(config, runtime), [config, runtime]);

  useKeypress(KeypressPriority.Critical, (key: Key) => {
    if (key.name === "escape") {
      if (view.type === "detail") {
        setView({ type: "list" });
      } else {
        onClose();
      }
      return true;
    }
    return false;
  });

  // ── 详情视图 ──
  if (view.type === "detail") {
    const { item } = view;
    return (
      <Box flexDirection="column" borderStyle="round" borderColor={theme.ui.active} paddingX={1} paddingY={0}>
        <Text bold color={theme.ui.active}>{item.key}</Text>
        <Box marginTop={1} flexDirection="column">
          <Box>
            <Text color={theme.text.secondary}>当前值    </Text>
            <Text color={theme.text.primary}>{item.value}</Text>
          </Box>
          <Box>
            <Text color={theme.text.secondary}>来源      </Text>
            <Text color={sourceColor(item.source)}>{sourceLabel(item.source)}</Text>
          </Box>
          <Box>
            <Text color={theme.text.secondary}>分组      </Text>
            <Text color={theme.text.primary}>{item.group}</Text>
          </Box>
          {item.description && (
            <Box marginTop={1}>
              <Text color={theme.text.secondary}>{item.description}</Text>
            </Box>
          )}
          {item.relatedCommand && (
            <Box>
              <Text color={theme.text.secondary}>相关命令：</Text>
              <Text color={theme.ui.active}>{item.relatedCommand}</Text>
            </Box>
          )}
        </Box>
        <Box marginTop={1}>
          <Text italic>Esc 返回</Text>
        </Box>
      </Box>
    );
  }

  // ── 列表视图 ──
  // 标记每项是否为其分组首项（渲染分组标题用）
  const items: ConfigListItem[] = [];
  let prevGroup = "";
  configItems.forEach((info, i) => {
    items.push({
      value: info.key,
      key: `cfg-${i}`,
      info,
      isGroupFirst: info.group !== prevGroup,
    });
    prevGroup = info.group;
  });

  // key 列宽对齐
  const keyColWidth = Math.max(...configItems.map((it) => stringWidth(it.key)), 0);
  // value 列宽对齐（截断超长值到 28 列，避免撑破）
  const valColWidth = Math.min(28, Math.max(...configItems.map((it) => stringWidth(it.value)), 0));

  const handleSelect = (key: string) => {
    const info = configItems.find((it) => it.key === key);
    if (info) setView({ type: "detail", item: info });
  };

  return (
    <Box flexDirection="column" borderStyle="round" borderColor={theme.ui.active} paddingX={1} paddingY={0}>
      <Text bold color={theme.ui.active}>配置总览</Text>
      <Box marginTop={1} flexDirection="column">
        <BaseSelectionList<string, ConfigListItem>
          items={items}
          onSelect={handleSelect}
          isFocused={true}
          showNumbers={false}
          maxItemsToShow={16}
          selectedIndicator={ARROW_PROMPT}
          renderItem={(item, { isSelected }) => {
            const { info, isGroupFirst } = item;
            const keyPad = " ".repeat(Math.max(2, keyColWidth - stringWidth(info.key) + 2));
            const valDisplay =
              stringWidth(info.value) > valColWidth
                ? info.value.slice(0, valColWidth - 1) + "…"
                : info.value;
            const valPad = " ".repeat(Math.max(1, valColWidth - stringWidth(valDisplay) + 2));
            return (
              <Box flexDirection="column">
                {isGroupFirst && (
                  <Text bold color={theme.text.primary}>
                    {info.group}
                  </Text>
                )}
                <Box>
                  <Text color={isSelected ? theme.ui.focus : theme.text.primary}>
                    {"  "}
                    {info.key}
                    {keyPad}
                  </Text>
                  <Text color={theme.text.primary}>
                    {valDisplay}
                    {valPad}
                  </Text>
                  <Text color={sourceColor(info.source)}>[{sourceLabel(info.source)}]</Text>
                </Box>
              </Box>
            );
          }}
        />
      </Box>
      <Box marginTop={1}>
        <Text italic>↑↓ 导航 · Enter 查看详情 · Esc 关闭</Text>
      </Box>
    </Box>
  );
};
