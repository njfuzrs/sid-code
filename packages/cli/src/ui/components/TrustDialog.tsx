/**
 * 工作区信任对话框（SEC-AUDIT-2026-07-19 P1）
 *
 * 首次在一个代码库启动、且该库的 .sid-code/settings.json 含危险配置
 * （hooks / mcpServers / env / Bash allow 规则）时弹出。这是防「恶意项目静默提权」
 * 的闸门——对齐 CC 的 TrustDialog（`main.tsx:1067` + `interactiveHelpers.tsx:132-139`）。
 *
 * 此前 `app.ts` 交互模式命中危险配置时**无提示直接 trust()**，用户从未被询问，
 * 等于整道防线不生效（TrustManager 后端完整，只缺这个前端）。
 *
 * 安全默认（src/ui/CLAUDE.md L4-E）：**默认聚焦"不信任"**，手滑回车不会授予信任。
 * 决定持久化：信任 → TrustManager.trust() + markTrustDialogAccepted；
 * 不信任 → 危险配置本会话不加载，下次启动仍会问。
 */

import React from "react";
import { Box } from "../render-port/components.ts";
import { Text } from "../render-port/components.ts";
import { stringWidth } from "../render-port/text.ts";
import { theme } from "../semantic-colors.ts";
import { oneLine, clipLine } from "./shared/text-layout.ts";
import { BaseSelectionList, type SelectionListItem } from "./shared/BaseSelectionList.tsx";
import { ARROW_PROMPT } from "../constants/figures.ts";
import { useKeypress, KeypressPriority, type Key } from "../contexts/KeypressContext.tsx";
import type { TrustCheckItem } from "@sid-code/core/permission/trust.ts";

interface ChoiceItem extends SelectionListItem<boolean> {
  label: string;
  desc: string;
}

/**
 * 选项顺序刻意把"不信任"放在后面并作为 initialIndex——BaseSelectionList 的初始聚焦项
 * 就是安全项。文案带仪式感（"是，我信任此代码库"）而非泛泛的"确定"，让用户意识到
 * 这一步在授予执行权限。
 */
const OPTIONS: ChoiceItem[] = [
  {
    value: true,
    key: "yes",
    label: "是，我信任此代码库",
    desc: "记住此选择，下次启动时加载这些配置",
  },
  { value: false, key: "no", label: "不信任", desc: "跳过这些配置继续使用（下次仍会询问）" },
];

interface Props {
  /** scanDangerousConfigs() 扫出的危险配置项，展示给用户过目。 */
  items: TrustCheckItem[];
  /** 当前工作区路径（让用户确认自己在哪个目录，防误判项目）。 */
  workspacePath: string;
  /** 用户选择回调：trusted=true 授予信任。 */
  onDecision: (trusted: boolean) => void;
  /** Esc 关闭（视作本次不信任，危险配置不加载）。 */
  onClose: () => void;
}

/** 展示上限，避免过长清单撑爆对话框。 */
const MAX_ITEMS_SHOWN = 6;

/** 检查项类型 → 中文标签（不用 emoji，遵循 L1.1）。 */
const TYPE_LABELS: Record<TrustCheckItem["type"], string> = {
  hooks: "Hook",
  mcp_servers: "MCP 服务器",
  env_vars: "环境变量",
  bash_permissions: "Bash 权限规则",
};

/** 类型标签列宽：「› Bash 权限规则:」= 2 + 13 + 1 = 16 列，再留 1 列间隔 */
const TYPE_COL_WIDTH = Math.max(...Object.values(TYPE_LABELS).map((l) => stringWidth(l))) + 4;
/** details 预览的显示宽度上限（原 120 码元，改为 120 显示列） */
const DETAILS_MAX_WIDTH = 120;

export const TrustDialog: React.FC<Props> = ({ items, workspacePath, onDecision, onClose }) => {
  useKeypress(KeypressPriority.Critical, (key: Key) => {
    if (key.name === "escape") {
      onClose();
      return true;
    }
    return false;
  });

  const shown = items.slice(0, MAX_ITEMS_SHOWN);
  const extra = items.length - shown.length;

  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor={theme.status.warning}
      paddingX={1}
      paddingY={0}
    >
      <Text bold color={theme.status.warning}>
        是否信任此代码库？
      </Text>
      <Box marginTop={1} flexDirection="column">
        <Text color={theme.text.secondary}>
          此目录的 .sid-code/settings.json 含可执行配置。信任后它们会在本次及后续会话中加载——
          恶意项目可借此在你的机器上执行任意命令。请确认这是你信任的代码库。
        </Text>
      </Box>
      <Box marginTop={1}>
        <Text color={theme.text.secondary}>目录: </Text>
        <Text color={theme.ui.active}>{workspacePath}</Text>
      </Box>
      <Box marginTop={1} flexDirection="column">
        {/* 安全闸门：描述不截断（用户要看清在授权什么），改为标签列定宽 + 描述在本列内换行。
            旧实现三段 Text 平铺，长描述会挤压类型标签、换行后起点漂移到行首。
            details 原先 .slice(0,120) 按码元截（CJK 超宽、换行不压），改为按显示宽截断。 */}
        {shown.map((item, i) => (
          <Box key={`${item.type}-${i}`} flexDirection="column">
            <Box flexDirection="row">
              <Box width={TYPE_COL_WIDTH} flexShrink={0}>
                <Text>
                  <Text color={theme.status.warning}>{ARROW_PROMPT} </Text>
                  <Text color={theme.text.primary}>{TYPE_LABELS[item.type]}:</Text>
                </Text>
              </Box>
              <Box flexGrow={1} flexShrink={1}>
                <Text color={theme.text.secondary}>{oneLine(item.description)}</Text>
              </Box>
            </Box>
            {item.details ? (
              <Box paddingLeft={TYPE_COL_WIDTH}>
                <Text wrap="truncate">{clipLine(item.details, DETAILS_MAX_WIDTH)}</Text>
              </Box>
            ) : null}
          </Box>
        ))}
        {extra > 0 && <Text> …等共 {items.length} 项</Text>}
      </Box>
      <Box marginTop={1} flexDirection="column">
        <BaseSelectionList<boolean, ChoiceItem>
          items={OPTIONS}
          // 安全默认（L4-E）：初始聚焦「不信任」，手滑回车不授予信任
          initialIndex={1}
          onSelect={(v) => onDecision(v)}
          isFocused={true}
          showNumbers={false}
          maxItemsToShow={2}
          selectedIndicator={ARROW_PROMPT}
          renderItem={(item, { isSelected }) => (
            <Box>
              <Text color={isSelected ? theme.ui.focus : theme.text.primary}>{item.label}</Text>
              <Text color={theme.text.secondary}> {item.desc}</Text>
            </Box>
          )}
        />
      </Box>
      <Box marginTop={1} flexDirection="column">
        {/* 点破取舍：hooks/MCP 在启动早期就初始化完了，本次会话不热加载。
            不说清会让用户点了"信任"却发现 hook 没生效，还不知道为什么。 */}
        <Text>这些配置已在本次启动时跳过；选择信任后于下次启动生效。</Text>
        <Text italic>Esc 视作不信任</Text>
      </Box>
    </Box>
  );
};
