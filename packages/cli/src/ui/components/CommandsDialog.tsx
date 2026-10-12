import React, { useState, useMemo, useEffect } from "react";
import { Box } from "../render-port/components.ts";
import { Text } from "../render-port/components.ts";
import { useStdout } from "../render-port/hooks.ts";
import { stringWidth } from "../render-port/text.ts";
import { theme } from "../semantic-colors.ts";
import { truncateToWidth, oneLine, padEndToWidth } from "./shared/text-layout.ts";
import type { Color } from "../render-port/types.ts";
import { useKeypress, KeypressPriority, type Key } from "../contexts/KeypressContext.tsx";
import { BaseSelectionList, type SelectionListItem } from "./shared/BaseSelectionList.tsx";
import { ARROW_PROMPT } from "../constants/figures.ts";
import type { UnifiedCommandRegistry } from "../../command/unified-registry.ts";
import type { UnifiedCommand } from "../../command/types.ts";
import type { MCPManager } from "@sid-code/core/mcp/manager.ts";

interface CommandsDialogProps {
  onClose: () => void;
  registry: UnifiedCommandRegistry;
  /** G2：用于把 MCP prompt 动态注入命令浏览列表 */
  mcpManager?: MCPManager;
}

type ViewState = "list" | "detail";

/** 来源标签的显示名 */
function sourceLabel(source: string | undefined): string {
  switch (source) {
    case "builtin":
      return "内置";
    case "user":
      return "用户";
    case "project":
      return "项目";
    case "skill":
      return "Skill";
    case "plugin":
      return "插件";
    case "mcp":
      return "MCP";
    default:
      return "未知";
  }
}

/** 来源标签的颜色 */
function sourceColor(source: string | undefined): Color {
  switch (source) {
    case "builtin":
      return theme.text.secondary;
    case "user":
      return theme.status.success;
    case "project":
      return theme.status.warning;
    case "skill":
      return theme.ui.active;
    case "plugin":
      return theme.text.secondary;
    case "mcp":
      return theme.text.secondary;
    default:
      return theme.text.secondary;
  }
}

/** 终端宽度拿不到时的兜底（与 SkillsDialog / ShortcutsHelp 同值） */
const DEFAULT_TERM_WIDTH = 100;
/** 命令名列最多占行宽的比例：再宽描述列就没地方了，超长命令名截断而不是挤占描述 */
const NAME_COL_MAX_RATIO = 0.35;
/** 列间距 */
const COL_GAP = 2;
/**
 * 行内固定开销：边框 2 + paddingX 2 + BaseSelectionList 指针列 2 + 1 列余量。
 * 余量是为了防止恰好写满一行时终端自动折行（最后一列写字符会触发 pending wrap）。
 */
const ROW_OVERHEAD = 7;

export interface CommandsColumnLayout {
  nameCol: number;
  sourceCol: number;
  descCol: number;
}

/**
 * 计算三栏列宽（命令名 / 来源 / 描述）。
 *
 * 之前用 flex row + gap 直接摆三个 Text：描述过长时 yoga 会挤压前两个 Text，
 * 命令名被折成两行（`/incident-r` + `ca`）、`[Skill]` 被拆开，描述各自换行，
 * 每行起点都不同——即 todo 截图里的「没对齐、没分栏」。
 * 现在改为按显示列宽（CJK 安全）预先算好定宽列、整行单个 Text + truncate，
 * 布局不再依赖 flex 收缩。列宽按**全部**命令计算而不是可见窗口，滚动时列不跳动。
 */
export function computeCommandsLayout(
  commands: Pick<UnifiedCommand, "name" | "source">[],
  termWidth: number,
): CommandsColumnLayout {
  const inner = Math.max(30, termWidth - ROW_OVERHEAD);
  const widestName = Math.max(0, ...commands.map((c) => stringWidth(`/${c.name}`)));
  const nameCol = Math.min(widestName, Math.max(12, Math.floor(inner * NAME_COL_MAX_RATIO)));
  const sourceCol = Math.max(0, ...commands.map((c) => stringWidth(`[${sourceLabel(c.source)}]`)));
  const descCol = Math.max(0, inner - nameCol - COL_GAP - sourceCol - COL_GAP);
  return { nameCol, sourceCol, descCol };
}

/** 按列宽产出一行的三段文本（已截断 + 补齐），渲染层只负责上色 */
export function formatCommandRow(
  cmd: Pick<UnifiedCommand, "name" | "source" | "description">,
  layout: CommandsColumnLayout,
): { name: string; source: string; desc: string } {
  return {
    name: padEndToWidth(truncateToWidth(`/${cmd.name}`, layout.nameCol), layout.nameCol),
    source: padEndToWidth(`[${sourceLabel(cmd.source)}]`, layout.sourceCol),
    desc: truncateToWidth(oneLine(cmd.description), layout.descCol),
  };
}

