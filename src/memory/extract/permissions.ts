/**
 * 提取代理工具权限（Task 3）
 *
 * 后台记忆提取代理遵循最小权限原则：
 * - ✅ Read/Grep/Glob/ls（只读，无限制）
 * - ✅ Bash（仅只读命令：ls/find/cat/stat/wc/head/tail）
 * - ✅ Edit/Write/save_memory（仅 memoryDir 内的路径）
 * - ❌ 其他所有工具（MCP、Agent、网络、写入 memoryDir 外的路径）
 */

import type { CanUseToolFn } from "../../agent/forked-agent.ts";
import type { PermissionResult } from "../../tool/types.ts";
import { isAutoMemPath } from "../paths.ts";

/** 只读工具白名单（无限制放行） */
const READONLY_TOOLS = new Set(["read", "grep", "glob", "ls", "read_many"]);

/** 写入类工具（仅当目标路径在 memoryDir 内才放行） */
const WRITE_TOOLS = new Set(["write", "edit", "save_memory"]);

/** Bash 只读命令前缀白名单 */
const READONLY_BASH_PREFIXES = ["ls", "find", "cat", "stat", "wc", "head", "tail", "grep", "echo"];

/** 从工具输入中提取目标文件路径（write/edit 用 file_path 字段） */
function extractTargetPath(input: unknown): string | undefined {
  if (input && typeof input === "object") {
    const obj = input as Record<string, unknown>;
    const p = obj.file_path ?? obj.path ?? obj.filePath;
    if (typeof p === "string") return p;
  }
  return undefined;
}

/** 判断 bash 命令是否为只读命令 */
function isReadonlyBash(input: unknown): boolean {
  if (input && typeof input === "object") {
    const cmd = (input as Record<string, unknown>).command;
    if (typeof cmd === "string") {
      const trimmed = cmd.trim();
      // 拒绝含有写重定向 / 管道破坏性命令
      if (/[>]|rm\s|mv\s|sudo\s|curl\s|wget\s|chmod\s|chown\s/.test(trimmed)) return false;
      const firstWord = trimmed.split(/\s+/)[0];
      return READONLY_BASH_PREFIXES.includes(firstWord);
    }
  }
  return false;
}

/**
 * 创建提取代理的工具权限函数。
 * @param memoryDir 允许写入的记忆目录（绝对路径）
 */
export function createExtractPermissions(memoryDir: string): CanUseToolFn {
  return (toolName: string, input: unknown): PermissionResult => {
    // 只读工具：无限制放行
    if (READONLY_TOOLS.has(toolName)) {
      return { behavior: "allow" };
    }

    // Bash：仅只读命令
    if (toolName === "bash") {
      return isReadonlyBash(input)
        ? { behavior: "allow" }
        : { behavior: "deny", message: "提取代理只能运行只读 bash 命令" };
    }

    // save_memory：内部已写入 memoryDir，直接放行
    if (toolName === "save_memory") {
      return { behavior: "allow" };
    }

    // 写入类工具：仅 memoryDir 内
    if (WRITE_TOOLS.has(toolName)) {
      const target = extractTargetPath(input);
      if (!target) {
        return { behavior: "deny", message: "无法解析目标路径" };
      }
      if (isAutoMemPath(target, memoryDir)) {
        return { behavior: "allow" };
      }
      return { behavior: "deny", message: `提取代理只能写入记忆目录: ${memoryDir}` };
    }

    // 其他所有工具：拒绝
    return { behavior: "deny", message: `提取代理不允许使用工具: ${toolName}` };
  };
}

/**
 * 创建 Session Memory 提取代理的工具权限函数。
 * 比 Auto Memory 更严格——只能编辑一个特定文件。
 * @param sessionMemoryFile 允许编辑的唯一文件（绝对路径）
 */
export function createSessionMemoryPermissions(sessionMemoryFile: string): CanUseToolFn {
  return (toolName: string, input: unknown): PermissionResult => {
    if (READONLY_TOOLS.has(toolName)) {
      return { behavior: "allow" };
    }
    if (toolName === "bash") {
      return isReadonlyBash(input)
        ? { behavior: "allow" }
        : { behavior: "deny", message: "Session Memory 代理只能运行只读 bash 命令" };
    }
    if (toolName === "write" || toolName === "edit") {
      const target = extractTargetPath(input);
      if (target && require("path").resolve(target) === require("path").resolve(sessionMemoryFile)) {
        return { behavior: "allow" };
      }
      return { behavior: "deny", message: `Session Memory 代理只能编辑: ${sessionMemoryFile}` };
    }
    return { behavior: "deny", message: `Session Memory 代理不允许使用工具: ${toolName}` };
  };
}
