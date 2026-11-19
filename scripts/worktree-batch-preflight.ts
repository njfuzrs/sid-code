#!/usr/bin/env bun
/**
 * worktree 批量编排前置检查（B1）：**确定性闸门**，判据是「workspace 依赖能否解析」，不是「装没装依赖」。
 *
 * ## 为什么存在这个脚本
 *
 * 2026-11-19 实测：4 个并行 agent 批量改代码，其中 3 个无法提交，结果全部堆在最后才暴露。
 * 根因不是代码，是 worktree 的 `node_modules` 是**从主仓 symlink 来的**：
 * 主仓自己缺 `node_modules/@sid-code/tui`（`packages/cli/node_modules` 里有、根没有），
 * 于是在 worktree 里 `bun install` 判定 no changes、不会补建这条链接，
 * `bun run docs:gen-reference --check`（pre-commit 的一部分）直接 `Cannot find module '@sid-code/tui/...'`。
 *
 * 也就是说：**「worktree 建好了」不等于「worktree 能提交」**，而后者才是批量编排的前置条件。
 * 靠人/agent 自觉在每个 worktree 里跑一次构建来发现它，实测防不住——所以做成确定性闸门。
 *
 * ## 判据
 *
 * 1. 扫 `<root>/packages/` 下每个子目录的 package.json（跳过 node_modules 子目录），
 *    收集值为 `workspace:` 前缀的依赖。
 * 2. 默认模式（检查主仓）：每个依赖只判 `<root>/node_modules/<dep>` 能否解析。
 * 3. `--worktree` 模式：判 `<wt>/packages/<声明它的包>/node_modules/<dep>` 或 `<wt>/node_modules/<dep>`；
 *    `<wt>/node_modules` 整体不存在时只报一条「未安装依赖」，不逐个包刷屏。
 * 4. 「能解析」用 `existsSync`（跟随 symlink），**不是 lstat**：悬空 symlink 必须判为缺失 ——
 *    悬空时 Node/Bun 的模块解析同样失败，lstat 看得见它但 `docs:gen-reference` 照样崩。
 *
 * ## 只做什么、不做什么
 *
 * 只读 git/fs 状态，**不写 `~/.sid-code/`**，不自动修复（修复命令打在输出里）。
 * 因为「主仓缺链接」的正确修法取决于现场：可能是补一条 `ln -sfn`，也可能是主仓整体重装；
 * 脚本替用户选一种并执行，会在错误的前提下改坏可用环境。
 *
 * ## 退出码
 *
 * 0 = 通过；1 = 有依赖解析不了（逐项打印，给修复命令）；2 = 参数错误。
 *
 * ## 用法
 *
 *   bun run scripts/worktree-batch-preflight.ts                    # 检查主仓
 *   bun run scripts/worktree-batch-preflight.ts --worktree <path>  # 检查指定 worktree（可为相对路径）
 *   bun run scripts/worktree-batch-preflight.ts --help
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";

/** 一个声明了 workspace 依赖的包 */
export interface WorkspaceDep {
  /** 依赖名，如 `@sid-code/tui` */
  dep: string;
  /** 声明它的包名（`packages/` 下的目录名），如 `cli` */
  declaredBy: string;
}

/** 扫描结果：依赖清单与探测根。root 在 worktree 模式下是 worktree 根，等价于 Bun 眼中的仓库根。 */
export interface WorkspaceScan {
  root: string;
  deps: WorkspaceDep[];
  /** 是否存在 `packages/` 目录；不存在时 deps 为空且 ok 为假 —— 空集不能当成「全部通过」 */
  hasPackagesDir: boolean;
}

export interface MissingDep extends WorkspaceDep {
  /** 缺失的绝对路径（worktree 模式下是根 node_modules 里的那条，供人排查） */
  path: string;
}

export interface PreflightResult {
  ok: boolean;
  /** 解析不了的依赖，逐项 */
  missing: MissingDep[];
  /** worktree 模式且 `<wt>/node_modules` 整体不存在时的提示（此时 missing 只报一条汇总，不逐包） */
  noNodeModules: boolean;
  /** 直接可打印的行（失败头 + 每项 + 修复命令，或通过时的单行） */
  messages: string[];
  /** 通过时被检查的依赖数 */
  checked: number;
}

