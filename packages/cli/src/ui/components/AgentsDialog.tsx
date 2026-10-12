import React from "react";
import { Box } from "../render-port/components.ts";
import { Text } from "../render-port/components.ts";
import { theme } from "../semantic-colors.ts";
import { truncateToWidth, oneLine } from "./shared/text-layout.ts";
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
                    未声明的走哈希分配。比单独列一个「色:blue」文字标签更直观。
                    名称超过列宽时截断（留 1 列间隔），否则会在列内折成两行。 */}
                <Text color={getAgentInkColor(a.agentType)} wrap="truncate">
                  {truncateToWidth(a.agentType, 21)}
                </Text>
              </Box>
              <Box flexGrow={1} flexDirection="column">
                {/* 描述先压单行：frontmatter 的多行 description 含 \n 时 truncate 仍会分行 */}
                <Text wrap="truncate-end" color={theme.text.primary}>
                  {oneLine(a.description || a.whenToUse)}
                </Text>
                {tags.length > 0 ? (
                  <Text color={theme.text.secondary} wrap="truncate-end">
                    {tags.join("  ·  ")}
                  </Text>
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
