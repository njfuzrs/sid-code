/**
 * CLAUDE.md @import 处理模块
 * 支持通过 @path/to/file 语法导入其他文件
 *
 * 对齐 Claude Code utils/claudemd.ts：
 * - 行内提取（`See @README for overview` 也识别），跳过代码围栏 / 行内代码 / HTML 注释
 * - 多扩展名白名单（.md .txt .json .yaml .ts .py …）+ 无扩展名（@README）
 * - `~` / `~/` 展开为家目录
 * - 内部/外部导入区分 + 外部导入审批闸门（M4）
 *
 * 安全措施：
 * - 循环导入检测（Set 记录已处理文件）
 * - 深度限制（默认 5 层，对齐 CC 的 >= 5）
 * - 路径遍历防护（allowedDirectories 白名单）
 * - 外部导入（项目根之外）默认跳过，需显式批准（externalApproved）
 */

import { existsSync, realpathSync } from "fs";
import { resolve, dirname, sep, extname } from "path";
import { homedir } from "os";
import { getLogger } from "../debug/logger.ts";

/**
 * 允许导入的文本文件扩展名白名单（对齐 CC TEXT_FILE_EXTENSIONS 的常用子集）。
 * 放开扩展名后，外部导入闸门（M4）是配套安全措施。
 */
const TEXT_FILE_EXTENSIONS = new Set([
  ".md", ".markdown", ".mdx", ".txt", ".text",
  ".json", ".jsonc", ".yaml", ".yml", ".toml", ".ini", ".env",
  ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs",
  ".py", ".rb", ".go", ".rs", ".java", ".kt", ".swift",
  ".c", ".h", ".cpp", ".hpp", ".cc", ".cs",
  ".sh", ".bash", ".zsh", ".fish",
  ".html", ".css", ".scss", ".sql", ".graphql", ".proto",
  ".xml", ".csv", ".log", ".conf", ".cfg", ".gitignore", ".dockerignore",
]);

export interface ImportOptions {
  /** 最大导入深度，防止循环，默认 5 */
  maxDepth?: number;
  /** 允许导入的目录范围（安全限制） */
  allowedDirectories?: string[];
  /**
   * M4：项目根目录。用于判定导入目标是否为「外部导入」（项目根之外）。
   * 未提供时所有导入都按内部处理（向后兼容）。
   */
  projectRoot?: string;
  /**
   * M4：外部导入是否已批准。默认 false——外部导入被跳过。
   * 已批准时外部导入正常展开。
   */
  externalApproved?: boolean;
  /**
   * M4：外部导入被跳过时的回调（用于上层留 system-reminder 提示用户可批准）。
   * 每个被跳过的外部导入路径回调一次。
   */
  onExternalSkipped?: (absolutePath: string) => void;
}

/** 展开路径中的 `~` / `~/` 为家目录（对齐 CC expandPath）。 */
function expandTilde(p: string): string {
  if (p === "~") return homedir();
  if (p.startsWith("~/") || p.startsWith("~\\")) {
    return resolve(homedir(), p.slice(2));
  }
  return p;
}

/** 判定扩展名是否允许导入：白名单内 or 无扩展名（如 @README）。 */
function isImportableExtension(absolutePath: string): boolean {
  const ext = extname(absolutePath).toLowerCase();
  if (ext === "") return true; // 无扩展名（@README、@Makefile）允许
  return TEXT_FILE_EXTENSIONS.has(ext);
}

/**
 * 安全解析路径：跟随 symlink 到 realpath（M9）。
 * 断链 / 不存在时返回 resolve 后的原路径（不抛异常）。
 */
function safeResolvePath(absolutePath: string): string {
  // realpathSync 解析路径中所有层级的 symlink，得到唯一 canonical 路径（去重/环检测键）。
  try {
    return realpathSync(absolutePath);
  } catch {
    // 文件不存在 / 断链 / 权限 → 回退 resolve（不抛异常）
    return resolve(absolutePath);
  }
}

/**
 * 判定绝对路径是否在某个允许目录内（含目录本身）。
 * 两侧都经 safeResolvePath 归一（解析 symlink，如 macOS /tmp→/private/tmp），
 * 避免一侧 realpath 一侧原始路径导致的误判。
 */
function isInsideDir(absolutePath: string, dir: string): boolean {
  const target = safeResolvePath(absolutePath);
  const base = safeResolvePath(dir);
  return target === base || target.startsWith(base + sep);
}

/**
 * 从一行文本中提取 @import 引用（跳过行内代码 `...`）。
 * 支持行首独占（@path）与行内（See @path for ...）两种形态。
 * 返回引用路径数组（去掉尾随标点如句号/逗号）。
 */
