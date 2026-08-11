/**
 * Read/Edit 文件路径权限规则匹配（对齐 claude-code §7.4 P0-2）
 *
 * 背景（缺口）：CC 定义 Read/Edit 路径规则四种前缀：
 *   - `//path`      文件系统绝对路径，如 Read 规则匹配 /Users/alice 下递归
 *   - `~/path`      主目录，如 Read 规则匹配 ~/Documents 下的 pdf
 *   - `/path`       项目根相对，如 Edit 规则匹配 src 下任意深度 ts
 *   - `path`/`./path` 当前目录相对，如 Read 规则匹配 .env
 *
 * 旧实现对这四种前缀一个都不解析，直接拿请求的绝对 file_path 丢给
 * `minimatch(value, pattern, {dot:true})` → 前缀不归一导致整体不可靠
 * （实测 `minimatch("/Users/x/.env", "./.env")` = false）。
 *
 * 本模块把四种前缀统一 resolve 成绝对 glob 模式，再与请求的绝对 file_path 比对。
 */

import path from "node:path";
import os from "node:os";
import { minimatch } from "minimatch";

/** 路径规则解析上下文 */
export interface PathRuleContext {
  /** 项目根（settings 所在目录，不含 .sid-code/） */
  workspaceRoot: string;
  /** 主目录 */
  homeDir?: string;
  /** 当前工作目录（相对路径基准） */
  cwd?: string;
}

/**
 * 把路径规则模式按前缀 resolve 成归一化的**绝对** glob 模式。
 *
 * - `//abs`  → 去一个 `/`（文件系统绝对路径）
 * - `~/x`    → join(homeDir, "x")
 * - `/x`     → join(workspaceRoot, "x")（单前导斜杠 = 项目根相对）
 * - `./x`/`x`→ join(cwd, "x")（当前目录相对）
 *
 * 注意：为保持 glob 语义（`**`/`*`），join 用 posix 风格拼接，
 * 且不对含通配符的模式做 path.resolve（会破坏 `**`）。
 */
export function resolvePathRulePattern(pattern: string, ctx: PathRuleContext): string {
  const homeDir = ctx.homeDir ?? os.homedir();
  const cwd = ctx.cwd ?? process.cwd();
  const workspaceRoot = ctx.workspaceRoot;

  // 归一化基准目录为绝对路径 + posix 分隔符（glob 模式统一用 /）
  const toPosixAbs = (p: string) => path.resolve(p).split(path.sep).join("/");

  // 拼接基准目录与相对模式（不用 path.join，避免吞掉 ** 通配符语义）
  const joinPosix = (base: string, rel: string) => {
    const b = toPosixAbs(base).replace(/\/+$/, "");
    const r = rel.replace(/^\/+/, "");
    return r ? `${b}/${r}` : b;
  };

  // `//abs` → 文件系统绝对路径（去一个前导 /）
  if (pattern.startsWith("//")) {
    return pattern.slice(1);
  }

  // `~/x` → 主目录相对
  if (pattern.startsWith("~/")) {
    return joinPosix(homeDir, pattern.slice(2));
  }
  if (pattern === "~") {
    return toPosixAbs(homeDir);
  }

  // `/x` → 项目根相对（单前导斜杠）
  if (pattern.startsWith("/")) {
    return joinPosix(workspaceRoot, pattern.slice(1));
  }

  // `./x` → 当前目录相对（去掉 ./ 前缀）
  if (pattern.startsWith("./")) {
    return joinPosix(cwd, pattern.slice(2));
  }

  // 裸 `x` → 当前目录相对
  return joinPosix(cwd, pattern);
}

/**
 * 用路径规则模式匹配请求的文件路径。
 * 先按前缀 resolve 成绝对 glob，再用 minimatch（gitignore 语义，dot:true）比对绝对 file_path。
 *
 * @param pattern 规则括号内的路径模式（含四种前缀语义）
 * @param filePath 请求的文件路径（应为绝对路径；相对则按 cwd 归一）
 * @param ctx 解析上下文
 */
export function matchPathRule(pattern: string, filePath: string, ctx: PathRuleContext): boolean {
  if (!filePath) return false;

  // 请求路径归一为绝对 + posix
  const cwd = ctx.cwd ?? process.cwd();
  const absFile = (path.isAbsolute(filePath) ? filePath : path.resolve(cwd, filePath))
    .split(path.sep)
    .join("/");

  const resolvedPattern = resolvePathRulePattern(pattern, ctx);

  // gitignore 风格：`Read(/src)` 也应匹配 `/src/**`（目录规则匹配目录内文件）。
  // 若模式不以通配符结尾且请求路径在其目录下，补一次目录匹配。
  if (minimatch(absFile, resolvedPattern, { dot: true })) {
    return true;
  }
  // 目录前缀匹配：模式指向目录时，其下所有文件都算命中（对齐 CC 去 /** 后缀语义）
  if (!resolvedPattern.includes("*")) {
    const dirPrefix = resolvedPattern.replace(/\/+$/, "");
    if (absFile === dirPrefix || absFile.startsWith(dirPrefix + "/")) {
      return true;
    }
  }
  return false;
}
