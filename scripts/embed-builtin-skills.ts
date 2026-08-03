/**
 * 编译期生成 builtin Skill 嵌入清单
 *
 * 背景（已确证根因）：`bun build --compile` 只会把被 import 的 TS/JS 模块打进二进制，
 * 而 builtin Skill 的资产（SKILL.md / references / scripts / validations / evals / learnings.md）
 * 是用 fs.readFile 读盘的纯数据文件，--compile 不会嵌入它们；
 * 且编译二进制运行时 import.meta.url=/$bunfs/root，无法用相对路径定位 builtin 目录。
 *
 * 解决：编译前递归扫描 src/skill/builtin/<name>/ 下的**所有文件**，把每个文件原文生成到一个
 * 真正被 import 的 TS 模块（builtin-embedded.generated.ts）。该模块会被 --compile 打进二进制。
 * 运行时由 ensure-builtin.ts 把这份清单**按原目录结构释放到磁盘**
 * ~/.sid-code/builtin-skills/<name>/...，之后 builtin / user / project 三类 skill 走同一条磁盘
 * 加载链（详见 ensure-builtin.ts）。
 *
 * 为什么要嵌入整个目录而非只嵌 SKILL.md（已确证 bug）：
 * - delegate 模式的 skill agent 会用相对路径 Read references/scripts 等附属文件；
 * - 若只释放 SKILL.md，这些相对路径在运行时全部读不到，附属文件形同虚设。
 *
 * 同时生成内容哈希 EMBEDDED_BUILTIN_SKILLS_HASH：释放模块据此判断磁盘内容是否过期、
 * 是否需要重新释放（任一文件内容变了哈希就变，无需依赖版本号）。
 *
 * 文件编码：文本文件（按扩展名识别）以 utf-8 原文存储，保证生成结果 diff 友好；
 * 其它文件（二进制）以 base64 存储，释放时解码还原。
 *
 * 用法：make build 在 bun build --compile 之前执行本脚本（见 Makefile）。
 * 源码运行（bun run src/cli.ts）也走同一释放逻辑，保证两种形态行为一致。
 */
