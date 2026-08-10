/**
 * Hooks 管理面板（/hooks 无参时打开）
 *
 * 状态机：
 *   list   → hook 列表（按来源分组 project/user/global/runtime/plugin）
 *   detail → hook 详情（事件/匹配器/来源/启用状态）
 *
 * 只做浏览，不支持启用/禁用操作（修改 hook 请编辑 settings.json 或 .sid-code/settings.json）。
 */

import React, { useState, useMemo } from "react";
import Box from "../../ink/components/Box.js";
import Text from "../../ink/components/Text.js";
import { theme } from "../semantic-colors.ts";
import { useKeypress, KeypressPriority, type Key } from "../contexts/KeypressContext.tsx";
import { BaseSelectionList, type SelectionListItem } from "./shared/BaseSelectionList.tsx";
import { ARROW_PROMPT, SUCCESS_MARK, ERROR_MARK } from "../constants/figures.ts";
import type { HookSystem } from "../../hook/system.ts";
import type { HookRegistryEntry } from "../../hook/registry.ts";
import { ConfigSource } from "../../hook/types.ts";

interface HooksDialogProps {
  onClose: () => void;
  hookSystem: HookSystem;
}

type ViewState = { type: "list" } | { type: "detail"; hook: HookRegistryEntry };

interface HookItem extends SelectionListItem<number> {
  entry: HookRegistryEntry;
  idx: number;
}

const SOURCE_LABELS: Record<string, string> = {
  [ConfigSource.Project]: "项目级",
  [ConfigSource.User]: "用户级",
  [ConfigSource.Global]: "全局级",
  [ConfigSource.Runtime]: "运行时",
  [ConfigSource.Plugin]: "插件",
};

function sourceLabel(source: ConfigSource): string {
  return SOURCE_LABELS[source] ?? String(source);
}

function hookName(entry: HookRegistryEntry): string {
  const cfg = entry.config as any;
  return cfg.command || cfg.url || cfg.prompt?.slice(0, 30) || entry.eventName;
}

export const HooksDialog: React.FC<HooksDialogProps> = ({ onClose, hookSystem }) => {
  const [view, setView] = useState<ViewState>({ type: "list" });

  const hooks = useMemo(() => hookSystem.getAllHooks(), [hookSystem]);

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
    const { hook } = view;
    const cfg = hook.config as any;
    return (
      <Box flexDirection="column" borderStyle="round" borderColor={theme.ui.active} paddingX={1} paddingY={0}>
        <Text bold color={theme.ui.active}>{hookName(hook)}</Text>
        <Box marginTop={1} flexDirection="column">
          <Box>
            <Text color={theme.text.secondary}>状态      </Text>
            <Text color={hook.enabled ? theme.status.success : theme.status.error}>
              {hook.enabled ? `${SUCCESS_MARK} 启用` : `${ERROR_MARK} 禁用`}
            </Text>
          </Box>
          <Box>
            <Text color={theme.text.secondary}>触发事件  </Text>
            <Text color={theme.text.primary}>{hook.eventName}</Text>
          </Box>
          <Box>
            <Text color={theme.text.secondary}>来源      </Text>
            <Text color={theme.text.primary}>{sourceLabel(hook.source)}</Text>
          </Box>
          {hook.matcher && (
            <Box>
              <Text color={theme.text.secondary}>匹配工具  </Text>
              <Text color={theme.text.primary}>{hook.matcher}</Text>
            </Box>
          )}
          {cfg.command && (
            <Box>
              <Text color={theme.text.secondary}>命令      </Text>
              <Text color={theme.text.primary}>{cfg.command}</Text>
            </Box>
          )}
          {cfg.url && (
            <Box>
              <Text color={theme.text.secondary}>URL       </Text>
              <Text color={theme.text.primary}>{cfg.url}</Text>
            </Box>
          )}
          {hook.skillName && (
            <Box>
              <Text color={theme.text.secondary}>来源 Skill</Text>
              <Text color={theme.text.primary}>{hook.skillName}</Text>
            </Box>
          )}
          {hook.once && (
            <Box>
              <Text color={theme.text.secondary}>一次性    </Text>
              <Text color={theme.text.primary}>{hook.executed ? "已执行" : "待执行"}</Text>
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
  if (hooks.length === 0) {
    return (
      <Box flexDirection="column" borderStyle="round" borderColor={theme.ui.active} paddingX={1} paddingY={0}>
        <Text bold color={theme.ui.active}>Hooks 管理</Text>
        <Box marginTop={1}>
          <Text color={theme.text.secondary}>当前没有注册任何 Hook</Text>
        </Box>
        <Text>可在 .sid-code/settings.json 或 ~/.sid-code/settings.json 的 hooks 配置中添加</Text>
        <Box marginTop={1}>
          <Text italic>Esc 关闭</Text>
        </Box>
      </Box>
    );
  }

  const items: HookItem[] = hooks.map((entry, idx) => ({
    value: idx,
    key: `hook-${idx}`,
    entry,
    idx,
  }));

  const handleSelect = (idx: number) => {
    if (hooks[idx]) setView({ type: "detail", hook: hooks[idx] });
  };

  return (
    <Box flexDirection="column" borderStyle="round" borderColor={theme.ui.active} paddingX={1} paddingY={0}>
      <Box>
        <Text bold color={theme.ui.active}>Hooks 管理</Text>
        <Text color={theme.text.secondary}> · {hooks.length} 个注册</Text>
      </Box>
      <Box marginTop={1} flexDirection="column">
        <BaseSelectionList<number, HookItem>
          items={items}
          onSelect={handleSelect}
          isFocused={true}
          showNumbers={false}
          maxItemsToShow={12}
          selectedIndicator={ARROW_PROMPT}
          renderItem={(item, { isSelected }) => {
            const { entry } = item;
            const statusIcon = entry.enabled ? SUCCESS_MARK : ERROR_MARK;
            const statusColor = entry.enabled ? theme.status.success : theme.status.error;
            return (
              <Box>
                <Text color={statusColor}>{statusIcon} </Text>
                <Text color={isSelected ? theme.ui.focus : theme.text.primary}>
                  {hookName(entry)}
                </Text>
                <Text color={theme.text.secondary}>
                  {"  "}{entry.eventName}  [{sourceLabel(entry.source)}]
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