/** 读一个 package.json 里的 workspace 依赖。解析失败返回空 —— 坏 JSON 由 typecheck/构建去报，这里不拦。 */
export function workspaceDepsOf(pkgDir: string, pkgName: string): WorkspaceDep[] {
  const file = join(pkgDir, "package.json");
  let json: Record<string, unknown>;
  try {
    json = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
  } catch {
    return [];
  }
  const out: WorkspaceDep[] = [];
  for (const field of [
    "dependencies",
    "devDependencies",
    "peerDependencies",
    "optionalDependencies",
  ]) {
    const table = json[field];
    if (!table || typeof table !== "object") continue;
    for (const [dep, ver] of Object.entries(table as Record<string, unknown>)) {
      if (typeof ver === "string" && ver.startsWith("workspace:"))
        out.push({ dep, declaredBy: pkgName });
    }
  }
  return out;
}

/** 扫 `<root>/packages/` 下每个子目录的 package.json，收集 workspace 依赖。 */
export function scanWorkspaceDeps(root: string): WorkspaceScan {
  const pkgs = join(root, "packages");
  if (!existsSync(pkgs) || !statSync(pkgs).isDirectory()) {
    return { root, deps: [], hasPackagesDir: false };
  }
  const deps: WorkspaceDep[] = [];
  const seen = new Set<string>();
  for (const name of readdirSync(pkgs).sort()) {
    if (name === "node_modules") continue;
    const dir = join(pkgs, name);
    try {
      if (!statSync(dir).isDirectory()) continue;
    } catch {
      continue;
    }
    for (const d of workspaceDepsOf(dir, name)) {
      // 同一对 (dep, declaredBy) 只报一次：多个 package.json 字段重复声明同一依赖时，
      // 逐条报会让人以为缺了 N 个，实际只有 1 条链接。
      const key = `${d.declaredBy}\u0000${d.dep}`;
      if (seen.has(key)) continue;
      seen.add(key);
      deps.push(d);
    }
  }
  return { root, deps, hasPackagesDir: true };
}

/**
 * `--worktree` 模式下的单依赖探测：先看声明它的包内 `node_modules/<dep>`，再看 worktree 根的。
 * `existsSync` 跟随 symlink，悬空链接会返回 false —— 这正是要判缺失的情形。
 */
export function resolveInWorktree(wt: string, d: WorkspaceDep): boolean {
  return (
    existsSync(join(wt, "packages", d.declaredBy, "node_modules", d.dep)) ||
    existsSync(join(wt, "node_modules", d.dep))
  );
}

/** ln 修复命令里的链接目标：去 scope 取包名，指向仓库内的 `packages/<name>`。 */
export function linkTarget(dep: string): string {
  const name = dep.startsWith("@") ? (dep.split("/")[1] ?? dep) : dep;
  return `../../packages/${name}`;
}

