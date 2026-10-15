/**
 * 插件交互式管理面板（/plugin 无参打开，对标 /mcp 面板）
 *
 * 为什么要有它：此前 /plugin 只回一段多行文本，经命令结果路由进状态栏/面板后一闪而过，
 * 用户既看不全列表，也没有地方就地启用 / 禁用 / 更新 / 卸载。
 *
 * 状态机：
 *   list → plugin-menu（Enter 选中）
 *   plugin-menu → detail（查看详情）/ list（Esc）
 *   detail → plugin-menu（Esc）
 *
 * 所有动作复用 /plugin 子命令背后的同一套操作函数（operations.ts / market-operations.ts），
 * 不另写一份逻辑：面板只是入口，口径与 `/plugin enable x`、`sid-code plugin enable x` 一致。
 * 变更后不自动 /reload-plugins —— 与文本子命令行为一致，由反馈行提示用户执行。
 */

import React, { useState, useEffect, useCallback } from "react";
import { Box } from "../render-port/components.ts";
import { Text } from "../render-port/components.ts";
import { useStdout } from "../render-port/hooks.ts";
import { theme } from "../semantic-colors.ts";
import { fitCell, clipLine, columnWidth } from "./shared/text-layout.ts";
import { useKeypress, KeypressPriority, type Key } from "../contexts/KeypressContext.tsx";
import { BaseSelectionList, type SelectionListItem } from "./shared/BaseSelectionList.tsx";
import { SUCCESS_MARK, ERROR_MARK, WARNING_MARK, ARROW_PROMPT } from "../constants/figures.ts";
import type { LoadedPlugin, PluginLoadResult } from "../../plugin/types.ts";

const RELOAD_HINT = "运行 /reload-plugins 使其生效";

// ─── 数据 ───

/** 面板一行：启用与禁用合并成一张表，启用在前 */
export interface PluginRow {
  plugin: LoadedPlugin;
  enabled: boolean;
}

export function toPluginRows(result: PluginLoadResult): PluginRow[] {
  return [
    ...result.enabled.map((plugin) => ({ plugin, enabled: true })),
    ...result.disabled.map((plugin) => ({ plugin, enabled: false })),
  ];
}

/** 菜单动作。内置插件不在 installed.json 里，启停 / 更新 / 卸载对它都无意义，只给「查看详情」 */
export type PluginAction = "detail" | "enable" | "disable" | "update" | "uninstall";

export function pluginMenuActions(row: PluginRow): Array<{ action: PluginAction; label: string }> {
  const items: Array<{ action: PluginAction; label: string }> = [
    { action: "detail", label: "查看详情" },
  ];
  if (row.plugin.isBuiltin) return items;
  items.push(
    row.enabled ? { action: "disable", label: "禁用" } : { action: "enable", label: "启用" },
  );
  // 只有从市场装的插件能回市场比对版本；本地目录装的没有来源可比
  if (row.plugin.marketplace) items.push({ action: "update", label: "检查更新" });
  items.push({ action: "uninstall", label: "卸载（保留文件）" });
  return items;
}

// ─── 行布局 ───

const DEFAULT_TERM_WIDTH = 100;
/** 边框 2 + paddingX 2 + 列表指针列 2 + 1 列余量 */
const ROW_OVERHEAD = 7;
const COL_GAP = 2;

function statusLabel(row: PluginRow): string {
  return row.enabled ? "已启用" : "已禁用";
}

function sourceLabel(p: LoadedPlugin): string {
  if (p.isBuiltin) return "内置";
  return p.marketplace ? `@${p.marketplace}` : "本地";
}

