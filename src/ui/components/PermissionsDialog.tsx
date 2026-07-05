/**
 * 权限管理面板（/permissions 无参时打开）
 *
 * 展示当前权限模式 + 规则摘要 + 操作提示。
 * 规则的实际 CRUD 仍通过 /allow、/deny 命令操作（与 cc 对齐：面板做信息展示，子命令做修改）。
 *
 * 面板数据来自 Config（permissionMode / allowedTools / disallowedTools）。
 */

import React from "react";
import Box from "../../ink/components/Box.js";
import Text from "../../ink/components/Text.js";
import { theme } from "../semantic-colors.ts";
import { useKeypress, KeypressPriority, type Key } from "../contexts/KeypressContext.tsx";
import { SUCCESS_MARK, ERROR_MARK, WARNING_MARK } from "../constants/figures.ts";
import type { Config } from "../../config/config.ts";
import type { SessionState } from "../../session/state.ts";

interface PermissionsDialogProps {
  onClose: () => void;
  config?: Config;
  sessionState?: SessionState;
}

const MODE_LABELS: Record<string, { label: string; color: string; desc: string }> = {
  default: { label: "default (ask)", color: theme.status.warning, desc: "每次工具调用弹窗确认" },
  "skip-perms": { label: "skip-perms", color: theme.status.success, desc: "跳过所有权限确认" },
  plan: { label: "plan", color: theme.ui.active, desc: "仅 plan 模式批准后执行" },
};

export const PermissionsDialog: React.FC<PermissionsDialogProps> = ({ onClose, config }) => {
  useKeypress(KeypressPriority.Critical, (key: Key) => {
    if (key.name === "escape") {
      onClose();
      return true;
    }
    return false;
  });

  const mode = config?.permissionMode ?? "default";
  const modeInfo = MODE_LABELS[mode] ?? { label: mode, color: theme.text.primary, desc: "" };

  const allowedTools = config?.allowedTools ?? [];
  const disallowedTools = config?.disallowedTools ?? [];

  return (
    <Box flexDirection="column" borderStyle="round" borderColor={theme.ui.active} paddingX={1} paddingY={0}>
      <Text bold color={theme.ui.active}>权限管理</Text>

      {/* 权限模式 */}
      <Box marginTop={1} flexDirection="column">
        <Text bold color={theme.text.primary}>权限模式</Text>
        <Box paddingLeft={2}>
          <Text color={modeInfo.color}>{modeInfo.label}</Text>
          {modeInfo.desc && <Text color={theme.text.secondary}> — {modeInfo.desc}</Text>}
        </Box>
      </Box>

      {/* Allow 规则 */}
      <Box marginTop={1} flexDirection="column">
        <Text bold color={theme.text.primary}>Allow 规则 ({allowedTools.length})</Text>
        {allowedTools.length === 0 ? (
          <Box paddingLeft={2}>
            <Text color={theme.text.secondary}>（无显式 allow 规则）</Text>
          </Box>
        ) : (
          allowedTools.slice(0, 10).map((rule, i) => (
            <Box key={i} paddingLeft={2}>
              <Text color={theme.status.success}>{SUCCESS_MARK} </Text>
              <Text color={theme.text.primary}>{rule}</Text>
            </Box>
          ))
        )}
        {allowedTools.length > 10 && (
          <Box paddingLeft={2}>
            <Text dimColor>… 还有 {allowedTools.length - 10} 条</Text>
          </Box>
        )}
      </Box>

      {/* Deny 规则 */}
      <Box marginTop={1} flexDirection="column">
        <Text bold color={theme.text.primary}>Deny 规则 ({disallowedTools.length})</Text>
        {disallowedTools.length === 0 ? (
          <Box paddingLeft={2}>
            <Text color={theme.text.secondary}>（无显式 deny 规则）</Text>
          </Box>
        ) : (
          disallowedTools.slice(0, 10).map((rule, i) => (
            <Box key={i} paddingLeft={2}>
              <Text color={theme.status.error}>{ERROR_MARK} </Text>
              <Text color={theme.text.primary}>{rule}</Text>
            </Box>
          ))
        )}
        {disallowedTools.length > 10 && (
          <Box paddingLeft={2}>
            <Text dimColor>… 还有 {disallowedTools.length - 10} 条</Text>
          </Box>
        )}
      </Box>

      {/* 操作提示 */}
      <Box marginTop={1} flexDirection="column">
        <Text bold color={theme.text.primary}>操作</Text>
        <Box paddingLeft={2} flexDirection="column">
          <Text color={theme.text.secondary}>{WARNING_MARK} /allow &lt;规则&gt; — 添加 allow 规则</Text>
          <Text color={theme.text.secondary}>{WARNING_MARK} /deny &lt;规则&gt;  — 添加 deny 规则</Text>
          <Text color={theme.text.secondary}>{WARNING_MARK} /permissions list — 查看完整规则列表</Text>
        </Box>
      </Box>

      <Box marginTop={1}>
        <Text dimColor italic>Esc 关闭</Text>
      </Box>
    </Box>
  );
};
