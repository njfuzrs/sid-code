/**
 * 提取代理工具权限（Task 3）
 *
 * 后台记忆提取代理遵循最小权限原则：
 * - ✅ Read/Grep/Glob/ls（只读，无限制）
 * - ✅ Bash（仅只读命令：管道/序列里**每个**命令都须在白名单内，见 isReadonlyBash）
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
import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { existsSync } from "node:fs";
import { MEMORY_LIMITS } from "../types.ts";
import { isEnumerableMemoryPath } from "../scan.ts";
import {
  isExistingMemoryKey,
  listExistingMemoryKeys,
  readIndexCapacity,
} from "../index-capacity.ts";
import type { PathMismatchShape, PermissionResult } from "../../tool/types.ts";
import { isAutoMemPath } from "../paths.ts";
import { isMemoryType } from "../types.ts";
import {
  parseBashCommand,
  extractSimpleCommands,
  extractRedirectTargets,
} from "../../tool/bash/parser.ts";
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

function extractMemoryKey(input: unknown): string | undefined {
  if (input && typeof input === "object") {
    const k = (input as Record<string, unknown>).key;
    if (typeof k === "string") return k;
  }
  return undefined;
}

/**
 * 横向剖析 T3：索引已截断时，后台代理只能更新已有 key，不能新建。
 *
 * 为什么只限后台路径：截断态下新建的条目进不了索引（模型看不见），而后台代理无人监督、
 * 每轮都跑 —— 剖析核出被截掉的 216 条大多是它写的。主模型路径有人在场，可能确有必要新建，
 * 不在这里限（主路径不经过本函数）。
 *
 * `key === undefined`（write 新文件）：没有 key 可比对，截断态下直接拒绝新建。
 * 状态读不出来时放行（fail-open）：这是容量治理，不是安全边界，读盘失败不该让抽取停摆。
 */