export function computePluginRowLayout(rows: PluginRow[], termWidth: number) {
  const inner = Math.max(30, termWidth - ROW_OVERHEAD);
  const nameCol = columnWidth(
    rows.map((r) => `${r.plugin.name}@${r.plugin.manifest.version}`),
    Math.floor(inner * 0.35),
    4,
  );
  const sourceCol = columnWidth(
    rows.map((r) => sourceLabel(r.plugin)),
    14,
  );
  // 状态列 = 图标 1 + 空格 1 + 「已启用」6
  const statusCol = 8;
  const used = nameCol + sourceCol + statusCol + COL_GAP * 3;
  return { nameCol, sourceCol, statusCol, descCol: Math.max(0, inner - used) };
}

// ─── 主组件 ───

interface PluginsDialogProps {
  onClose: () => void;
}

type ViewState =
  | { type: "list" }
  | { type: "menu"; row: PluginRow }
  | { type: "detail"; row: PluginRow };

export const PluginsDialog: React.FC<PluginsDialogProps> = ({ onClose }) => {
  const [view, setView] = useState<ViewState>({ type: "list" });
  const [rows, setRows] = useState<PluginRow[] | null>(null);
  const [loadErrors, setLoadErrors] = useState<string[]>([]);
  const [feedback, setFeedback] = useState("");

  const refresh = useCallback(async (): Promise<PluginRow[]> => {
    const { loadAllPlugins, formatPluginError } = await import("../../plugin/index.ts");
    const result = await loadAllPlugins();
    const next = toPluginRows(result);
    setRows(next);
    setLoadErrors(result.errors.map(formatPluginError));
    return next;
  }, []);

  useEffect(() => {
    refresh().catch((err: any) => {
      setRows([]);
      setLoadErrors([`加载插件失败: ${err?.message ?? String(err)}`]);
    });
  }, [refresh]);

  switch (view.type) {
    case "list":
      return (
        <PluginList
          rows={rows}
          loadErrors={loadErrors}
          feedback={feedback}
          onClose={onClose}
          onSelect={(row) => {
            setFeedback("");
            setView({ type: "menu", row });
          }}
        />
      );
    case "menu":
      return (
        <PluginMenu
          row={view.row}
          feedback={feedback}
          onFeedback={setFeedback}
          onBack={() => {
            setView({ type: "list" });
          }}
          onDetail={() => setView({ type: "detail", row: view.row })}
          onChanged={async (removed) => {
            const next = await refresh();
            if (removed) {
              setView({ type: "list" });
              return;
            }
            const updated = next.find((r) => r.plugin.name === view.row.plugin.name);
            setView(updated ? { type: "menu", row: updated } : { type: "list" });
          }}
        />
      );
    case "detail":
      return (
        <PluginDetail row={view.row} onBack={() => setView({ type: "menu", row: view.row })} />
      );
  }
};

// ─── 子组件：插件列表 ───