function extractImportsFromLine(line: string): string[] {
  // 先剔除行内代码 span（`...`），避免误抓代码里的 @token
  const withoutCode = line.replace(/`[^`]*`/g, " ");
  const imports: string[] = [];
  // 行首或空白后的 @token；token 允许 \  转义空格（对齐 CC 正则思路，简化）
  const re = /(?:^|\s)@((?:[^\s\\]|\\ )+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(withoutCode)) !== null) {
    let path = m[1].replace(/\\ /g, " ").trim();
    // 剥掉常见尾随标点（英文/中文），避免把句末标点当路径一部分
    path = path.replace(/[.,;:)\]，。；：）】]+$/g, "");
    if (path) imports.push(path);
  }
  return imports;
}

/**
 * 处理 CLAUDE.md 内容中的 @import 指令。
 *
 * 语法：`@path/to/file`（行首独占或行内），相对于当前文件所在目录；支持 `~/` 展开。
 * 原始行保留（行内 prose 不破坏），导入内容以标记块追加在该行之后。
 */
export async function processImports(
  content: string,
  filePath: string,
  options: ImportOptions = {}
): Promise<string> {
  const log = getLogger();
  const maxDepth = options.maxDepth ?? 5;
  const allowedDirs = options.allowedDirectories || [];
  const projectRoot = options.projectRoot;
  const externalApproved = options.externalApproved ?? false;
  const visited = new Set<string>();

  async function processRecursive(
    text: string,
    currentFile: string,
    depth: number
  ): Promise<string> {
    // 深度限制（对齐 CC：>= maxDepth 即停，不再多允许一层）
    if (depth >= maxDepth) {
      log.warn("IMPORT", `达到最大导入深度 ${maxDepth}，停止处理: ${currentFile}`);
      return text;
    }

    // 循环导入检测（用 realpath 归一，防 symlink 绕过）
    const normalizedPath = safeResolvePath(currentFile);
    if (visited.has(normalizedPath)) {
      log.warn("IMPORT", `检测到循环导入: ${currentFile}`);
      return text;
    }
    visited.add(normalizedPath);

    const lines = text.split("\n");
    const result: string[] = [];
    const currentDir = dirname(currentFile);

    // 代码围栏跟踪：``` 或 ~~~ 之间的行不做导入提取
    let inFence = false;
    let fenceMarker = "";

    for (const line of lines) {
      const fenceMatch = line.match(/^\s*(```+|~~~+)/);
      if (fenceMatch) {
        const marker = fenceMatch[1][0]; // ` 或 ~
        if (!inFence) {
          inFence = true;
          fenceMarker = marker;
        } else if (marker === fenceMarker) {
          inFence = false;
          fenceMarker = "";
        }
        result.push(line);
        continue;
      }
      if (inFence) {
        result.push(line);
        continue;
      }
      // HTML 注释行不提取（避免注释里的 @token）
      if (/^\s*<!--/.test(line)) {
        result.push(line);
        continue;
      }

      const refs = extractImportsFromLine(line);
      // 无论是否有导入，原始行都保留（行内 prose 不破坏）
      result.push(line);
      if (refs.length === 0) continue;

      for (const importPath of refs) {
        const expanded = expandTilde(importPath);
        // 绝对路径（含展开后的 ~）直接用；相对路径基于当前文件目录
        const rawAbsolute = resolve(currentDir, expanded);
        const absolutePath = safeResolvePath(rawAbsolute);

        // 扩展名白名单（含无扩展名）
        if (!isImportableExtension(absolutePath)) {
          log.debug("IMPORT", `扩展名不在允许列表，跳过: ${importPath}`);
          continue;
        }

        // 路径遍历防护：必须落在某个允许目录内
        if (allowedDirs.length > 0) {
          const isAllowed = allowedDirs.some((dir) => isInsideDir(absolutePath, dir));
          if (!isAllowed) {
            log.warn("IMPORT", `导入路径不在允许的目录范围内: ${importPath}`);
            continue;
          }
        }

        // M4：内部/外部导入区分。外部（项目根之外）默认跳过，需批准。
        const isExternal = projectRoot ? !isInsideDir(absolutePath, projectRoot) : false;
        if (isExternal && !externalApproved) {
          log.warn("IMPORT", `外部导入未批准，跳过: ${importPath}（${absolutePath}）`);
          try { options.onExternalSkipped?.(absolutePath); } catch { /* 回调失败不阻断 */ }
          continue;
        }

        // 文件存在性
        if (!existsSync(absolutePath)) {
          log.warn("IMPORT", `导入文件不存在: ${absolutePath}`);
          continue;
        }

        // 循环 / 深度前置检查
        if (visited.has(safeResolvePath(absolutePath))) {
          log.warn("IMPORT", `检测到循环导入: ${importPath}`);
          continue;
        }
        if (depth + 1 >= maxDepth) {
          log.warn("IMPORT", `达到最大导入深度 ${maxDepth}，跳过: ${importPath}`);
          continue;
        }

        try {
          const importedContent = await Bun.file(absolutePath).text();
          const processedContent = await processRecursive(importedContent, absolutePath, depth + 1);
          result.push(`<!-- @import ${importPath} -->`);
          result.push(processedContent);
          result.push(`<!-- end @import ${importPath} -->`);
          log.debug("IMPORT", `成功导入: ${importPath} (深度 ${depth})`);
        } catch (err) {
          log.warn("IMPORT", `读取导入文件失败: ${absolutePath}`, err);
        }
      }
    }

    return result.join("\n");
  }

  return processRecursive(content, filePath, 0);
}
