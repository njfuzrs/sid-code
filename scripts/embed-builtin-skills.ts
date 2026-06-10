/**
 * 编译期生成 builtin Skill 嵌入清单
 *
 * 背景（已确证根因）：`bun build --compile` 只会把被 import 的 TS/JS 模块打进二进制，
 * 而 builtin SKILL.md 是 SkillLoader 用 fs.readFile 读盘的纯数据文件，--compile 不会嵌入它们。
 * 编译二进制运行时 import.meta.url=/$bunfs/root，manager.ts 推导出的 builtinDir 在真实磁盘上
 * 不存在 → 所有 builtin skill 加载失败（/skills 显示"未找到"、/bug-fix 命令不存在）。
 *
 * 解决：编译前扫描 src/skill/builtin/<name>/SKILL.md，把每个文件的原文生成到一个真正被 import
 * 的 TS 模块（builtin-embedded.generated.ts）。该模块会被 --compile 打进二进制，运行时
 * SkillManager 在磁盘扫不到 builtin 目录时回退用这份嵌入清单解析。
 *
 * 用法：make build 在 bun build --compile 之前执行本脚本（见 Makefile）。
 * 源码运行（bun run src/cli.ts）仍走磁盘扫描，嵌入清单仅作为编译二进制的回退数据。
 */
import { readFileSync, writeFileSync, readdirSync, existsSync, statSync } from "node:fs";
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

const header = `/**
 * 自动生成文件 —— 请勿手动编辑。
 *
 * 由 scripts/embed-builtin-skills.ts 在 make build 时生成。
 * 内容是 src/skill/builtin/<name>/SKILL.md 的原文，用于编译二进制（bun build --compile）
 * 运行时回退加载 builtin Skill（详见生成脚本注释）。
 */

export interface EmbeddedBuiltinSkill {
  /** 子目录名（= skill 名） */
  name: string;
  /** SKILL.md 原文（含 frontmatter） */
  rawContent: string;
}

export const EMBEDDED_BUILTIN_SKILLS: EmbeddedBuiltinSkill[] = `;

const body = JSON.stringify(entries, null, 2);

writeFileSync(outPath, `${header}${body};\n`, "utf-8");

console.log(`已嵌入 ${entries.length} 个 builtin Skill → src/skill/builtin-embedded.generated.ts`);
for (const e of entries) {
  console.log(`  - ${e.name}`);
}
