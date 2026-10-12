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
import { Box } from "../render-port/components.ts";
import { Text } from "../render-port/components.ts";
import { theme } from "../semantic-colors.ts";
import { fitCell, columnWidth } from "./shared/text-layout.ts";
import type { Color } from "../render-port/types.ts";
import { useKeypress, KeypressPriority, type Key } from "../contexts/KeypressContext.tsx";
import { BaseSelectionList, type SelectionListItem } from "./shared/BaseSelectionList.tsx";
import { ARROW_PROMPT } from "../constants/figures.ts";
import {
  extractConfigItems,
  sourceLabel,
  type ConfigItemInfo,
  type ConfigSource,
} from "../utils/config-items.ts";
import type { Config } from "@sid-code/core/config/config.ts";

interface ConfigDialogProps {
  onClose: () => void;
  config: Config;
  sessionState?: import("@sid-code/core/session/state.ts").SessionState;
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
      <Box
        flexDirection="column"
        borderStyle="round"
        borderColor={theme.ui.active}
        paddingX={1}
        paddingY={0}
      >
        <Text bold color={theme.ui.active}>
          {item.key}
        </Text>
        <Box marginTop={1} flexDirection="column">
          <Box>
            <Text color={theme.text.secondary}>当前值 </Text>
            <Text color={theme.text.primary}>{item.value}</Text>
          </Box>
          <Box>
            <Text color={theme.text.secondary}>来源 </Text>
            <Text color={sourceColor(item.source)}>{sourceLabel(item.source)}</Text>
          </Box>
          <Box>
            <Text color={theme.text.secondary}>分组 </Text>
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

  // key 列封顶 32、value 列封顶 28：值可能是长 URL / JSON，超出截断而不是撑破整行
  const keyColWidth = columnWidth(
    configItems.map((it) => it.key),
    32,
  );
  const valColWidth = columnWidth(
    configItems.map((it) => it.value),
    28,
  );

  const handleSelect = (key: string) => {
    const info = configItems.find((it) => it.key === key);
    if (info) setView({ type: "detail", item: info });
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
        配置总览
      </Text>
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
            // 旧实现判断用 stringWidth、截取却用 .slice（按码元），CJK 值仍会超宽；
            // 且值里的换行没压掉。统一走 fitCell：压单行 → 按显示宽截断 → 补齐
            return (
              <Box flexDirection="column">
                {isGroupFirst && (
                  <Text bold color={theme.text.primary}>
                    {info.group}
                  </Text>
                )}
                <Text wrap="truncate">
                  <Text color={isSelected ? theme.ui.focus : theme.text.primary}>
                    {"  "}
                    {fitCell(info.key, keyColWidth)}
                  </Text>
                  {"  "}
                  <Text color={theme.text.primary}>{fitCell(info.value, valColWidth)}</Text>
                  {"  "}
                  <Text color={sourceColor(info.source)}>[{sourceLabel(info.source)}]</Text>
                </Text>
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