/** 纯函数：给定仓库根与可选 worktree，返回检查结论。不打印、不退出。 */
export function preflight(root: string, opts: { worktree?: string } = {}): PreflightResult {
  const target = opts.worktree ? resolve(root, opts.worktree) : root;
  const scan = scanWorkspaceDeps(target);
  const messages: string[] = [];

  if (!scan.hasPackagesDir) {
    messages.push(`✗ 前置检查未通过：${join(target, "packages")} 不存在（不是本仓的仓库根？）`);
    return { ok: false, missing: [], noNodeModules: false, messages, checked: 0 };
  }

  const isWorktree = Boolean(opts.worktree);
  const wtNodeModules = join(target, "node_modules");
  if (isWorktree && !existsSync(wtNodeModules)) {
    messages.push(`✗ worktree 批量编排前置检查未通过（1 项）：`);
    messages.push(`  worktree 未安装依赖 —— ${wtNodeModules} 不存在`);
    messages.push(`  修复：cd ${target} && bun install`);
    return { ok: false, missing: [], noNodeModules: true, messages, checked: 0 };
  }

  const missing: MissingDep[] = [];
  for (const d of scan.deps) {
    const ok = isWorktree
      ? resolveInWorktree(target, d)
      : existsSync(join(target, "node_modules", d.dep));
    if (!ok) missing.push({ ...d, path: join(target, "node_modules", d.dep) });
  }

  if (missing.length === 0) {
    messages.push(`✓ 前置检查通过：${scan.deps.length} 个 workspace 依赖均可解析`);
    return { ok: true, missing, noNodeModules: false, messages, checked: scan.deps.length };
  }

  messages.push(`✗ worktree 批量编排前置检查未通过（${missing.length} 项）：`);
  for (const m of missing) {
    messages.push(`  缺 ${m.dep} —— pre-commit 的 docs:gen-reference --check 会失败`);
    messages.push(`    （由 packages/${m.declaredBy}/package.json 声明，期望可解析于 ${m.path}）`);
  }
  if (isWorktree) {
    messages.push(`  修复：cd ${target} && bun install`);
    messages.push(
      `  若 bun install 判 no changes 不补建：cd ${target} && rm -rf node_modules && bun install`,
    );
  } else {
    messages.push(`  修复：`);
    for (const m of missing) {
      messages.push(`    ln -sfn ${linkTarget(m.dep)} ${join(target, "node_modules", m.dep)}`);
    }
  }
  return { ok: false, missing, noNodeModules: false, messages, checked: scan.deps.length };
}

/** 主仓根：`git rev-parse --show-toplevel`。取不到时返回 null，由 main 报参数错误。 */
function gitRoot(cwd: string = process.cwd()): string | null {
  const r = Bun.spawnSync(["git", "rev-parse", "--show-toplevel"], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
  });
  if (r.exitCode !== 0) return null;
  const out = r.stdout.toString().trim();
  return out || null;
}

export const HELP = `worktree 批量编排前置检查（B1）

判据：packages 下各包的 package.json 里所有 "workspace:" 依赖，在当前探测位置能否解析。
能解析 = existsSync 跟随 symlink 后存在；悬空 symlink 判为缺失。

用法：
  bun run scripts/worktree-batch-preflight.ts                    # 检查主仓（git rev-parse --show-toplevel）
  bun run scripts/worktree-batch-preflight.ts --worktree <path>  # 检查指定 worktree（相对路径相对主仓根）
  bun run scripts/worktree-batch-preflight.ts --help

退出码：0 = 通过；1 = 有依赖解析不了（逐项打印并给修复命令）；2 = 参数错误。

为什么是闸门：worktree 的 node_modules 从主仓 symlink 而来，主仓缺一条
node_modules/@sid-code/<pkg> 时，worktree 里 bun install 会判 no changes 不补建，
pre-commit 的 docs:gen-reference --check 报 Cannot find module，agent 无法提交。
`;

if (import.meta.main) {
  let parsed: { help?: boolean; worktree?: string };
  try {
    parsed = parseArgs({
      args: process.argv.slice(2),
      options: { worktree: { type: "string" }, help: { type: "boolean", default: false } },
      strict: true,
      allowPositionals: false,
    }).values;
  } catch (e) {
    console.error(`参数错误：${e instanceof Error ? e.message : String(e)}\n`);
    console.error(HELP);
    process.exit(2);
  }

  if (parsed.help) {
    console.log(HELP);
    process.exit(0);
  }

  const root = gitRoot();
  if (!root) {
    console.error("参数错误：当前目录不在 git 仓库内，取不到 git rev-parse --show-toplevel");
    process.exit(2);
  }
  if (parsed.worktree !== undefined && parsed.worktree.trim() === "") {
    console.error("参数错误：--worktree 需要一个路径\n");
    console.error(HELP);
    process.exit(2);
  }

  const r = preflight(root, { worktree: parsed.worktree });
  for (const line of r.messages) console.log(line);
  process.exit(r.ok ? 0 : 1);
}