import { readFileSync, writeFileSync, readdirSync, existsSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import { resolve, dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const builtinDir = resolve(__dirname, "..", "src", "skill", "builtin");
const outPath = resolve(__dirname, "..", "src", "skill", "builtin-embedded.generated.ts");

/** 以 utf-8 原文存储的文本文件扩展名（其余按二进制 base64 处理） */
const TEXT_EXTENSIONS = new Set([
  ".md", ".markdown", ".txt", ".json", ".jsonc", ".yaml", ".yml",
  ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".toml", ".csv", ".tsv",
  ".html", ".htm", ".css", ".svg", ".xml", ".sh", ".env", ".ini", ".cfg",
]);

interface EmbeddedFile {
  /** 相对 skill 根目录的路径（统一用 / 分隔，跨平台一致） */
  relPath: string;
  /** 文件内容（utf-8 原文 或 base64） */
  content: string;
  /** 内容编码 */
  encoding: "utf-8" | "base64";
}

interface EmbeddedEntry {
  name: string;
  /** SKILL.md 原文（含 frontmatter）—— 向后兼容字段（review.ts 等直接读取） */
  rawContent: string;
  /** skill 目录下所有文件（含 SKILL.md），按 relPath 排序 */
  files: EmbeddedFile[];
}

function extOf(path: string): string {
  const i = path.lastIndexOf(".");
  return i >= 0 ? path.slice(i).toLowerCase() : "";
}

/** 递归收集目录下所有文件，返回相对 root 的路径列表（POSIX 分隔） */
function collectFiles(root: string, current: string, out: string[]): void {
  for (const entry of readdirSync(current, { withFileTypes: true })) {
    const abs = join(current, entry.name);
    if (entry.isDirectory()) {
      collectFiles(root, abs, out);
    } else if (entry.isFile()) {
      out.push(relative(root, abs).split(sep).join("/"));
    }
  }
}

const entries: EmbeddedEntry[] = [];

if (existsSync(builtinDir)) {
  for (const entry of readdirSync(builtinDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const skillRoot = join(builtinDir, entry.name);
    const skillFile = join(skillRoot, "SKILL.md");
    // 只把含 SKILL.md 的目录视为 skill（与旧逻辑一致）
    if (!existsSync(skillFile) || !statSync(skillFile).isFile()) continue;

    const relPaths: string[] = [];
    collectFiles(skillRoot, skillRoot, relPaths);
    relPaths.sort((a, b) => a.localeCompare(b));

    const files: EmbeddedFile[] = relPaths.map((relPath) => {
      const abs = join(skillRoot, ...relPath.split("/"));
      if (TEXT_EXTENSIONS.has(extOf(relPath))) {
        return { relPath, content: readFileSync(abs, "utf-8"), encoding: "utf-8" as const };
      }
      return { relPath, content: readFileSync(abs).toString("base64"), encoding: "base64" as const };
    });

    const skillMd = files.find((f) => f.relPath === "SKILL.md");
    entries.push({
      name: entry.name,
      rawContent: skillMd?.encoding === "utf-8" ? skillMd.content : readFileSync(skillFile, "utf-8"),
      files,
    });
  }
}

// 名称排序，保证生成结果稳定（diff 友好，避免无意义改动）
entries.sort((a, b) => a.name.localeCompare(b.name));

// 内容哈希：覆盖所有 skill 的 name + 每个文件的 relPath/encoding/content，
// 任一文件内容或路径变则哈希变 → 触发重新释放
const hash = createHash("sha256");
for (const e of entries) {
  hash.update(e.name);
  hash.update("\0");
  for (const f of e.files) {
    hash.update(f.relPath);
    hash.update("\0");
    hash.update(f.encoding);
    hash.update("\0");
    hash.update(f.content);
    hash.update("\0");
  }
  hash.update("\x01"); // skill 边界分隔，防止跨 skill 拼接碰撞
}
const contentHash = hash.digest("hex").slice(0, 16);

const totalFiles = entries.reduce((n, e) => n + e.files.length, 0);

const header = `/**
 * 自动生成文件 —— 请勿手动编辑。
 *
 * 由 scripts/embed-builtin-skills.ts 在 make build 时生成。
 * 内容是 src/skill/builtin/<name>/ 下所有文件的原文，被 import 后会随 bun build --compile
 * 打进二进制。运行时由 src/skill/ensure-builtin.ts 按原目录结构释放到 ~/.sid-code/builtin-skills/。
 */

export interface EmbeddedBuiltinFile {
  /** 相对 skill 根目录的路径（POSIX 分隔，如 references/output-template.md） */
  relPath: string;
  /** 文件内容（utf-8 原文 或 base64） */
  content: string;
  /** 内容编码：文本为 utf-8，二进制为 base64 */
  encoding: "utf-8" | "base64";
}

export interface EmbeddedBuiltinSkill {
  /** 子目录名（= skill 名） */
  name: string;
  /** SKILL.md 原文（含 frontmatter）—— 向后兼容字段 */
  rawContent: string;
  /** skill 目录下所有文件（含 SKILL.md），按 relPath 排序 */
  files: EmbeddedBuiltinFile[];
}

/** 嵌入内容哈希（sha256 前 16 位）：释放模块据此判断磁盘内容是否过期 */
export const EMBEDDED_BUILTIN_SKILLS_HASH = ${JSON.stringify(contentHash)};

export const EMBEDDED_BUILTIN_SKILLS: EmbeddedBuiltinSkill[] = `;

const body = JSON.stringify(entries, null, 2);

writeFileSync(outPath, `${header}${body};\n`, "utf-8");

console.log(
  `已嵌入 ${entries.length} 个 builtin Skill、共 ${totalFiles} 个文件（hash=${contentHash}）→ src/skill/builtin-embedded.generated.ts`,
);
