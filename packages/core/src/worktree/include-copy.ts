/**
 * .worktreeinclude 文件支持（P1-4）
 *
 * 问题：.env / .secrets 等 gitignored 文件不会被 git worktree add 带过去，
 * 但开发时往往需要它们。
 *
 * 方案：主仓根下放 .worktreeinclude（gitignore 语法：`*` / `**` / `!` / 锚定 / 目录限定，W24），列出需要跟随 worktree 的
 * gitignored 文件 / 目录。创建 worktree 后把匹配项复制过去。
 *
 * 性能：用 `git ls-files --others --ignored --exclude-standard --directory`，
 * --directory 折叠完全 gitignored 的目录（避免列出百万文件），只对匹配 pattern 的展开。
 */

import { existsSync, readFileSync, mkdirSync, copyFileSync, statSync, readdirSync } from "fs";
import { join, dirname, relative, posix } from "path";
import { execFileSync } from "child_process";
import { minimatch } from "minimatch";
import { getLogger } from "../debug/logger.ts";

const INCLUDE_FILE = ".worktreeinclude";

/**
 * 单条 gitignore 风格 pattern。
 *
 * W24：旧实现只存一个 normalized 字符串、按前缀相等比较，`*` / `**` / `!` / 字符组
 * 全部原样留在字符串里 —— 文件头写着「gitignore 语法」，实际只认字面路径。
 * 用户照 .gitignore 抄一行 `*.pem` 或 `config/*.env`，创建成功、零报错、文件没跟过来。
 * 现在按 gitignore 的四条规则解析：`!` 取反、尾 `/` 只匹配目录、
 * 中间含 `/`（或前导 `/`）即相对仓库根锚定、否则在任意层级按名字匹配。
 */
export interface Pattern {
  /** 原始行（trim 后） */
  raw: string;
  /** 去掉 `!`、前导 `./` `/`、尾部 `/` 之后的 glob 主体 */
  normalized: string;
  /** `!` 开头：命中则排除 */
  negate: boolean;
  /** 尾部 `/`：只匹配目录 */
  dirOnly: boolean;
  /** 含 `/`：相对仓库根整路径匹配；否则按任意层级的名字匹配 */
  anchored: boolean;
}

/** 解析 .worktreeinclude，返回 pattern 列表（忽略注释和空行） */
export function parseIncludeFile(gitRoot: string): Pattern[] {
  const path = join(gitRoot, INCLUDE_FILE);
  if (!existsSync(path)) return [];
  let content = "";
  try {
    content = readFileSync(path, "utf-8");
  } catch {
    return [];
  }
  const patterns: Pattern[] = [];
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    let body = trimmed;
    // gitignore：`\!` / `\#` 是字面量转义
    const negate = body.startsWith("!");
    if (negate) body = body.slice(1);
    else if (body.startsWith("\\!") || body.startsWith("\\#")) body = body.slice(1);
    const dirOnly = body.endsWith("/");
    body = body.replace(/\/+$/, "");
    const leadingSlash = /^\.?\//.test(body);
    body = body.replace(/^\.?\/+/, "");
    if (!body) continue;
    patterns.push({
      raw: trimmed,
      normalized: body,
      negate,
      dirOnly,
      anchored: leadingSlash || body.includes("/"),
    });
  }
  return patterns;
}

const MM_OPTS = { dot: true } as const;

/** 单条 pattern 是否命中某个路径（只看这一层，不看父目录） */
function hitsSelf(relPath: string, isDir: boolean, p: Pattern): boolean {
  if (p.dirOnly && !isDir) return false;
  if (p.anchored) return minimatch(relPath, p.normalized, MM_OPTS);
  return minimatch(posix.basename(relPath), p.normalized, MM_OPTS);
}

/**
 * gitignore 语义：路径自身或任一父目录被命中都算命中；多条 pattern 以**最后命中的那条**为准
 * （所以 `secrets/` 之后的 `!secrets/a.pem` 能把单个文件排除掉）。
 */
export function matchesPatterns(relPath: string, isDir: boolean, patterns: Pattern[]): boolean {
  const parts = relPath.split("/");
  let included = false;
  for (const p of patterns) {
    let hit = false;
    for (let i = 1; i <= parts.length && !hit; i++) {
      const prefix = parts.slice(0, i).join("/");
      const prefixIsDir = i < parts.length || isDir;
      hit = hitsSelf(prefix, prefixIsDir, p);
    }
    if (hit) included = !p.negate;
  }
  return included;
}

/**
 * git 的 `--directory` 会把整个被忽略的目录折叠成一条（如 `config`）。
 * 目录本身没命中、但有 pattern 明确指向它内部（`config/*.env`、`config/db.env`）时，
 * 要展开这个目录逐个文件判定，而不是像旧实现那样把整个目录复制过去。
 *
 * 只对**锚定且字面前缀落在该目录内**的 pattern 展开：不锚定的 `*.pem` 若也触发展开，
 * 一个折叠的 node_modules/ 就会被整棵遍历，把创建 worktree 拖成分钟级。
 */
