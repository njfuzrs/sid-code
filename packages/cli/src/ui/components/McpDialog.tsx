/**
 * MCP 交互式管理面板
 * 对标 Claude Code 的 /mcp 面板交互体验
 *
 * 状态机：
 *   list → server-menu（Enter 选中）
 *   server-menu → tools（查看工具）/ list（Esc）
 *   tools → tool-detail（Enter）/ server-menu（Esc）
 *   tool-detail → tools（Esc）
 */

import React, { useState, useEffect, useCallback } from "react";
import Box from "@sid-code/tui-renderer/components/Box.tsx";
import Text from "@sid-code/tui-renderer/components/Text.tsx";
import { theme } from "../semantic-colors.ts";
import type { Color } from "@sid-code/tui-renderer/styles.ts";
import { useKeypress, KeypressPriority, type Key } from "../contexts/KeypressContext.tsx";
import { BaseSelectionList, type SelectionListItem } from "./shared/BaseSelectionList.tsx";
import {
  SUCCESS_MARK,
  ERROR_MARK,
  TODO_PENDING,
  WARNING_MARK,
  ARROW_PROMPT,
} from "../constants/figures.ts";
import type { MCPManager, MCPServerStatusInfo } from "@sid-code/core/mcp/manager.ts";
import type { MCPToolDefinition } from "@sid-code/core/mcp/types.ts";
import type { MCPConnectionStatus } from "@sid-code/core/mcp/types.ts";
import type { SessionState } from "@sid-code/core/session/state.ts";

// ─── Props ───

interface McpDialogProps {
  onClose: () => void;
  mcpManager: MCPManager;
  sessionState: SessionState;
}

// ─── 状态机 ───

type ViewState =
  | { type: "list" }
  | { type: "server-menu"; server: MCPServerStatusInfo }
  | { type: "tools"; server: MCPServerStatusInfo; tools: MCPToolDefinition[] }
  | {
      type: "tool-detail";
      server: MCPServerStatusInfo;
      tool: MCPToolDefinition;
      tools: MCPToolDefinition[];
    };

// ─── 服务器菜单项 ───

interface MenuAction {
  key: string;
  label: string;
  action: string;
  disabled?: boolean;
}

// ─── 辅助函数 ───

function getStatusIcon(status: MCPConnectionStatus | string): { icon: string; color: Color } {
  switch (status) {
    case "connected":
      return { icon: SUCCESS_MARK, color: theme.status.success };
    case "failed":
    case "disconnected":
      return { icon: ERROR_MARK, color: theme.status.error };
    case "connecting":
    case "reconnecting":
      return { icon: TODO_PENDING, color: theme.text.secondary };
    case "disabled":
      return { icon: TODO_PENDING, color: theme.text.secondary };
    default:
      return { icon: WARNING_MARK, color: theme.status.warning };
  }
}

function getStatusText(server: MCPServerStatusInfo): string {
  const texts: Record<string, string> = {
    connected: "已连接",
    connecting: "连接中",
    reconnecting: `重连中 (${server.reconnectAttempts ?? 0}/5)`,
    failed: "连接失败",
    disabled: "已禁用",
    disconnected: "未连接",
  };
  return texts[server.status] || server.status;
}

// ─── 主组件 ───