function checkIndexFull(
  memoryDir: string,
  key: string | undefined,
  via: "save_memory" | "write",
): PermissionResult {
  let truncated = false;
  try {
    truncated = readIndexCapacity(memoryDir).truncated;
  } catch {
    return { behavior: "allow" };
  }
  if (!truncated) return { behavior: "allow" };
  if (key !== undefined && isExistingMemoryKey(key, listExistingMemoryKeys(memoryDir))) {
    return { behavior: "allow" };
  }
  logMemoryGuard({ kind: "index_full", via, scope: "project" });
  return {
    behavior: "deny",
    denyKind: "index_full",
    message:
      `记忆索引已截断（超过 ${MEMORY_LIMITS.INDEX_MAX_ENTRIES} 条 / ` +
      `${Math.round(MEMORY_LIMITS.INDEX_MAX_BYTES / 1000)}KB），新建的记忆进不了索引。` +
      `后台代理不允许新建 key：请用现有记忆清单里某条的原 key 更新它，或不保存。`,
  };
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

/**
 * `find` 里能执行命令或写盘的谓词。`find` 本身在白名单里，但 `-exec sh -c ...`
 * 不会在 AST 里另起一个简单命令节点（参数原样挂在 find 下面），所以必须按参数拦。
 */
const FIND_UNSAFE_ARGS = new Set([
  "-exec",
  "-execdir",
  "-ok",
  "-okdir",
  "-delete",
  "-fprint",
  "-fprint0",
  "-fprintf",
  "-fls",
]);

/**
 * 命令替换 / 进程替换。parser 不展开它们（`$(curl x)` 会被切成参数 `"$(curl"`），
 * 于是 AST 逐命令校验看不见里面的命令 —— 只能整串拒绝。后台代理是只读探查，
 * 这几种形态没有正当用途。
 */
const SUBSTITUTION_RE = /\$\(|`|<\(|>\(/;

/**
 * 判断 bash 命令是否为只读命令（缺陷 1 · P0）。
 *
 * 旧实现只看**第一个词**：`cat x | sh`、`grep a f | bash` 首词在白名单里就放行，
 * 比主路径 `isReadOnlyCommand`（AST 逐命令）还松 —— 而这个代理是无人监督的后台 fork，
 * 方向反了。现在的口径：
 * 1. 整串含命令/进程替换 → 拒（parser 看不见里面）；
 * 2. 任何 `>` → 拒（含 `>/dev/null`，后台代理不需要；比主路径严是刻意的）；
 * 3. AST 拆出的**每一个**简单命令都必须在白名单里（管道 / `;` / `&&` 全覆盖）；
 * 4. `find` 额外拒绝 `-exec` / `-delete` 一类谓词（主路径同样漏这条，见缺陷文档）。
 */
export function isReadonlyBash(input: unknown): boolean {
  if (!input || typeof input !== "object") return false;
  const cmd = (input as Record<string, unknown>).command;
  if (typeof cmd !== "string") return false;
  const trimmed = cmd.trim();
  if (!trimmed) return false;
  if (SUBSTITUTION_RE.test(trimmed)) return false;
  if (trimmed.includes(">")) return false;

  const ast = parseBashCommand(trimmed);
  if (extractRedirectTargets(ast).length > 0) return false;
  const simple = extractSimpleCommands(ast);
  if (simple.length === 0) return false;
  for (const { command, args } of simple) {
    if (!READONLY_BASH_PREFIXES.includes(command)) return false;
    if (command === "find" && args.some((a) => FIND_UNSAFE_ARGS.has(a))) return false;
  }
  return true;
}

/**
 * 被拒路径与授权路径的形状差异（只出布尔，不出原文，理由见 `PathMismatchShape`）。
 *
 * 为什么要有：04 剖析核出 session-memory fork 的 edit 拒绝率 43%，假设是更新提示词
 * 没给笔记路径、模型靠猜。fork 的请求正文不落盘，没有这组布尔就只能推断，坐实不了。
 *
 * @param authorized 授权的文件（kind="file"）或目录（kind="dir"）
 */
export function describePathMismatch(
  target: string,
  authorized: string,
  kind: "file" | "dir",
): PathMismatchShape {
  const t = resolve(target);
  const a = resolve(authorized);
  // 文件授权时，「授权根」取文件所在目录的上一级：笔记在 `<项目>/session-memory/<sid>.md`，
  // 模型写到 `<项目>/.session_memory.md` 这类旧路径时 underAuthorizedRoot=true。
  const root = kind === "file" ? dirname(dirname(a)) : a;
  return {
    sameBasename: kind === "file" ? basename(t) === basename(a) : false,
    sameDir: kind === "file" ? dirname(t) === dirname(a) : t.startsWith(a + sep),
    isRelative: !isAbsolute(target),
    underAuthorizedRoot: t === root || t.startsWith(root + sep),
  };
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
        : {
            behavior: "deny",
            message: "提取代理只能运行只读 bash 命令",
            denyKind: "bash_not_readonly",
          };
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
        return checkIndexFull(memoryDir, extractMemoryKey(input), "save_memory");
      }
      // 类型名填进了 scope：参数语义混淆，不是越权。单独计数并给出能直接改对的提示——
      // 笼统的「只能写 project」会让模型以为类型本身不被允许，下一轮干脆不存。
      if (isMemoryType(scope)) {
        logMemoryGuard({ kind: "scope_type_confusion", via: "save_memory", scope });
        return {
          behavior: "deny",
          denyKind: "scope_denied",
          message:
            `scope 不接受记忆类型「${scope}」：类型请填 type 参数（type="${scope}"），` +
            `scope 留空（默认 project）后重试。`,
        };
      }
      // P1-12 指标 ③：越权拒绝计数。这条线恒 0 也要存在 ——
      // 「后台代理从没试过越权」与「越权拦不住」在轨迹里必须可分。
      logMemoryGuard({ kind: "scope_denied", via: "save_memory", scope });
      return {
        behavior: "deny",
        denyKind: "scope_denied",
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
        return { behavior: "deny", message: "无法解析目标路径", denyKind: "no_target_path" };
      }
      if (isAutoMemPath(target, memoryDir)) {
        // T3：write 新建一个记忆文件与 save_memory 新建 key 等价，同样受截断态约束；
        // 否则模型被 save_memory 拒绝后改用 write 就绕过去了。edit 只能改已有文件，不受影响。
        if (toolName === "write" && !existsSync(target)) {
          const rel = relative(resolve(memoryDir), resolve(target));
          if (isEnumerableMemoryPath(rel)) return checkIndexFull(memoryDir, undefined, "write");
        }
        return { behavior: "allow" };
      }
      return {
        behavior: "deny",
        message: `提取代理只能写入记忆目录: ${memoryDir}`,
        denyKind: "path_mismatch",
        pathMismatch: describePathMismatch(target, memoryDir, "dir"),
      };
    }

    // 其他所有工具：拒绝
    return {
      behavior: "deny",
      message: `提取代理不允许使用工具: ${toolName}`,
      denyKind: "tool_not_allowed",
    };
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
        : {
            behavior: "deny",
            message: "Session Memory 代理只能运行只读 bash 命令",
            denyKind: "bash_not_readonly",
          };
    }
    if (toolName === "write" || toolName === "edit") {
      const target = extractTargetPath(input);
      if (!target) {
        return { behavior: "deny", message: "无法解析目标路径", denyKind: "no_target_path" };
      }
      if (resolve(target) === resolve(sessionMemoryFile)) {
        return { behavior: "allow" };
      }
      return {
        behavior: "deny",
        message: `Session Memory 代理只能编辑: ${sessionMemoryFile}`,
        denyKind: "path_mismatch",
        pathMismatch: describePathMismatch(target, sessionMemoryFile, "file"),
      };
    }
    return {
      behavior: "deny",
      message: `Session Memory 代理不允许使用工具: ${toolName}`,
      denyKind: "tool_not_allowed",
    };
  };
}