function needsExpansion(dirRel: string, patterns: Pattern[]): boolean {
  return patterns.some((p) => {
    if (p.negate || !p.anchored) return false;
    return literalPrefix(p).startsWith(dirRel + "/");
  });
}

/** 字面前缀：glob 元字符之前的部分 */
function literalPrefix(p: Pattern): string {
  return p.normalized.split(/[*?[]/)[0];
}

/** 是否存在可能作用于 dirRel 内部的否定 pattern（不锚定的否定可作用于任意层级） */
function hasNegateInside(dirRel: string, patterns: Pattern[]): boolean {
  return patterns.some(
    (p) => p.negate && (!p.anchored || literalPrefix(p).startsWith(dirRel + "/")),
  );
}

/** 递归列出目录下的全部文件（相对仓库根） */
function walkFiles(gitRoot: string, dirRel: string, out: string[]): void {
  let children: string[];
  try {
    children = readdirSync(join(gitRoot, dirRel));
  } catch {
    return;
  }
  for (const c of children) {
    const rel = `${dirRel}/${c}`;
    let st: ReturnType<typeof statSync>;
    try {
      st = statSync(join(gitRoot, rel));
    } catch {
      continue;
    }
    if (st.isDirectory()) walkFiles(gitRoot, rel, out);
    else if (st.isFile()) out.push(rel);
  }
}

/** 列出主仓中所有 gitignored 的文件/目录（折叠目录） */
function listIgnoredEntries(gitRoot: string): string[] {
  try {
    const out = execFileSync(
      "git",
      ["ls-files", "--others", "--ignored", "--exclude-standard", "--directory"],
      { cwd: gitRoot, encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] },
    );
    return out
      .split("\n")
      .map((s) => s.trim().replace(/\/+$/, ""))
      .filter(Boolean);
  } catch {
    return [];
  }
}

/** 递归复制文件或目录（保持相对结构） */
function copyRecursive(src: string, dest: string): void {
  let st: ReturnType<typeof statSync>;
  try {
    st = statSync(src);
  } catch {
    return;
  }
  if (st.isDirectory()) {
    mkdirSync(dest, { recursive: true });
    for (const child of readdirSync(src)) {
      copyRecursive(join(src, child), join(dest, child));
    }
  } else if (st.isFile()) {
    mkdirSync(dirname(dest), { recursive: true });
    copyFileSync(src, dest);
  }
}

/**
 * 把 .worktreeinclude 匹配的 gitignored 文件复制到 worktree。
 * 在 postCreationSetup 末尾调用。失败仅 warn，不阻断创建。
 */
export function applyWorktreeInclude(gitRoot: string, worktreePath: string): void {
  const log = getLogger();
  const patterns = parseIncludeFile(gitRoot);
  if (patterns.length === 0) return;

  const ignored = listIgnoredEntries(gitRoot);
  let copied = 0;

  const copyOne = (entry: string): void => {
    const src = join(gitRoot, entry);
    const dest = join(worktreePath, entry);
    // 防覆盖：worktree 内已有则跳过
    if (existsSync(dest)) return;
    try {
      copyRecursive(src, dest);
      copied++;
    } catch (err: any) {
      log.warn("WORKTREE", `复制 ${entry} 到 worktree 失败: ${err.message}`);
    }
  };

  for (const entry of ignored) {
    const rel = relative(gitRoot, join(gitRoot, entry)).split("\\").join("/");
    let isDir = false;
    try {
      isDir = statSync(join(gitRoot, entry)).isDirectory();
    } catch {
      continue;
    }
    const matched = matchesPatterns(rel, isDir, patterns);
    // 目录命中但有否定 pattern 可能伸进它内部（`secrets/` + `!secrets/a.pem`）→ 逐文件判定，
    // 让 `!` 真的生效；目录没命中但有锚定 pattern 指向它内部（`config/*.env`）→ 同样展开。
    // 其余情况整条复制 / 整条跳过，不遍历（避免把折叠的大目录整棵走一遍）。
    const expand =
      isDir && (matched ? hasNegateInside(rel, patterns) : needsExpansion(rel, patterns));
    if (expand) {
      const files: string[] = [];
      walkFiles(gitRoot, rel, files);
      for (const f of files) {
        if (matchesPatterns(f, false, patterns)) copyOne(f);
      }
    } else if (matched) {
      copyOne(entry);
    }
  }

  if (copied > 0) {
    log.info("WORKTREE", `.worktreeinclude: 复制了 ${copied} 个条目到 worktree`);
  }
}
