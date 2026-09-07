/**
 * 提取代理工具权限（Task 3）
 *
 * 后台记忆提取代理遵循最小权限原则：
 * - ✅ Read/Grep/Glob/ls（只读，无限制）
 * - ✅ Bash（仅只读命令：ls/find/cat/stat/wc/head/tail）
 * - ✅ Edit/Write（仅 memoryDir 内的路径）
 * - ✅ save_memory（**仅 project scope**，见 P1-9：其余三个 scope 都落在 memoryDir 之外）
 * - ❌ 其他所有工具（MCP、Agent、网络、写入 memoryDir 外的路径）
 *
 * ⚠️ 「写入范围」这件事在本文件里有**两个维度**，缺一个就漏一半：
 * write/edit 受**路径**约束，save_memory 受 **scope** 约束。旧实现只做了前者，
 * 后者整个放行 —— 而 scope 一个参数就能把落点挪到 `~/.sid-code/memory/`（全局，
 * 污染所有项目）或 `team-memory/`（会同步给全体协作者）。
 */

import type { CanUseToolFn } from "../../agent/forked-agent.ts";
import type { PermissionResult } from "../../tool/types.ts";
import { isAutoMemPath } from "../paths.ts";
// P1-12 指标 ③：越权拒绝计数（防线触发次数，恒 0 亦是信号）。
import { logMemoryGuard } from "../../analytics/events.ts";

/** 只读工具白名单（无限制放行） */
const READONLY_TOOLS = new Set(["read", "grep", "glob", "ls", "read_many"]);

/**
 * 写入类工具（仅当目标路径在 memoryDir 内才放行）。
 *
 * ⚠️ `save_memory` **刻意不在这张表里**（P1-9）：它没有 `file_path` 参数，
 * 落点由 `scope` 决定，走上面那条按 scope 判定的分支。
 * 把它加回这里会走 `extractTargetPath` → 取不到路径 → 一律 deny，
 * 于是后台提取代理连 project 记忆都写不了 —— 子系统静默失效，且不报错。
 */
const WRITE_TOOLS = new Set(["write", "edit"]);

/** Bash 只读命令前缀白名单 */
const READONLY_BASH_PREFIXES = ["ls", "find", "cat", "stat", "wc", "head", "tail", "grep", "echo"];

/**
 * 从 `save_memory` 的输入里取 `scope`（P1-9）。
 *
 * 返回 `undefined` 表示「没传」——`MemoryTool` 此时按 `project` 处理，
 * 所以调用方必须把 undefined 与 "project" 同等对待。
 *
 * 不校验取值是否在枚举内：非法值由工具自己的 zod schema 拒掉，
 * 这里只负责「已知的越权 scope 不放行」，不兼任参数校验
 * （兼了就要跟着 schema 改，两处必然漂移）。
 */
function extractMemoryScope(input: unknown): string | undefined {
  if (input && typeof input === "object") {
    const s = (input as Record<string, unknown>).scope;
    if (typeof s === "string") return s;
  }
  return undefined;
}

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

    // ─── P1-9：save_memory 按 scope 收窄，不再无条件放行 ───
    //
    // 旧代码是 `if (toolName === "save_memory") return allow`，注释写「内部已写入
    // memoryDir，直接放行」——**这个前提不成立**。`save_memory` 的 scope 枚举有四个值，
    // 其中三个落在 `memoryDir` 之外：
    //
    // | scope | 落点 | 在 memoryDir 内 |
    // | --- | --- | --- |
    // | `project`（默认） | `~/.sid-code/projects/<key>/memory/` | ✅ 是（= memoryDir） |
    // | `global` | `~/.sid-code/memory/` | ❌ 跨所有项目 |
    // | `team` | `~/.sid-code/projects/<key>/team-memory/` | ❌ 会同步给全体协作者 |
    // | `agent` | `~/.sid-code/memory/agents/<type>/` | ❌ 否 |
    //
    // 而 `app.ts` 传进来的 `memoryDir` 只是 project 目录。于是权限函数**自认为**
    // 限住了写入范围，实际一个参数就能越出去 —— 同一个函数对 write/edit 逐路径校验、
    // 对 save_memory 完全放行，这个不对称本身就是信号。
    //
    // 三个越权面（按危害排序）：
    // 1. **global 污染所有项目**：后台代理在 A 项目判断「这是用户的长期偏好」传
    //    `scope=global`，此后**每个项目的会话**都注入它。而提取 prompt 里
    //    **完全没有 global 的判定标准**——模型对它的使用是无指引的自由裁量。
    // 2. **team 绕过团队标准**：内容落进 `team-memory/`，将来一旦启用团队记忆，
    //    watcher 首次同步就把这批**从未按团队标准审过的**记忆 push 给全体协作者。
    // 3. **agent**：后台代理跑在主会话 registry 上，`agentType` 缺失，本就无法正常写。
    //
    // 收窄到 project：**后台代理只能写它被授权的那个目录**，与 write/edit 同口径。
    // 不做「按 memoryDir 反推允许哪些 scope」的动态判断——那要求权限函数知道
    // 四个 scope 各自的落盘规则，一处改动就会两边漂移。project 是唯一与 memoryDir
    // 语义对齐的 scope，也是提取 prompt 唯一给了判定标准的那个。
    if (toolName === "save_memory") {
      const scope = extractMemoryScope(input);
      if (scope === undefined || scope === "project") {
        return { behavior: "allow" };
      }
      // P1-12 指标 ③：越权拒绝计数。这条线恒 0 也要存在 ——
      // 「后台代理从没试过越权」与「越权拦不住」在轨迹里必须可分。
      logMemoryGuard({ kind: "scope_denied", via: "save_memory", scope });
      return {
        behavior: "deny",
        message:
          `后台记忆代理只能写 project scope（授权目录 ${memoryDir}），不允许 scope=${scope}。` +
          `global 会污染所有项目、team 会同步给全体协作者，两者都需要人在场判断；` +
          `请改用默认 scope 保存到当前项目记忆。`,
      };
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
      if (
        target &&
        require("path").resolve(target) === require("path").resolve(sessionMemoryFile)
      ) {
        return { behavior: "allow" };
      }
      return { behavior: "deny", message: `Session Memory 代理只能编辑: ${sessionMemoryFile}` };
    }
    return { behavior: "deny", message: `Session Memory 代理不允许使用工具: ${toolName}` };
  };
}