export const McpDialog: React.FC<McpDialogProps> = ({ onClose, mcpManager, sessionState }) => {
  const [viewState, setViewState] = useState<ViewState>({ type: "list" });
  const [servers, setServers] = useState<MCPServerStatusInfo[]>([]);
  const [feedbackMessage, setFeedbackMessage] = useState<string>("");

  // 刷新服务器列表
  const refreshServers = useCallback(() => {
    setServers(mcpManager.getStatus());
  }, [mcpManager]);

  useEffect(() => {
    refreshServers();
  }, [refreshServers]);

  // 根据视图状态渲染
  switch (viewState.type) {
    case "list":
      return (
        <McpServerList
          servers={servers}
          onClose={onClose}
          onSelectServer={(s) => setViewState({ type: "server-menu", server: s })}
        />
      );
    case "server-menu":
      return (
        <McpServerMenu
          server={viewState.server}
          mcpManager={mcpManager}
          sessionState={sessionState}
          feedbackMessage={feedbackMessage}
          onBack={() => {
            setFeedbackMessage("");
            refreshServers();
            setViewState({ type: "list" });
          }}
          onViewTools={async () => {
            const tools = await mcpManager.listServerTools(viewState.server.name);
            setViewState({ type: "tools", server: viewState.server, tools });
          }}
          onFeedback={setFeedbackMessage}
          onRefresh={() => {
            refreshServers();
            // 同步更新 server-menu 中的 server 状态
            const updated = mcpManager.getStatus().find((s) => s.name === viewState.server.name);
            if (updated) setViewState({ type: "server-menu", server: updated });
          }}
        />
      );
    case "tools":
      return (
        <McpToolList
          server={viewState.server}
          tools={viewState.tools}
          onBack={() => setViewState({ type: "server-menu", server: viewState.server })}
          onSelectTool={(tool) =>
            setViewState({
              type: "tool-detail",
              server: viewState.server,
              tool,
              tools: viewState.tools,
            })
          }
        />
      );
    case "tool-detail":
      return (
        <McpToolDetail
          server={viewState.server}
          tool={viewState.tool}
          onBack={() => {
            setViewState({ type: "tools", server: viewState.server, tools: viewState.tools });
          }}
        />
      );
  }
};

// ─── 子组件：服务器列表 ───

interface McpServerListProps {
  servers: MCPServerStatusInfo[];
  onClose: () => void;
  onSelectServer: (server: MCPServerStatusInfo) => void;
}

const McpServerList: React.FC<McpServerListProps> = ({ servers, onClose, onSelectServer }) => {
  // Esc 关闭
  useKeypress(KeypressPriority.Critical, (key: Key) => {
    if (key.name === "escape") {
      onClose();
      return true;
    }
    return false;
  });

  if (servers.length === 0) {
    return (
      <Box
        flexDirection="column"
        borderStyle="round"
        borderColor={theme.ui.active}
        paddingX={1}
        paddingY={0}
      >
        <Text bold color={theme.ui.active}>
          MCP 服务器管理
        </Text>
        <Box marginTop={1}>
          <Text color={theme.text.secondary}>未配置 MCP 服务器</Text>
        </Box>
        <Text>在 ~/.sid-code/settings.json 或项目 .mcp.json 中添加 mcpServers 配置</Text>
        <Box marginTop={1}>
          <Text italic>Esc 关闭</Text>
        </Box>
      </Box>
    );
  }

  const items: Array<SelectionListItem<MCPServerStatusInfo> & { label: string }> = servers.map(
    (s) => ({
      value: s,
      key: s.name,
      label: s.name,
    }),
  );

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
          MCP 服务器管理
        </Text>
        <Text color={theme.text.secondary}> · {servers.length} 个服务器</Text>
      </Box>
      <Box marginTop={1} flexDirection="column">
        <BaseSelectionList<
          MCPServerStatusInfo,
          SelectionListItem<MCPServerStatusInfo> & { label: string }
        >
          items={items}
          onSelect={(server) => onSelectServer(server)}
          showNumbers={false}
          maxItemsToShow={12}
          selectedIndicator={ARROW_PROMPT}
          renderItem={(item, { isSelected }) => {
            const { icon, color } = getStatusIcon(item.value.status);
            const counts: string[] = [];
            if (item.value.status === "connected") {
              counts.push(`${item.value.toolCount} 工具`);
              if (item.value.resourceCount > 0) counts.push(`${item.value.resourceCount} 资源`);
              if (item.value.promptCount > 0) counts.push(`${item.value.promptCount} 提示词`);
            }
            const countsStr = counts.length > 0 ? ` [${counts.join(", ")}]` : "";
            const errorStr = item.value.error ? ` - ${item.value.error}` : "";

            return (
              <Box>
                <Text color={isSelected ? theme.ui.focus : theme.text.primary}>
                  {item.value.name}
                </Text>
                <Text color={theme.text.secondary}> ({item.value.transport}) </Text>
                <Text color={color}>{icon}</Text>
                <Text color={theme.text.secondary}> {getStatusText(item.value)}</Text>
                {countsStr && <Text color={theme.text.secondary}>{countsStr}</Text>}
                {errorStr && <Text color={theme.status.error}>{errorStr}</Text>}
              </Box>
            );
          }}
        />
      </Box>
      <Box marginTop={1}>
        <Text italic>↑↓ 导航 · Enter 选择 · Esc 关闭</Text>
      </Box>
    </Box>
  );
};

