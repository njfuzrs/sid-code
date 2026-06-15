/**
 * AppHeader 组件
 *
 * 显示在消息列表顶部，随消息一起滚动。
 * 包含：Logo（渐变文本）、版本号、Tips。
 *
 * 参考 gemini-cli AppHeader.tsx
 */

import React from "react";
import Box from "../../ink/components/Box.js";
import Text from "../../ink/components/Text.js";
import { ThemedGradient } from "./ThemedGradient.tsx";
import { theme } from "../semantic-colors.ts";
import { DEFAULT_BINDINGS } from "../keybindings/defaultBindings.ts";
import { ARROW_PROMPT } from "../constants/figures.ts";

const LOGO = `   _____ _     _     _____          _
  / ____(_)   | |   / ____|        | |
 | (___  _  __| |  | |     ___   __| | ___
  \\___ \\| |/ _\` |  | |    / _ \\ / _\` |/ _ \\
  ____) | | (_| |  | |___| (_) | (_| |  __/
 |_____/|_|\\__,_|   \\_____\\___/ \\__,_|\\___|`;

/**
 * Tips 来源说明（如何与最新功能联动）：
 *
 * 1. 键位类 tips —— **自动派生**，无需手动维护。
 *    从 `keybindings/defaultBindings.ts` 的 DEFAULT_BINDINGS 单一数据源生成，
 *    任何键位的新增 / 改名 / 改键都会自动反映到 tips（真正的"联动"）。
 *    新增一个 `showInHelp: true` 的键位 → 它会自动出现在 tips 轮播里。
 *    若某个键位太基础、不值得当 startup tip（如退出 / 取消），加进
 *    TIP_EXCLUDED_ACTIONS 即可从 tips 中剔除（仍保留在帮助页）。
 *
 * 2. 命令 / 功能类 tips —— **手动维护**，在下方 COMMAND_TIPS 增删。
 *    斜杠命令很多（见 command/builtins.ts），并非每个都值得开屏提示，
 *    所以这里只挑"高频 / 易被忽略 / 能省 token / 能救场"的命令做引导。
 *    新增一个值得让用户知道的命令时，往 COMMAND_TIPS 加一行即可。
 */

/** 不值得作为开屏 tip 的键位（太基础或 footer 已常驻提示），从派生中排除 */
const TIP_EXCLUDED_ACTIONS = new Set<string>([
  "app:quit",         // Ctrl+C 退出 —— 人人皆知，footer 也常驻
  "app:interrupt",    // Esc 取消 —— 同上
  "input:shellMode",  // ! —— 字符级输入，"按 !" 读着别扭，已并入下方命令 tip
  "input:filePicker", // @ —— 同上
]);

/** 键位类 tips：从 defaultBindings 单一数据源派生，键位增改自动同步 */
function buildKeybindingTips(): string[] {
  return DEFAULT_BINDINGS
    .filter((b) => b.showInHelp && !TIP_EXCLUDED_ACTIONS.has(b.action))
    .map((b) => `按 ${b.display} ${b.description}`);
}

/** 命令 / 功能类 tips：手动维护（新命令值得提示时往这里加一行） */
const COMMAND_TIPS: string[] = [
  "使用 /compact 压缩对话历史，节省 token",
  "使用 /rewind 回退最近一轮对话",
  "使用 /undo 撤销最近一次文件修改",
  "使用 /checkpoints 查看快照，/restore <id> 恢复到某个快照点",
  "使用 /plan 进入计划模式，先规划后执行",
  "使用 /theme 切换主题",
  "使用 /memory 管理跨会话记忆 (set/get/list/search)",
  "使用 /mcp 管理 MCP 服务器，/skills 管理 Skills 能力",
  "使用 /cost 查看 token 用量和费用，/stats 查看会话统计",
  "使用 /resume 或 /sessions 恢复历史会话",
  "使用 /trace 排查会话，把轨迹嚼碎成结构化摘要",
  "输入 @ 引用文件，/ 触发命令补全，! 进入 shell 模式",
];

/** 全部候选 tips（键位派生 + 命令手维） */
const ALL_TIPS: string[] = [...buildKeybindingTips(), ...COMMAND_TIPS];

/**
 * 会话级稳定 tip：进程启动时挑一次，整个会话保持不变。
 *
 * ⚠️ 关键：**绝不能**在 render 体里调 Math.random()。AppHeader 随消息列表
 * 在流式 / 状态变化时每秒重渲多次，若每次渲染都重新随机，tip 会高频闪烁
 * 切换、根本看不清（对标 cc：开屏 tip 选一次、整轮稳定，见 src/ui/CLAUDE.md L4-D）。
 */
const SESSION_TIP: string =
  ALL_TIPS.length > 0
    ? ALL_TIPS[Math.floor(Math.random() * ALL_TIPS.length)]
    : "";

interface AppHeaderProps {
  version: string;
}

export const AppHeader: React.FC<AppHeaderProps> = ({ version }) => {
  return (
    <Box flexDirection="column" marginTop={1} marginBottom={1}>
      {/* Logo + 版本 */}
      <Box flexDirection="row" paddingLeft={2}>
        <Box flexShrink={0}>
          <ThemedGradient>{LOGO}</ThemedGradient>
        </Box>
      </Box>

      <Box paddingLeft={2} marginTop={0}>
        <Text bold color={theme.text.primary}>Sid Code</Text>
        <Text color={theme.text.secondary}> v{version}</Text>
      </Box>

      {/* Tip：品牌色引导箭头 + dim 文本，降低花哨感 */}
      {SESSION_TIP ? (
        <Box paddingLeft={2} marginTop={1}>
          <Text color={theme.ui.active}>{`${ARROW_PROMPT} `}</Text>
          <Text color={theme.text.secondary} dimColor>{SESSION_TIP}</Text>
        </Box>
      ) : null}
    </Box>
  );
};
