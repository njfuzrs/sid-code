/**
 * TUI 权限确认组件
 * 显示权限请求详情，支持 y/n/a 三种选择
 * y = 允许本次, n = 拒绝, a = 本次会话内始终允许
 *
 * 视觉语言：圆角边框（对齐输入框 round 风格），按键字母用品牌色高亮，
 * 操作项分隔清晰，让高频决策点一眼可辨。
 *
 * 危险操作（rm -rf / / dd / mkfs / fork 炸弹 / curl|sh 等，isDestructiveCommand 判定）：
 * 边框与标题改用 error 红、标题标注「危险操作」、并安全默认聚焦「拒绝」——
 * Enter 直接触发拒绝（普通确认 Enter 仍是空操作，无误确认路径）。对齐 src/ui/CLAUDE.md L4-E。
 */

import React, { useRef } from "react";
import Box from "../../ink/components/Box.js";
import Text from "../../ink/components/Text.js";
import { useKeypress, KeypressPriority } from "../contexts/KeypressContext.tsx";
import type { Color } from "../../ink/styles.js";
import { theme } from "../semantic-colors.ts";
import { BULLET, WARNING_MARK } from "../constants/figures.ts";
import { isDestructiveCommand } from "../../tool/bash/read-only-validation.ts";

/** 权限确认请求信息 */
export interface PermissionPromptRequest {
  toolName: string;
  toolInput: unknown;
  description?: string;
  reason?: string;
  /**
   * 决策结果：
   * - yes            允许本次
   * - no             拒绝
   * - always         本会话始终允许（sessionMemory）
   * - always-persist 持久化到项目 settings（跨会话，P2-3；仅 Bash 工具提供此档）
   */
  resolve: (result: "yes" | "no" | "always" | "always-persist") => void;
}

/** 单个操作项：高亮按键 + 说明 */
const ActionKey: React.FC<{ keyLabel: string; desc: string; color: Color }> = ({
  keyLabel,
  desc,
  color,
}) => (
  <Text>
    <Text color={color} bold>{keyLabel}</Text>
    <Text color={theme.text.secondary}>{` ${desc}`}</Text>
  </Text>
);

/** 权限确认组件 */
export function PermissionPrompt({ request }: { request: PermissionPromptRequest }) {
  const resolvedRef = useRef(false);

  // 提取关键参数用于显示
  const input = request.toolInput as any;
  const detail = input?.file_path || input?.command || input?.pattern || "";

  // 危险性检测：仅对 bash/shell 类命令做破坏性判定（rm -rf / / dd / mkfs 等）。
  // 危险时走标红 + 安全默认拒绝路径。其它工具维持常态确认。
  const command: string = typeof input?.command === "string" ? input.command : "";
  const isDangerous = command.length > 0 && isDestructiveCommand(command);
  // P2-3：仅 Bash 工具提供「持久化到项目配置」档；危险命令不提供持久档（避免一键永久放行破坏性命令）。
  const isBashTool = request.toolName === "bash" && !isDangerous;

  const accentColor = isDangerous ? theme.status.error : theme.status.warning;
  const title = isDangerous ? "危险操作 · 权限请求" : "权限请求";

  useKeypress(KeypressPriority.Critical, (key) => {
    if (resolvedRef.current) return false;

    // 安全默认：危险操作下 Enter 直接拒绝（默认聚焦「拒绝」，手滑回车不造成破坏）。
    // 普通确认无默认值，Enter 不可插入、保持空操作，避免误确认。
    if (isDangerous && key.name === "enter") {
      resolvedRef.current = true;
      request.resolve("no");
      return true;
    }

    if (!key.insertable) return false;

    const lower = key.name;
    if (lower === "y") {
      resolvedRef.current = true;
      request.resolve("yes");
      return true;
    }
    if (lower === "n") {
      resolvedRef.current = true;
      request.resolve("no");
      return true;
    }
    // P2-3：Bash 工具额外提供「A 持久化到项目配置」档（跨会话生效）。
    // Shift+A 上报的 key.name 仍是 "a" 但带 shift 修饰；须先于裸 a 判定，否则被裸 a 截胡。
    // 文件编辑类不提供持久档（对齐 CC「Edit always 仅会话」）。
    if (isBashTool && lower === "a" && key.shift) {
      resolvedRef.current = true;
      request.resolve("always-persist");
      return true;
    }
    if (lower === "a") {
      resolvedRef.current = true;
      request.resolve("always");
      return true;
    }
    return false;
  });

  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor={accentColor}
      paddingX={1}
    >
      {/* 标题行：危险=红、普通=警告黄，圆点 + 标题 */}
      <Box>
        <Text color={accentColor} bold>{`${BULLET} ${title}`}</Text>
      </Box>

      {/* 详情：工具名高亮，参数/原因柔和 */}
      <Box marginTop={1} flexDirection="column">
        <Box>
          <Text color={theme.text.secondary}>{"工具  "}</Text>
          <Text color={theme.text.primary} bold>{request.toolName}</Text>
        </Box>
        {detail && (
          <Box>
            <Text color={theme.text.secondary}>{"参数  "}</Text>
            <Text color={isDangerous ? theme.status.error : theme.text.secondary}>{String(detail).length > 120 ? String(detail).slice(0, 120) + "…" : String(detail)}</Text>
          </Box>
        )}
        {request.reason && (
          <Box>
            <Text color={theme.text.secondary}>{"原因  "}</Text>
            <Text color={accentColor}>{request.reason}</Text>
          </Box>
        )}
        {isDangerous && (
          <Box marginTop={1}>
            <Text color={theme.status.error} bold>{`${WARNING_MARK} 此操作具有破坏性且不可逆，默认拒绝（按 n 或回车）`}</Text>
          </Box>
        )}
      </Box>

      {/* 操作行：按键字母高亮，绿/红/蓝区分语义 */}
      <Box marginTop={1} gap={2}>
        <ActionKey keyLabel="y" desc="允许" color={theme.status.success} />
        <ActionKey keyLabel="n" desc={isDangerous ? "拒绝（默认）" : "拒绝"} color={theme.status.error} />
        <ActionKey keyLabel="a" desc={isBashTool ? "本会话始终允许" : "始终允许"} color={theme.ui.active} />
        {isBashTool && (
          <ActionKey keyLabel="A" desc="持久化到项目配置" color={theme.ui.active} />
        )}
      </Box>
    </Box>
  );
}