// ─── 子组件：服务器操作菜单 ───

interface McpServerMenuProps {
  server: MCPServerStatusInfo;
  mcpManager: MCPManager;
  sessionState: SessionState;
  feedbackMessage: string;
  onBack: () => void;
  onViewTools: () => void;
  onFeedback: (msg: string) => void;
  onRefresh: () => void;
}

const McpServerMenu: React.FC<McpServerMenuProps> = ({
  server,
  mcpManager,
  sessionState,
  feedbackMessage,
  onBack,
  onViewTools,
  onFeedback,
  onRefresh,
}) => {
  const [loading, setLoading] = useState(false);

  // Esc 返回
  useKeypress(KeypressPriority.Critical, (key: Key) => {
    if (key.name === "escape") {
      onBack();
      return true;
    }
    return false;
  });

  // 构建菜单项
  const isConnected = server.status === "connected";
  const isDisabled = server.status === "disabled";
  const hasTools = isConnected && server.toolCount > 0;
  const isOAuth = mcpManager.listOAuthServers().includes(server.name);

  const menuItems: MenuAction[] = [];

  if (hasTools) {
    menuItems.push({ key: "tools", label: `查看工具 (${server.toolCount})`, action: "tools" });
  }

  if (!isDisabled) {
    menuItems.push({ key: "reconnect", label: "重新连接", action: "reconnect" });
  }

  if (isDisabled) {
    menuItems.push({ key: "enable", label: "启用", action: "enable" });
  } else {
    menuItems.push({ key: "disable", label: "禁用", action: "disable" });
  }

  if (isOAuth) {
    menuItems.push({ key: "auth", label: "OAuth 授权", action: "auth" });
  }

  const items: Array<SelectionListItem<string> & { label: string }> = menuItems.map((m) => ({
    value: m.action,
    key: m.key,
    label: m.label,
    disabled: m.disabled,
  }));

  const handleAction = async (action: string) => {
    if (loading) return;
    setLoading(true);
    onFeedback("");

    try {
      switch (action) {
        case "tools":
          setLoading(false);
          onViewTools();
          return;
        case "reconnect": {
          onFeedback("重连中…");
          const tools = await mcpManager.reconnectServer(server.name);
          onFeedback(`重连成功，注册 ${tools.length} 个工具`);
          onRefresh();
          break;
        }
        case "enable": {
          const disabled = (sessionState.get("mcp_disabled") as string[]) || [];
          const newDisabled = disabled.filter((n) => n !== server.name);
          sessionState.set("mcp_disabled", newDisabled);
          onFeedback(`"${server.name}" 已在当前会话启用`);
          onRefresh();
          break;
        }
        case "disable": {
          const disabled = (sessionState.get("mcp_disabled") as string[]) || [];
          if (!disabled.includes(server.name)) {
            disabled.push(server.name);
            sessionState.set("mcp_disabled", disabled);
          }
          onFeedback(`"${server.name}" 已在当前会话禁用`);
          onRefresh();
          break;
        }
        case "auth": {
          onFeedback("授权中…");
          const tools = await mcpManager.authenticate(server.name);
          onFeedback(`OAuth 授权成功，注册 ${tools.length} 个工具`);
          onRefresh();
          break;
        }
      }
    } catch (err: any) {
      onFeedback(`操作失败: ${err.message}`);
    } finally {
      setLoading(false);
    }
  };

  const { icon, color } = getStatusIcon(server.status);

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
          {server.name}
        </Text>
        <Text color={theme.text.secondary}> ({server.transport}) </Text>
        <Text color={color}>
          {icon} {getStatusText(server)}
        </Text>
      </Box>

      {server.error && <Text color={theme.status.error}> 错误: {server.error}</Text>}

      <Box marginTop={1} flexDirection="column">
        {loading ? (
          <Text color={theme.text.secondary}>{feedbackMessage || "处理中…"}</Text>
        ) : (
          <BaseSelectionList<string, SelectionListItem<string> & { label: string }>
            items={items}
            onSelect={handleAction}
            showNumbers={false}
            maxItemsToShow={8}
            selectedIndicator={ARROW_PROMPT}
            renderItem={(item, { isSelected }) => (
              <Text color={isSelected ? theme.ui.focus : theme.text.primary}>{item.label}</Text>
            )}
          />
        )}
      </Box>

      {feedbackMessage && !loading && (
        <Box marginTop={1}>
          <Text color={theme.status.success}>{feedbackMessage}</Text>
        </Box>
      )}

      <Box marginTop={1}>
        <Text italic>↑↓ 导航 · Enter 选择 · Esc 返回</Text>
      </Box>
    </Box>
  );
};

