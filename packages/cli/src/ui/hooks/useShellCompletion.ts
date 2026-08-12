/**
 * Shell 命令补全 Hook
 *
 * 在 ! shell 模式下，提供常用 shell 命令补全。
 * 支持 git、npm、bun、make、docker、kubectl 等常用命令及子命令。
 */

import { useEffect } from "react";
import type { Suggestion } from "../components/SuggestionsDisplay.tsx";

/** Shell 命令定义 */
interface ShellCommand {
  name: string;
  description: string;
  subcommands?: Array<{ name: string; description: string }>;
}

const SHELL_COMMANDS: ShellCommand[] = [
  {
    name: "git",
    description: "版本控制",
    subcommands: [
      { name: "status", description: "查看状态" },
      { name: "add", description: "暂存文件" },
      { name: "commit", description: "提交" },
      { name: "push", description: "推送" },
      { name: "pull", description: "拉取" },
      { name: "checkout", description: "切换分支" },
      { name: "branch", description: "分支管理" },
      { name: "merge", description: "合并" },
      { name: "rebase", description: "变基" },
      { name: "log", description: "查看日志" },
      { name: "diff", description: "查看差异" },
      { name: "stash", description: "暂存" },
      { name: "reset", description: "重置" },
      { name: "fetch", description: "获取远程" },
      { name: "clone", description: "克隆" },
    ],
  },
  {
    name: "npm",
    description: "Node 包管理",
    subcommands: [
      { name: "install", description: "安装依赖" },
      { name: "run", description: "运行脚本" },
      { name: "test", description: "运行测试" },
      { name: "build", description: "构建" },
      { name: "start", description: "启动" },
      { name: "init", description: "初始化" },
      { name: "publish", description: "发布" },
      { name: "update", description: "更新" },
      { name: "uninstall", description: "卸载" },
    ],
  },
  {
    name: "bun",
    description: "Bun 运行时",
    subcommands: [
      { name: "install", description: "安装依赖" },
      { name: "run", description: "运行脚本" },
      { name: "test", description: "运行测试" },
      { name: "build", description: "构建" },
      { name: "add", description: "添加依赖" },
      { name: "remove", description: "移除依赖" },
      { name: "init", description: "初始化" },
    ],
  },
  {
    name: "make",
    description: "Make 构建",
    subcommands: [
      { name: "build", description: "构建" },
      { name: "test", description: "测试" },
      { name: "clean", description: "清理" },
      { name: "install", description: "安装" },
    ],
  },
  {
    name: "docker",
    description: "容器管理",
    subcommands: [
      { name: "build", description: "构建镜像" },
      { name: "run", description: "运行容器" },
      { name: "ps", description: "列出容器" },
      { name: "images", description: "列出镜像" },
      { name: "pull", description: "拉取镜像" },
      { name: "push", description: "推送镜像" },
      { name: "stop", description: "停止容器" },
      { name: "rm", description: "删除容器" },
      { name: "compose", description: "编排" },
    ],
  },
  { name: "ls", description: "列出文件" },
  { name: "cd", description: "切换目录" },
  { name: "cat", description: "查看文件" },
  { name: "grep", description: "搜索文本" },
  { name: "find", description: "查找文件" },
  { name: "curl", description: "HTTP 请求" },
  { name: "echo", description: "输出文本" },
  { name: "mkdir", description: "创建目录" },
  { name: "rm", description: "删除文件" },
  { name: "cp", description: "复制文件" },
  { name: "mv", description: "移动文件" },
  { name: "chmod", description: "修改权限" },
  { name: "pwd", description: "当前目录" },
  { name: "which", description: "查找命令" },
  { name: "env", description: "环境变量" },
  { name: "ps", description: "进程列表" },
  { name: "kill", description: "终止进程" },
  { name: "top", description: "系统监控" },
];

export interface UseShellCompletionProps {
  /** 当前输入文本（不含 ! 前缀） */
  text: string;
  /** 光标列位置 */
  cursorCol: number;
  /** 是否处于 shell 模式 */
  shellMode: boolean;
  /** 设置建议列表 */
  setSuggestions: (suggestions: Suggestion[]) => void;
}

export function useShellCompletion({
  text,
  cursorCol,
  shellMode,
  setSuggestions,
}: UseShellCompletionProps) {
  useEffect(() => {
    if (!shellMode) return;

    // 去掉 ! 前缀
    const input = text.startsWith("!") ? text.slice(1) : text;
    const effectiveCursor = text.startsWith("!") ? cursorCol - 1 : cursorCol;

    if (!input || effectiveCursor <= 0) {
      // 空输入：显示常用命令
      const topCmds = SHELL_COMMANDS.slice(0, 8);
      setSuggestions(
        topCmds.map((cmd) => ({
          label: cmd.name,
          value: cmd.name + " ",
          description: cmd.description,
        })),
      );
      return;
    }

    const parts = input.slice(0, effectiveCursor).split(/\s+/);
    const cmdPart = parts[0].toLowerCase();

    if (parts.length === 1) {
      // 补全命令名
      const matches = SHELL_COMMANDS.filter((cmd) => cmd.name.startsWith(cmdPart));
      if (matches.length > 0) {
        setSuggestions(
          matches.slice(0, 8).map((cmd) => ({
            label: cmd.name,
            value: cmd.name + " ",
            description: cmd.description,
          })),
        );
      } else {
        setSuggestions([]);
      }
      return;
    }

    // 补全子命令
    const parentCmd = SHELL_COMMANDS.find((cmd) => cmd.name === cmdPart);
    if (parentCmd?.subcommands) {
      const subPart = (parts[1] || "").toLowerCase();
      const matches = parentCmd.subcommands.filter((sub) => sub.name.startsWith(subPart));
      if (matches.length > 0) {
        setSuggestions(
          matches.slice(0, 8).map((sub) => ({
            label: `${parentCmd.name} ${sub.name}`,
            value: `${parentCmd.name} ${sub.name} `,
            description: sub.description,
          })),
        );
      } else {
        setSuggestions([]);
      }
    } else {
      setSuggestions([]);
    }
  }, [text, cursorCol, shellMode, setSuggestions]);
}
