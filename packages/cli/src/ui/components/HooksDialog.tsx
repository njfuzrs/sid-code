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
import { Box } from "../render-port/components.ts";
import { Text } from "../render-port/components.ts";
import { useStdout } from "../render-port/hooks.ts";
import { stringWidth } from "../render-port/text.ts";
import { theme } from "../semantic-colors.ts";
import { fitCell, columnWidth } from "./shared/text-layout.ts";
import { useKeypress, KeypressPriority, type Key } from "../contexts/KeypressContext.tsx";
import { BaseSelectionList, type SelectionListItem } from "./shared/BaseSelectionList.tsx";
import { ARROW_PROMPT, SUCCESS_MARK, ERROR_MARK } from "../constants/figures.ts";
import type { HookSystem } from "@sid-code/core/hook/system.ts";
import type { HookRegistryEntry } from "@sid-code/core/hook/registry.ts";
import { ConfigSource } from "@sid-code/core/hook/types.ts";
import type { HookLayer } from "@sid-code/core/config/hook-layers.ts";

interface HooksDialogProps {
  onClose: () => void;
  hookSystem: HookSystem;
  /**
   * 配置文件的 hooks 层（含被信任门摘掉的）。被摘掉的层不进注册表，getAllHooks() 看不到它们——
   * 不单独标注，用户会以为项目里的 hooks「写了没生效」而去查格式，真正原因是没信任工作区。
   */
  hookLayers?: HookLayer[];
}

