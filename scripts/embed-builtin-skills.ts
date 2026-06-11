/**
 * 编译期生成 builtin Skill 嵌入清单
 *
 * 背景（已确证根因）：`bun build --compile` 只会把被 import 的 TS/JS 模块打进二进制，
 * 而 builtin SKILL.md 是用 fs.readFile 读盘的纯数据文件，--compile 不会嵌入它们；
 * 且编译二进制运行时 import.meta.url=/$bunfs/root，无法用相对路径定位 builtin 目录。
 *
 * 解决：编译前扫描 src/skill/builtin/<name>/SKILL.md，把每个文件原文生成到一个真正被 import
 * 的 TS 模块（builtin-embedded.generated.ts）。该模块会被 --compile 打进二进制。
 * 运行时由 ensure-builtin.ts 把这份清单**释放到磁盘** ~/.sid-code/builtin-skills/<name>/SKILL.md，
 * 之后 builtin / user / project 三类 skill 走同一条磁盘加载链（详见 ensure-builtin.ts）。
 *
 * 同时生成内容哈希 EMBEDDED_BUILTIN_SKILLS_HASH：释放模块据此判断磁盘内容是否过期、
 * 是否需要重新释放（内容变了哈希就变，无需依赖版本号）。
 *
 * 用法：make build 在 bun build --compile 之前执行本脚本（见 Makefile）。
 * 源码运行（bun run src/cli.ts）也走同一释放逻辑，保证两种形态行为一致。
 */
import { readFileSync, writeFileSync, readdirSync, existsSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const builtinDir = resolve(__dirname, "..", "src", "skill", "builtin");
const outPath = resolve(__dirname, "..", "src", "skill", "builtin-embedded.generated.ts");

interface EmbeddedEntry {
  name: string;
  rawContent: string;
}

const entries: EmbeddedEntry[] = [];

if (existsSync(builtinDir)) {
  for (const entry of readdirSync(builtinDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const skillFile = join(builtinDir, entry.name, "SKILL.md");
    if (existsSync(skillFile) && statSync(skillFile).isFile()) {
      const rawContent = readFileSync(skillFile, "utf-8");
      entries.push({ name: entry.name, rawContent });
    }
  }
}

// 名称排序，保证生成结果稳定（diff 友好，避免无意义改动）
entries.sort((a, b) => a.name.localeCompare(b.name));

// 内容哈希：覆盖所有 skill 的 name + 原文，内容变则哈希变 → 触发重新释放
const hash = createHash("sha256");
for (const e of entries) {
  hash.update(e.name);
  hash.update("\0");
  hash.update(e.rawContent);
  hash.update("\0");
}
const contentHash = hash.digest("hex").slice(0, 16);

const header = `/**
 * 自动生成文件 —— 请勿手动编辑。
 *
 * 由 scripts/embed-builtin-skills.ts 在 make build 时生成。
 * 内容是 src/skill/builtin/<name>/SKILL.md 的原文，被 import 后会随 bun build --compile
 * 打进二进制。运行时由 src/skill/ensure-builtin.ts 释放到 ~/.sid-code/builtin-skills/。
 */

export interface EmbeddedBuiltinSkill {
  /** 子目录名（= skill 名） */
  name: string;
  /** SKILL.md 原文（含 frontmatter） */
  rawContent: string;
}

/** 嵌入内容哈希（sha256 前 16 位）：释放模块据此判断磁盘内容是否过期 */
export const EMBEDDED_BUILTIN_SKILLS_HASH = ${JSON.stringify(contentHash)};

export const EMBEDDED_BUILTIN_SKILLS: EmbeddedBuiltinSkill[] = `;

const body = JSON.stringify(entries, null, 2);

writeFileSync(outPath, `${header}${body};\n`, "utf-8");

console.log(`已嵌入 ${entries.length} 个 builtin Skill（hash=${contentHash}）→ src/skill/builtin-embedded.generated.ts`);
for (const e of entries) {
  console.log(`  - ${e.name}`);
}
