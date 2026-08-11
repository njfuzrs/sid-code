import React, { useState, useMemo, useEffect } from "react";
import Box from "@sid-code/tui-renderer/components/Box.tsx";
import Text from "@sid-code/tui-renderer/components/Text.tsx";
import { theme } from "../semantic-colors.ts";
import type { Color } from "@sid-code/tui-renderer/styles.ts";
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
    case "builtin": return "内置";
    case "user": return "用户";
    case "project": return "项目";
    case "skill": return "Skill";
    case "plugin": return "插件";
    case "mcp": return "MCP";
    default: return "未知";
  }
}

/** 来源标签的颜色 */
function sourceColor(source: string | undefined): Color {
  switch (source) {
    case "builtin": return theme.text.secondary;
    case "user": return theme.status.success;
    case "project": return theme.status.warning;
    case "skill": return theme.ui.active;
    case "plugin": return theme.text.secondary;
    case "mcp": return theme.text.secondary;
    default: return theme.text.secondary;
  }
}

export const CommandsDialog: React.FC<CommandsDialogProps> = ({ onClose, registry, mcpManager }) => {
  const [view, setView] = useState<ViewState>("list");
  const [commands, setCommands] = useState<UnifiedCommand[]>([]);
  const [selectedCmd, setSelectedCmd] = useState<UnifiedCommand | null>(null);

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

  if (view === "detail" && selectedCmd) {
    return (
      <Box flexDirection="column" borderStyle="round" borderColor={theme.ui.active} paddingX={1} paddingY={0}>
        <Text bold color={theme.ui.active}>{ARROW_PROMPT} 命令详情</Text>
        <Box marginTop={1} flexDirection="column" gap={0}>
          <Text><Text bold>名称：</Text><Text color={theme.ui.active}>/{selectedCmd.name}</Text></Text>
          <Text><Text bold>描述：</Text>{selectedCmd.description}</Text>
          <Text><Text bold>来源：</Text><Text color={sourceColor(selectedCmd.source)}>[{sourceLabel(selectedCmd.source)}]</Text></Text>
          <Text><Text bold>类型：</Text><Text color={theme.text.secondary}>{selectedCmd.type}</Text></Text>
          {selectedCmd.aliases && selectedCmd.aliases.length > 0 && (
            <Text><Text bold>别名：</Text><Text color={theme.text.secondary}>{selectedCmd.aliases.join(", ")}</Text></Text>
          )}
          {selectedCmd.argumentHint && (
            <Text><Text bold>参数：</Text><Text color={theme.text.secondary}>{selectedCmd.argumentHint}</Text></Text>
          )}
        </Box>
        <Box marginTop={1}><Text italic>Esc 返回列表</Text></Box>
      </Box>
    );
  }

  return (
    <Box flexDirection="column" borderStyle="round" borderColor={theme.ui.active} paddingX={1} paddingY={0}>
      <Text bold color={theme.ui.active}>{ARROW_PROMPT} 命令列表</Text>
      {commands.length === 0 ? (
        <Box marginTop={1}><Text color={theme.text.secondary}>加载中...</Text></Box>
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
            renderItem={(item, { isSelected, titleColor }) => (
              <Box flexDirection="row" gap={1}>
                <Text color={titleColor} bold={isSelected}>/{item.value.name}</Text>
                <Text color={sourceColor(item.value.source)}>[{sourceLabel(item.value.source)}]</Text>
                <Text color={theme.text.secondary}>{item.value.description}</Text>
              </Box>
            )}
          />
        </Box>
      )}
      <Box marginTop={1}><Text italic>↑↓ 选择 · Enter 查看详情 · Esc 关闭</Text></Box>
    </Box>
  );
};