// ─── 子组件：工具列表 ───

interface McpToolListProps {
  server: MCPServerStatusInfo;
  tools: MCPToolDefinition[];
  onBack: () => void;
  onSelectTool: (tool: MCPToolDefinition) => void;
}

const McpToolList: React.FC<McpToolListProps> = ({ server, tools, onBack, onSelectTool }) => {
  useKeypress(KeypressPriority.Critical, (key: Key) => {
    if (key.name === "escape") {
      onBack();
      return true;
    }
    return false;
  });

  if (tools.length === 0) {
    return (
      <Box
        flexDirection="column"
        borderStyle="round"
        borderColor={theme.ui.active}
        paddingX={1}
        paddingY={0}
      >
        <Text bold color={theme.ui.active}>
          {server.name} · 工具
        </Text>
        <Box marginTop={1}>
          <Text color={theme.text.secondary}>该服务器没有可用工具</Text>
        </Box>
        <Box marginTop={1}>
          <Text italic>Esc 返回</Text>
        </Box>
      </Box>
    );
  }

  const items: Array<SelectionListItem<MCPToolDefinition> & { label: string }> = tools.map(
    (t, i) => ({
      value: t,
      key: `tool-${i}`,
      label: t.name,
    }),
  );

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
          {server.name}
        </Text>
        <Text color={theme.text.secondary}> · {tools.length} 个工具</Text>
      </Box>
      <Box marginTop={1} flexDirection="column">
        <BaseSelectionList<
          MCPToolDefinition,
          SelectionListItem<MCPToolDefinition> & { label: string }
        >
          items={items}
          onSelect={(tool) => onSelectTool(tool)}
          showNumbers={true}
          maxItemsToShow={15}
          selectedIndicator={ARROW_PROMPT}
          renderItem={(item, { titleColor }) => (
            <Box>
              <Text color={titleColor}>{item.value.name}</Text>
              {item.value.description && (
                <Text color={theme.text.secondary}>
                  {" "}
                  — {item.value.description.slice(0, 60)}
                  {item.value.description.length > 60 ? "…" : ""}
                </Text>
              )}
            </Box>
          )}
        />
      </Box>
      <Box marginTop={1}>
        <Text italic>↑↓ 导航 · Enter 查看详情 · Esc 返回</Text>
      </Box>
    </Box>
  );
};

// ─── 子组件：工具详情 ───

interface McpToolDetailProps {
  server: MCPServerStatusInfo;
  tool: MCPToolDefinition;
  onBack: () => void;
}

const McpToolDetail: React.FC<McpToolDetailProps> = ({ server, tool, onBack }) => {
  useKeypress(KeypressPriority.Critical, (key: Key) => {
    if (key.name === "escape") {
      onBack();
      return true;
    }
    return false;
  });

  // 格式化 schema 为缩进 JSON（截断防溢出）
  let schemaStr = "";
  try {
    schemaStr = JSON.stringify(tool.inputSchema, null, 2);
    if (schemaStr.length > 2000) {
      schemaStr = schemaStr.slice(0, 2000) + "\n  [截断]";
    }
  } catch {
    schemaStr = "(无法序列化)";
  }

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
          {tool.name}
        </Text>
        <Text color={theme.text.secondary}> — {server.name}</Text>
      </Box>

      {tool.description && (
        <Box marginTop={1}>
          <Text>{tool.description}</Text>
        </Box>
      )}

      <Box marginTop={1} flexDirection="column">
        <Text bold color={theme.text.secondary}>
          Input Schema:
        </Text>
        <Text color={theme.text.secondary}>{schemaStr}</Text>
      </Box>

      {tool.annotations && (
        <Box marginTop={1} flexDirection="column">
          <Text bold color={theme.text.secondary}>
            Annotations:
          </Text>
          <Text color={theme.text.secondary}>{JSON.stringify(tool.annotations, null, 2)}</Text>
        </Box>
      )}

      <Box marginTop={1}>
        <Text italic>Esc 返回</Text>
      </Box>
    </Box>
  );
};
