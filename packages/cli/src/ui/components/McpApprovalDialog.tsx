/**
 * 项目级 MCP 服务器启动审批对话框（M3）
 *
 * 项目 .mcp.json 声明了、但用户从未批准 / 拒绝过的 server 是 fail-closed 的：不进生效列表。
 * 此前启动时**没有任何提示**，只有一条 info 日志 —— 用户看到的是「server 不见了」，
 * 不知道要去 `/mcp approve`。M1 让 .mcp.json 向上逐级查找之后，新发现的祖先目录 server
 * 全部会落进这个状态，没有入口就等于 M1 修了个寂寞。
 *
 * 对齐 CC 的 MCPServerApprovalDialog：一次问一个，选项 批准 / 本项目全部批准 / 拒绝。
 * 安全默认（src/ui/CLAUDE.md L4-E）：初始聚焦「拒绝」—— 拒绝可经 `sid-code mcp approve`
 * 撤销，而手滑批准会当场拉起一个外部进程。Esc = 暂不决定（本会话不加载，下次启动再问）。
 */

import React, { useState } from "react";
import { Box } from "../render-port/components.ts";
import { Text } from "../render-port/components.ts";
import { theme } from "../semantic-colors.ts";
import { BaseSelectionList, type SelectionListItem } from "./shared/BaseSelectionList.tsx";
import { ARROW_PROMPT } from "../constants/figures.ts";
import { useKeypress, KeypressPriority, type Key } from "../contexts/KeypressContext.tsx";

export type McpApprovalChoice = "approve" | "approve-all" | "reject";

interface ChoiceItem extends SelectionListItem<McpApprovalChoice> {
  label: string;
  desc: string;
}

const OPTIONS: ChoiceItem[] = [
  { value: "approve", key: "approve", label: "批准", desc: "连接此服务器（记住选择）" },
  {
    value: "approve-all",
    key: "approve-all",
    label: "批准本项目全部",
    desc: "含本项目 .mcp.json 以后新增的服务器",
  },
  { value: "reject", key: "reject", label: "拒绝", desc: "不连接，后续启动不再询问" },
];

interface Props {
  /** 当前要审批的 server 名 */
  serverName: string;
  /** 还剩几个待审批（含当前），>1 时提示 */
  remaining: number;
  /** server 的启动命令 / URL，给用户过目 */
  target?: string;
  onDecision: (choice: McpApprovalChoice) => void;
  /** Esc：暂不决定 */
  onClose: () => void;
}

export const McpApprovalDialog: React.FC<Props> = ({
  serverName,
  remaining,
  target,
  onDecision,
  onClose,
}) => {
  useKeypress(KeypressPriority.Critical, (key: Key) => {
    if (key.name === "escape") {
      onClose();
      return true;
    }
    return false;
  });

  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor={theme.status.warning}
      paddingX={1}
      paddingY={0}
    >
      <Text bold color={theme.status.warning}>
        发现项目 .mcp.json 中的新 MCP 服务器
      </Text>
      <Box marginTop={1} flexDirection="column">
        <Text color={theme.text.secondary}>
          项目级 MCP 服务器会在你的机器上启动外部进程或连接外部地址。请确认来源可信再批准。
        </Text>
      </Box>
      <Box marginTop={1}>
        <Text color={theme.text.secondary}>服务器: </Text>
        <Text color={theme.ui.active}>{serverName}</Text>
        {remaining > 1 ? (
          <Text color={theme.text.secondary}>（还有 {remaining - 1} 个待审批）</Text>
        ) : null}
      </Box>
      {target ? (
        <Box>
          <Text color={theme.text.secondary}>命令: {target.slice(0, 160)}</Text>
        </Box>
      ) : null}
      <Box marginTop={1} flexDirection="column">
        <BaseSelectionList<McpApprovalChoice, ChoiceItem>
          items={OPTIONS}
          initialIndex={2}
          onSelect={(v) => onDecision(v)}
          isFocused={true}
          showNumbers={false}
          maxItemsToShow={3}
          selectedIndicator={ARROW_PROMPT}
          renderItem={(item, { isSelected }) => (
            <Box>
              <Text color={isSelected ? theme.ui.focus : theme.text.primary}>{item.label}</Text>
              <Text color={theme.text.secondary}> {item.desc}</Text>
            </Box>
          )}
        />
      </Box>
      <Box marginTop={1}>
        <Text italic>Esc 暂不决定（本会话不加载，下次启动再问）</Text>
      </Box>
    </Box>
  );
};

/**
 * 逐个审批的队列外壳。队列在打开时取一次快照、进度存在组件 state 里 ——
 * 待审批列表活在 core 的模块单例里，不是 React state，靠「读外部列表 + 期望重渲染」
 * 推进会在第一个之后卡住不动。
 */
export const McpApprovalQueue: React.FC<{
  pending: Array<{ name: string; target?: string }>;
  onDecision: (name: string, choice: McpApprovalChoice | "skip") => void | Promise<void>;
  onDone: () => void;
}> = ({ pending, onDecision, onDone }) => {
  const [queue] = useState(pending);
  const [index, setIndex] = useState(0);
  const head = queue[index];
  if (!head) return null;
  return (
    <McpApprovalDialog
      key={head.name}
      serverName={head.name}
      remaining={queue.length - index}
      target={head.target}
      onDecision={async (choice) => {
        await onDecision(head.name, choice);
        // 「批准本项目全部」已经把剩余项一起处理掉了
        if (choice === "approve-all" || index + 1 >= queue.length) onDone();
        else setIndex(index + 1);
      }}
      onClose={async () => {
        await onDecision(head.name, "skip");
        onDone();
      }}
    />
  );
};