const PluginList: React.FC<{
  rows: PluginRow[] | null;
  loadErrors: string[];
  feedback: string;
  onClose: () => void;
  onSelect: (row: PluginRow) => void;
}> = ({ rows, loadErrors, feedback, onClose, onSelect }) => {
  const { stdout } = useStdout();
  useKeypress(KeypressPriority.Critical, (key: Key) => {
    if (key.name === "escape") {
      onClose();
      return true;
    }
    return false;
  });

  const header = (
    <Box>
      <Text bold color={theme.ui.active}>
        插件管理
      </Text>
      {rows && rows.length > 0 ? (
        <Text color={theme.text.secondary}> · {rows.length} 个插件</Text>
      ) : null}
    </Box>
  );

  const errors =
    loadErrors.length > 0 ? (
      <Box marginTop={1} flexDirection="column">
        <Text color={theme.status.warning}>加载错误:</Text>
        {loadErrors.map((e, i) => (
          <Text key={i} color={theme.status.warning} wrap="truncate">
            {WARNING_MARK} {e}
          </Text>
        ))}
      </Box>
    ) : null;

  let body: React.ReactNode;
  if (rows === null) {
    body = <Text color={theme.text.secondary}>加载中…</Text>;
  } else if (rows.length === 0) {
    body = (
      <Box flexDirection="column">
        <Text color={theme.text.secondary}>暂无已安装插件</Text>
        <Text>浏览市场: /plugin market · 安装: /plugin install {"<name>@<市场>"}</Text>
      </Box>
    );
  } else {
    const layout = computePluginRowLayout(rows, stdout?.columns || DEFAULT_TERM_WIDTH);
    const gap = " ".repeat(COL_GAP);
    const items: Array<SelectionListItem<PluginRow>> = rows.map((r) => ({
      value: r,
      key: r.plugin.name,
    }));
    body = (
      <BaseSelectionList<PluginRow>
        items={items}
        onSelect={onSelect}
        showNumbers={false}
        maxItemsToShow={12}
        showScrollArrows={true}
        selectedIndicator={ARROW_PROMPT}
        renderItem={(item, { isSelected }) => {
          const r = item.value;
          return (
            <Text wrap="truncate">
              <Text color={isSelected ? theme.ui.focus : theme.text.primary}>
                {fitCell(`${r.plugin.name}@${r.plugin.manifest.version}`, layout.nameCol)}
              </Text>
              {gap}
              <Text color={theme.text.secondary}>
                {fitCell(sourceLabel(r.plugin), layout.sourceCol)}
              </Text>
              {gap}
              <Text color={r.enabled ? theme.status.success : theme.text.secondary}>
                {r.enabled ? SUCCESS_MARK : ERROR_MARK}
              </Text>{" "}
              <Text color={theme.text.secondary}>
                {fitCell(statusLabel(r), layout.statusCol - 2)}
              </Text>
              {gap}
              <Text color={theme.text.secondary}>
                {clipLine(r.plugin.manifest.description, layout.descCol)}
              </Text>
            </Text>
          );
        }}
      />
    );
  }

  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor={theme.ui.active}
      paddingX={1}
      paddingY={0}
    >
      {header}
      <Box marginTop={1} flexDirection="column">
        {body}
      </Box>
      {errors}
      {feedback ? (
        <Box marginTop={1}>
          <Text color={theme.status.success}>{feedback}</Text>
        </Box>
      ) : null}
      <Box marginTop={1}>
        <Text italic>
          {rows && rows.length > 0 ? "↑↓ 导航 · Enter 管理 · Esc 关闭" : "Esc 关闭"}
        </Text>
      </Box>
    </Box>
  );
};

// ─── 子组件：单个插件的操作菜单 ───