/** 被信任门跳过的项目级 hook 条数（与 cli.ts 信任门、`hooks list` 同一计数口径：每个事件下的数组项） */
export function countSkippedByTrust(layers: HookLayer[] | undefined): number {
  let n = 0;
  for (const l of layers ?? []) {
    if (l.skippedByTrust) n += Object.values(l.hooks).flat().length;
  }
  return n;
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

const DEFAULT_TERM_WIDTH = 100;
/** 边框 2 + paddingX 2 + 列表指针列 2 + 状态图标与空格 2 + 1 列余量 */
const ROW_OVERHEAD = 9;
const COL_GAP = 2;
/** 详情页标签列宽：最长标签「来源 Skill」= 10 列，再留 1 列间隔 */
const KV_LABEL_WIDTH = 11;

/**
 * 列表列宽。hookName 多数情况下是 cfg.command（任意长的 shell 命令，可能带换行），
 * 旧实现平铺无截断，长命令会把「事件 [来源]」挤到下一行、各行错位。
 */
export function computeHooksLayout(
  hooks: HookRegistryEntry[],
  termWidth: number,
): { nameCol: number; eventCol: number } {
  const inner = Math.max(30, termWidth - ROW_OVERHEAD);
  const eventCol = columnWidth(
    hooks.map((h) => h.eventName),
    24,
  );
  const sourceCol = Math.max(0, ...hooks.map((h) => stringWidth(`[${sourceLabel(h.source)}]`)));
  const nameCol = Math.max(8, inner - eventCol - sourceCol - COL_GAP * 2);
  return {
    nameCol: Math.min(nameCol, columnWidth(hooks.map(hookName), nameCol, 8)),
    eventCol,
  };
}

/**
 * 详情页键值行：标签列定宽不收缩，值在自己那一列内换行。
 * 旧实现标签无定宽，长命令/URL 会挤压标签；「来源 Skill」还漏了尾随空格与值粘连。
 * 详情页要能看全命令，所以这里换行而不截断。
 */
const KvRow: React.FC<{ label: string; children: React.ReactNode }> = ({ label, children }) => (
  <Box flexDirection="row">
    <Box width={KV_LABEL_WIDTH} flexShrink={0}>
      <Text color={theme.text.secondary}>{label}</Text>
    </Box>
    <Box flexGrow={1} flexShrink={1}>
      {children}
    </Box>
  </Box>
);

export const HooksDialog: React.FC<HooksDialogProps> = ({ onClose, hookSystem, hookLayers }) => {
  const [view, setView] = useState<ViewState>({ type: "list" });
  const { stdout } = useStdout();
  const termWidth = stdout?.columns || DEFAULT_TERM_WIDTH;
  const skippedCount = useMemo(() => countSkippedByTrust(hookLayers), [hookLayers]);
  // 警告色点睛一行即可（L1.2 克制点睛），不另起盒子
  const skippedNotice =
    skippedCount > 0 ? (
      <Box marginTop={1}>
        <Text color={theme.status.warning}>未信任工作区，已跳过 {skippedCount} 条（项目级）</Text>
      </Box>
    ) : null;

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
      <Box
        flexDirection="column"
        borderStyle="round"
        borderColor={theme.ui.active}
        paddingX={1}
        paddingY={0}
      >
        <Text bold color={theme.ui.active}>
          {hookName(hook)}
        </Text>
        <Box marginTop={1} flexDirection="column">
          <KvRow label="状态">
            <Text color={hook.enabled ? theme.status.success : theme.status.error}>
              {hook.enabled ? `${SUCCESS_MARK} 启用` : `${ERROR_MARK} 禁用`}
            </Text>
          </KvRow>
          <KvRow label="触发事件">
            <Text color={theme.text.primary}>{hook.eventName}</Text>
          </KvRow>
          <KvRow label="来源">
            <Text color={theme.text.primary}>{sourceLabel(hook.source)}</Text>
          </KvRow>
          {hook.matcher && (
            <KvRow label="匹配工具">
              <Text color={theme.text.primary}>{hook.matcher}</Text>
            </KvRow>
          )}
          {cfg.command && (
            <KvRow label="命令">
              <Text color={theme.text.primary}>{cfg.command}</Text>
            </KvRow>
          )}
          {cfg.url && (
            <KvRow label="URL">
              <Text color={theme.text.primary}>{cfg.url}</Text>
            </KvRow>
          )}
          {hook.skillName && (
            <KvRow label="来源 Skill">
              <Text color={theme.text.primary}>{hook.skillName}</Text>
            </KvRow>
          )}
          {hook.once && (
            <KvRow label="一次性">
              <Text color={theme.text.primary}>{hook.executed ? "已执行" : "待执行"}</Text>
            </KvRow>
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
      <Box
        flexDirection="column"
        borderStyle="round"
        borderColor={theme.ui.active}
        paddingX={1}
        paddingY={0}
      >
        <Text bold color={theme.ui.active}>
          Hooks 管理
        </Text>
        <Box marginTop={1}>
          <Text color={theme.text.secondary}>当前没有注册任何 Hook</Text>
        </Box>
        <Text>可在 .sid-code/settings.json 或 ~/.sid-code/settings.json 的 hooks 配置中添加</Text>
        {skippedNotice}
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

  const layout = computeHooksLayout(hooks, termWidth);

  const handleSelect = (idx: number) => {
    if (hooks[idx]) setView({ type: "detail", hook: hooks[idx] });
  };

  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor={theme.ui.active}
      paddingX={1}
      paddingY={0}
    >
      <Box>
        <Text bold color={theme.ui.active}>
          Hooks 管理
        </Text>
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
            const gap = " ".repeat(COL_GAP);
            // 整行单个 Text + truncate；名称（常是长 shell 命令）定宽截断，事件/来源列对齐
            return (
              <Text wrap="truncate">
                <Text color={statusColor}>{statusIcon}</Text>{" "}
                <Text color={isSelected ? theme.ui.focus : theme.text.primary}>
                  {fitCell(hookName(entry), layout.nameCol)}
                </Text>
                {gap}
                <Text color={theme.text.secondary}>
                  {fitCell(entry.eventName, layout.eventCol)}
                  {gap}[{sourceLabel(entry.source)}]
                </Text>
              </Text>
            );
          }}
        />
      </Box>
      {skippedNotice}
      <Box marginTop={1}>
        <Text italic>↑↓ 导航 · Enter 查看详情 · Esc 关闭</Text>
      </Box>
    </Box>
  );
};