export const CommandsDialog: React.FC<CommandsDialogProps> = ({
  onClose,
  registry,
  mcpManager,
}) => {
  const [view, setView] = useState<ViewState>("list");
  const [commands, setCommands] = useState<UnifiedCommand[]>([]);
  const [selectedCmd, setSelectedCmd] = useState<UnifiedCommand | null>(null);
  const { stdout } = useStdout();
  const termWidth = stdout?.columns || DEFAULT_TERM_WIDTH;

  useEffect(() => {
    // G2：动态注入 MCP prompt 命令，与补全菜单/执行路径保持一致
    import("../../command/mcp-prompt-commands.ts").then(({ buildMcpPromptCommands }) => {
      registry.getCommands(process.cwd(), buildMcpPromptCommands(mcpManager)).then((cmds) => {
        setCommands(cmds.filter((cmd) => !cmd.isHidden));
      });
    });
  }, [registry, mcpManager]);

  useKeypress(KeypressPriority.Critical, (key: Key) => {
    if (key.name === "escape") {
      if (view === "detail") {
        setView("list");
        setSelectedCmd(null);
      } else {
        onClose();
      }
      return true;
    }
    return false;
  });

  // 按 source 分组排序：builtin > skill > user > project > plugin > mcp
  const sortedCommands = useMemo(() => {
    const order: Record<string, number> = {
      builtin: 0,
      skill: 1,
      user: 2,
      project: 3,
      plugin: 4,
      mcp: 5,
    };
    return [...commands].sort((a, b) => {
      const oa = order[a.source ?? ""] ?? 9;
      const ob = order[b.source ?? ""] ?? 9;
      if (oa !== ob) return oa - ob;
      return a.name.localeCompare(b.name);
    });
  }, [commands]);

  type CmdItem = SelectionListItem<UnifiedCommand>;

  const items: CmdItem[] = useMemo(
    () => sortedCommands.map((cmd): CmdItem => ({ value: cmd, key: cmd.name })),
    [sortedCommands],
  );

  const layout = useMemo(
    () => computeCommandsLayout(sortedCommands, termWidth),
    [sortedCommands, termWidth],
  );

  if (view === "detail" && selectedCmd) {
    return (
      <Box
        flexDirection="column"
        borderStyle="round"
        borderColor={theme.ui.active}
        paddingX={1}
        paddingY={0}
      >
        <Text bold color={theme.ui.active}>
          {ARROW_PROMPT} 命令详情
        </Text>
        <Box marginTop={1} flexDirection="column" gap={0}>
          <Text>
            <Text bold>名称：</Text>
            <Text color={theme.ui.active}>/{selectedCmd.name}</Text>
          </Text>
          <Text>
            <Text bold>描述：</Text>
            {selectedCmd.description}
          </Text>
          <Text>
            <Text bold>来源：</Text>
            <Text color={sourceColor(selectedCmd.source)}>[{sourceLabel(selectedCmd.source)}]</Text>
          </Text>
          <Text>
            <Text bold>类型：</Text>
            <Text color={theme.text.secondary}>{selectedCmd.type}</Text>
          </Text>
          {selectedCmd.aliases && selectedCmd.aliases.length > 0 && (
            <Text>
              <Text bold>别名：</Text>
              <Text color={theme.text.secondary}>{selectedCmd.aliases.join(", ")}</Text>
            </Text>
          )}
          {selectedCmd.argumentHint && (
            <Text>
              <Text bold>参数：</Text>
              <Text color={theme.text.secondary}>{selectedCmd.argumentHint}</Text>
            </Text>
          )}
        </Box>
        <Box marginTop={1}>
          <Text italic>Esc 返回列表</Text>
        </Box>
      </Box>
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
      <Text bold color={theme.ui.active}>
        {ARROW_PROMPT} 命令列表
      </Text>
      {commands.length === 0 ? (
        <Box marginTop={1}>
          <Text color={theme.text.secondary}>加载中...</Text>
        </Box>
      ) : (
        <Box marginTop={1} flexDirection="column">
          <BaseSelectionList<UnifiedCommand, CmdItem>
            items={items}
            onSelect={(cmd: UnifiedCommand) => {
              setSelectedCmd(cmd);
              setView("detail");
            }}
            showNumbers={false}
            maxItemsToShow={15}
            showScrollArrows={true}
            renderItem={(item, { isSelected, titleColor }) => {
              const row = formatCommandRow(item.value, layout);
              const gap = " ".repeat(COL_GAP);
              // 整行一个 Text + truncate：不交给 flex 收缩，三栏严格定宽对齐
              return (
                <Text wrap="truncate">
                  <Text color={titleColor} bold={isSelected}>
                    {row.name}
                  </Text>
                  {gap}
                  <Text color={sourceColor(item.value.source)}>{row.source}</Text>
                  {gap}
                  <Text color={isSelected ? titleColor : theme.text.secondary}>{row.desc}</Text>
                </Text>
              );
            }}
          />
        </Box>
      )}
      <Box marginTop={1}>
        <Text italic>↑↓ 选择 · Enter 查看详情 · Esc 关闭</Text>
      </Box>
    </Box>
  );
};
