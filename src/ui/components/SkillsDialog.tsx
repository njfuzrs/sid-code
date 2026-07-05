import React, { useState, useMemo, useEffect } from "react";
import Box from "../../ink/components/Box.js";
import Text from "../../ink/components/Text.js";
import { theme } from "../semantic-colors.ts";
import { useKeypress, KeypressPriority, type Key } from "../contexts/KeypressContext.tsx";
import { BaseSelectionList, type SelectionListItem } from "./shared/BaseSelectionList.tsx";
import { ARROW_PROMPT } from "../constants/figures.ts";
import type { UnifiedCommandRegistry } from "../../command/unified-registry.ts";
import type { UnifiedCommand } from "../../command/types.ts";

interface SkillsDialogProps {
  onClose: () => void;
  registry: UnifiedCommandRegistry;
}

type ViewState = "list" | "detail";

export const SkillsDialog: React.FC<SkillsDialogProps> = ({ onClose, registry }) => {
  const [view, setView] = useState<ViewState>("list");
  const [skills, setSkills] = useState<UnifiedCommand[]>([]);
  const [selectedSkill, setSelectedSkill] = useState<UnifiedCommand | null>(null);

  useEffect(() => {
    registry.getCommands(process.cwd()).then((commands) => {
      setSkills(commands.filter((cmd) => cmd.source === "skill" && !cmd.isHidden));
    });
  }, [registry]);

  useKeypress(KeypressPriority.Critical, (key: Key) => {
    if (key.name === "escape") {
      if (view === "detail") {
        setView("list");
        setSelectedSkill(null);
      } else {
        onClose();
      }
      return true;
    }
    return false;
  });

  type SkillItem = SelectionListItem<UnifiedCommand>;

  const items: SkillItem[] = useMemo(
    () => skills.map((cmd): SkillItem => ({ value: cmd, key: cmd.name })),
    [skills],
  );

  if (view === "detail" && selectedSkill) {
    return (
      <Box flexDirection="column" borderStyle="round" borderColor={theme.ui.active} paddingX={1} paddingY={0}>
        <Text bold color={theme.ui.active}>{ARROW_PROMPT} Skill 详情</Text>
        <Box marginTop={1} flexDirection="column" gap={0}>
          <Text><Text bold>名称：</Text><Text color={theme.ui.active}>/{selectedSkill.name}</Text></Text>
          <Text><Text bold>描述：</Text>{selectedSkill.description}</Text>
          <Text><Text bold>来源：</Text><Text color={theme.text.secondary}>{selectedSkill.source ?? "unknown"}</Text></Text>
          <Text><Text bold>类型：</Text><Text color={theme.text.secondary}>{selectedSkill.type}</Text></Text>
          {selectedSkill.aliases && selectedSkill.aliases.length > 0 && (
            <Text><Text bold>别名：</Text><Text color={theme.text.secondary}>{selectedSkill.aliases.join(", ")}</Text></Text>
          )}
        </Box>
        <Box marginTop={1}><Text dimColor italic>Esc 返回列表</Text></Box>
      </Box>
    );
  }

  return (
    <Box flexDirection="column" borderStyle="round" borderColor={theme.ui.active} paddingX={1} paddingY={0}>
      <Text bold color={theme.ui.active}>{ARROW_PROMPT} Skills</Text>
      {skills.length === 0 ? (
        <Box marginTop={1}><Text color={theme.text.secondary}>暂无可用 Skill</Text></Box>
      ) : (
        <Box marginTop={1} flexDirection="column">
          <BaseSelectionList<UnifiedCommand, SkillItem>
            items={items}
            onSelect={(cmd: UnifiedCommand) => {
              setSelectedSkill(cmd);
              setView("detail");
            }}
            showNumbers={false}
            renderItem={(item, { isSelected, titleColor }) => (
              <Box flexDirection="row" gap={1}>
                <Text color={titleColor} bold={isSelected}>/{item.value.name}</Text>
                <Text color={theme.text.secondary}>{item.value.description}</Text>
              </Box>
            )}
          />
        </Box>
      )}
      <Box marginTop={1}><Text dimColor italic>↑↓ 选择 · Enter 查看详情 · Esc 关闭</Text></Box>
    </Box>
  );
};
