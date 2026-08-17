/**
 * 空状态欢迎页组件（Neofetch 风格）
 *
 * 双栏布局：左侧块字体渐变 Logo + 右侧项目上下文信息面板。
 * 去掉大边框盒子，靠留白和对齐构成节奏，信息密度更高、科技感更强。
 */

import React from "react";
import Box from "@sid-code/tui-renderer/components/Box.tsx";
import Text from "@sid-code/tui-renderer/components/Text.tsx";
import { getRawVersion } from "@sid-code/shared/version.ts";
import { ThemedGradient } from "./ThemedGradient.tsx";
import { theme } from "../semantic-colors.ts";
import { ARROW_PROMPT } from "../constants/figures.ts";
import { DEFAULT_BINDINGS } from "../keybindings/defaultBindings.ts";

/**
 * ANSI Shadow 风格块字体 Logo — 填充块比线条 FIGlet 有体积感和科技感。
 * "SID CODE" 完整拼写。
 */
const LOGO_LINES = [
  "███████╗██╗██████╗    ██████╗ ██████╗ ██████╗ ███████╗",
  "██╔════╝██║██╔══██╗  ██╔════╝██╔═══██╗██╔══██╗██╔════╝",
  "███████╗██║██║  ██║  ██║     ██║   ██║██║  ██║█████╗  ",
  "╚════██║██║██║  ██║  ██║     ██║   ██║██║  ██║██╔══╝  ",
  "███████║██║██████╔╝  ╚██████╗╚██████╔╝██████╔╝███████╗",
  "╚══════╝╚═╝╚═════╝    ╚═════╝ ╚═════╝ ╚═════╝ ╚══════╝",
];

/** 短化路径：~ 替代 HOME */
function shortenPath(p: string): string {
  const home = process.env.HOME || process.env.USERPROFILE || "";
  if (home && p.startsWith(home)) {
    return "~" + p.slice(home.length);
  }
  return p;
}

/** 从路径中提取项目名（最后一段目录名） */
function projectName(cwd: string): string {
  const parts = cwd.replace(/\/$/, "").split("/");
  return parts[parts.length - 1] || "unknown";
}

/** Tips 构建（与 AppHeader 同源逻辑，会话级稳定） */
const TIP_EXCLUDED_ACTIONS = new Set<string>([
  "app:quit",
  "app:interrupt",
  "input:shellMode",
  "input:filePicker",
]);

function buildKeybindingTips(): string[] {
  return DEFAULT_BINDINGS.filter((b) => b.showInHelp && !TIP_EXCLUDED_ACTIONS.has(b.action)).map(
    (b) => `按 ${b.display} ${b.description}`,
  );
}

const COMMAND_TIPS: string[] = [
  "使用 /compact 压缩对话历史，节省 token",
  "使用 /plan 进入计划模式，先规划后执行",
  "使用 /theme 切换主题",
  "使用 /memory 管理跨会话记忆",
  "输入 @ 引用文件，/ 触发命令补全，! 进入 shell 模式",
];

const ALL_TIPS: string[] = [...buildKeybindingTips(), ...COMMAND_TIPS];
const SESSION_TIP: string =
  ALL_TIPS.length > 0 ? ALL_TIPS[Math.floor(Math.random() * ALL_TIPS.length)] : "";

interface EmptyLogoProps {
  termWidth: number;
  /** 当前工作目录 */
  cwd?: string;
  /** 当前 git 分支 */
  gitBranch?: string;
  /** 当前模型名 */
  model?: string;
  /** 首次启动引导标记：为 true 时 Tip 区替换为配置引导 */
  needsOnboarding?: boolean;
}

export function EmptyLogo({ termWidth, cwd, gitBranch, model, needsOnboarding }: EmptyLogoProps) {
  const version = getRawVersion();
  const displayCwd = cwd ? shortenPath(cwd) : "";
  const displayProject = cwd ? projectName(cwd) : "sid-code";

  // 右侧面板信息行（key-value 对）
  const infoLines: Array<{ key: string; value: string }> = [
    { key: "Project", value: displayProject },
    ...(displayCwd ? [{ key: "Path", value: displayCwd }] : []),
    ...(gitBranch ? [{ key: "Branch", value: gitBranch }] : []),
    ...(model ? [{ key: "Model", value: model }] : []),
    { key: "Version", value: `v${version}` },
  ];

  // 窄终端（<60 列）回退为单栏竖排
  const isNarrow = termWidth < 60;

  if (isNarrow) {
    return (
      <Box flexDirection="column" paddingX={2} paddingY={1}>
        <ThemedGradient>{LOGO_LINES.join("\n")}</ThemedGradient>
        <Box marginTop={1} flexDirection="column">
          {infoLines.map((info, i) => (
            <Box key={`info-${i}`}>
              <Text color={theme.text.secondary}>{info.key.padEnd(8)}</Text>
              <Text color={theme.text.primary}>{info.value}</Text>
            </Box>
          ))}
        </Box>
        {needsOnboarding ? (
          <Box marginTop={1}>
            <Text color={theme.ui.active}>{`${ARROW_PROMPT} `}</Text>
            <Text color={theme.ui.active}>尚未配置 API Key，正在打开配置向导…</Text>
          </Box>
        ) : SESSION_TIP ? (
          <Box marginTop={1}>
            <Text color={theme.ui.active}>{`${ARROW_PROMPT} `}</Text>
            <Text color={theme.text.secondary}>{SESSION_TIP}</Text>
          </Box>
        ) : null}
      </Box>
    );
  }

  // 标准双栏布局
  // Logo 区 paddingLeft=2，Logo 与信息面板间隔 4 空格
  const GAP = 4;

  return (
    <Box flexDirection="column" paddingX={2} paddingTop={1} paddingBottom={1}>
      {/* 双栏：Logo 左 + 信息右 */}
      <Box flexDirection="row">
        {/* 左栏：渐变块字体 Logo */}
        <Box flexDirection="column" flexShrink={0}>
          <ThemedGradient>{LOGO_LINES.join("\n")}</ThemedGradient>
        </Box>

        {/* 间隔 */}
        <Box width={GAP} flexShrink={0} />

        {/* 右栏：项目上下文信息面板 */}
        <Box flexDirection="column" justifyContent="center">
          {/* key-value 信息 */}
          {infoLines.map((info, i) => (
            <Box key={`info-${i}`}>
              <Text color={theme.text.secondary}>{info.key.padEnd(9)}</Text>
              <Text color={theme.text.primary}>{info.value}</Text>
            </Box>
          ))}
        </Box>
      </Box>

      {/* 底部 Tip + 快捷键提示（合为一行） */}
      <Box marginTop={1} justifyContent="space-between" width={termWidth - 4}>
        <Box>
          {needsOnboarding ? (
            <>
              <Text color={theme.ui.active}>{`${ARROW_PROMPT} `}</Text>
              <Text color={theme.ui.active}>尚未配置 API Key，正在打开配置向导…</Text>
            </>
          ) : SESSION_TIP ? (
            <>
              <Text color={theme.ui.active}>{`${ARROW_PROMPT} `}</Text>
              <Text color={theme.text.secondary}>{SESSION_TIP}</Text>
            </>
          ) : null}
        </Box>
        <Text color={theme.text.secondary}>{" ? 查看快捷键"}</Text>
      </Box>
    </Box>
  );
}