const PluginMenu: React.FC<{
  row: PluginRow;
  feedback: string;
  onFeedback: (msg: string) => void;
  onBack: () => void;
  onDetail: () => void;
  /** 动作完成后刷新列表；removed=true 表示插件已不在列表里（卸载） */
  onChanged: (removed: boolean) => Promise<void>;
}> = ({ row, feedback, onFeedback, onBack, onDetail, onChanged }) => {
  const [busy, setBusy] = useState(false);

  useKeypress(KeypressPriority.Critical, (key: Key) => {
    if (key.name === "escape" && !busy) {
      onBack();
      return true;
    }
    return false;
  });

  const name = row.plugin.name;

  const run = async (action: PluginAction) => {
    if (busy) return;
    if (action === "detail") {
      onDetail();
      return;
    }
    setBusy(true);
    onFeedback("处理中…");
    try {
      const ops = await import("../../plugin/index.ts");
      let r: { ok: true; message: string } | { ok: false; error: string };
      if (action === "enable") r = await ops.enablePlugin(name);
      else if (action === "disable") r = await ops.disablePlugin(name);
      else if (action === "uninstall") r = await ops.uninstallPlugin(name);
      else {
        const { updateFromMarket } = await import("../../plugin/market-operations.ts");
        r = await updateFromMarket(name);
      }
      if (!r.ok) {
        onFeedback(`操作失败: ${r.error}`);
      } else {
        onFeedback(`${r.message.split("\n")[0]}（${RELOAD_HINT}）`);
        await onChanged(action === "uninstall");
      }
    } catch (err: any) {
      onFeedback(`操作失败: ${err?.message ?? String(err)}`);
    } finally {
      setBusy(false);
    }
  };

  const items: Array<SelectionListItem<PluginAction> & { label: string }> = pluginMenuActions(
    row,
  ).map((m) => ({ value: m.action, key: m.action, label: m.label }));

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
          {name}@{row.plugin.manifest.version}
        </Text>
        <Text color={theme.text.secondary}> ({sourceLabel(row.plugin)}) </Text>
        <Text color={row.enabled ? theme.status.success : theme.text.secondary}>
          {row.enabled ? SUCCESS_MARK : ERROR_MARK} {statusLabel(row)}
        </Text>
      </Box>
      {row.plugin.manifest.description ? (
        <Text color={theme.text.secondary}>{row.plugin.manifest.description}</Text>
      ) : null}
      <Box marginTop={1} flexDirection="column">
        {busy ? (
          <Text color={theme.text.secondary}>{feedback || "处理中…"}</Text>
        ) : (
          <BaseSelectionList<PluginAction, SelectionListItem<PluginAction> & { label: string }>
            items={items}
            onSelect={run}
            showNumbers={false}
            maxItemsToShow={8}
            selectedIndicator={ARROW_PROMPT}
            renderItem={(item, { isSelected }) => (
              <Text color={isSelected ? theme.ui.focus : theme.text.primary}>{item.label}</Text>
            )}
          />
        )}
      </Box>
      {feedback && !busy ? (
        <Box marginTop={1}>
          <Text color={feedback.startsWith("操作失败") ? theme.status.error : theme.status.success}>
            {feedback}
          </Text>
        </Box>
      ) : null}
      <Box marginTop={1}>
        <Text italic>↑↓ 导航 · Enter 执行 · Esc 返回</Text>
      </Box>
    </Box>
  );
};

// ─── 子组件：详情 ───

/** 详情行（纯函数，供单测锁字段） */
export function pluginDetailLines(row: PluginRow): string[] {
  const p = row.plugin;
  const m = p.manifest;
  const lines = [
    `描述: ${m.description ?? ""}`,
    `来源: ${p.source}`,
    `状态: ${row.enabled ? "已启用" : "已禁用"}`,
    `路径: ${p.path}`,
  ];
  if (m.author) lines.push(`作者: ${m.author}`);
  if (m.license) lines.push(`许可: ${m.license}`);
  if (m.dependencies?.length) lines.push(`依赖: ${m.dependencies.join(", ")}`);
  const components: string[] = [];
  if (p.commandsPaths.length) components.push(`命令(${p.commandsPaths.length} 目录)`);
  if (p.skillsPaths.length) components.push(`Skill(${p.skillsPaths.length} 目录)`);
  if (p.agentsPaths.length) components.push(`Agent(${p.agentsPaths.length} 目录)`);
  if (p.hooksConfig) components.push("Hooks");
  if (m.mcpServers) components.push("MCP");
  if (components.length) lines.push(`组件: ${components.join(", ")}`);
  return lines;
}

const PluginDetail: React.FC<{ row: PluginRow; onBack: () => void }> = ({ row, onBack }) => {
  useKeypress(KeypressPriority.Critical, (key: Key) => {
    if (key.name === "escape") {
      onBack();
      return true;
    }
    return false;
  });
  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor={theme.ui.active}
      paddingX={1}
      paddingY={0}
    >
      <Text bold color={theme.ui.active}>
        {row.plugin.name}@{row.plugin.manifest.version}
      </Text>
      <Box marginTop={1} flexDirection="column">
        {pluginDetailLines(row).map((l, i) => (
          <Text key={i}>{l}</Text>
        ))}
      </Box>
      <Box marginTop={1}>
        <Text italic>Esc 返回</Text>
      </Box>
    </Box>
  );
};
