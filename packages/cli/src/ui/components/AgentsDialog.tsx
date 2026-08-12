import React from "react";
import Box from "@sid-code/tui-renderer/components/Box.tsx";
import Text from "@sid-code/tui-renderer/components/Text.tsx";
import { theme } from "../semantic-colors.ts";
import { useKeypress, KeypressPriority, type Key } from "../contexts/KeypressContext.tsx";
import { ARROW_PROMPT } from "../constants/figures.ts";
import {
  getActiveAgentDefinitions,
  type AgentDefinition,
} from "@sid-code/core/agent/agent-definition.ts";
import { getAgentInkColor } from "@sid-code/core/agent/color.ts";

interface AgentsDialogProps {
  onClose: () => void;
}

/** agent 来源 → 展示标签（built-in / 用户 / 插件）。 */
function sourceLabel(source: AgentDefinition["source"]): string {
  switch (source) {
    case "built-in":
      return "内置";
    case "userSettings":
      return "用户";
    case "plugin":
      return "插件";
    default:
      return "";
  }
}

export const AgentsDialog: React.FC<AgentsDialogProps> = ({ onClose }) => {
  useKeypress(KeypressPriority.Critical, (key: Key) => {
    if (key.name === "escape") {
      onClose();
      return true;
    }
    return false;
  });

  // 列出当前活跃的全部 agent（built-in + custom + plugin），单一真相源。
  const agents = getActiveAgentDefinitions();

  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor={theme.ui.active}
      paddingX={1}
      paddingY={0}
    >
      <Text bold color={theme.ui.active}>
        {ARROW_PROMPT} Agents（{agents.length}）
      </Text>

      <Box marginTop={1} flexDirection="column" gap={0}>
        {agents.map((a) => {
          // 元信息标签：来源 + 可选 model / modelTier / skills 数。
          const tags: string[] = [];
          const src = sourceLabel(a.source);
          if (src) tags.push(src);
          if (a.model) tags.push(`model:${a.model}`);
          else if (a.modelTier && a.modelTier !== "default") tags.push(`档位:${a.modelTier}`);
          if (a.skills && a.skills.length > 0) tags.push(`skills:${a.skills.length}`);

          return (
            <Box key={a.agentType} flexDirection="row">
              <Box flexShrink={0} width={22}>
                {/* P1-2：agent 名直接用其身份色渲染——声明了 color 的显式色，
                    未声明的走哈希分配。比单独列一个「色:blue」文字标签更直观。 */}
                <Text color={getAgentInkColor(a.agentType)}>{a.agentType}</Text>
              </Box>
              <Box flexGrow={1} flexDirection="column">
                <Text wrap="truncate-end" color={theme.text.primary}>
                  {a.description || a.whenToUse}
                </Text>
                {tags.length > 0 ? (
                  <Text color={theme.text.secondary}>{tags.join("  ·  ")}</Text>
                ) : null}
              </Box>
            </Box>
          );
        })}
      </Box>

      <Box marginTop={1} flexDirection="column">
        <Text color={theme.text.secondary}>
          Agent 类型在 <Text color={theme.ui.active}>.sid-code/agents/</Text> 或{" "}
          <Text color={theme.ui.active}>~/.sid-code/agents/</Text> 目录下以 .md 文件定义
        </Text>
        <Text color={theme.text.secondary}>
          frontmatter 支持 model / skills / color / permissionMode / background / isolation 等字段
        </Text>
      </Box>

      <Box marginTop={1}>
        <Text italic>Esc 关闭</Text>
      </Box>
    </Box>
  );
};
