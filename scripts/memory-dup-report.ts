#!/usr/bin/env bun
/**
 * 列出记忆库里 frontmatter `name:` 重名的文件对（S9 存量处置的只读出口）
 *
 * ## 为什么只列不改
 *
 * 重名的两半哪一半该留是**语义判断**（实测本仓一对里丢掉的恰是「问题现象与复现方式」、
 * 留下的是「已修复」），而用户记忆是用户数据。所以本脚本**只读**：
 * 列出胜者（按 store 同一判据：`updated` 大者胜，同值取文件名字典序前者）、被遮蔽者、
 * 两者正文的行级差异，由人决定合并后把被遮蔽者手动移进 `archive/`。
 *
 * 用法：
 *   bun run scripts/memory-dup-report.ts              # 当前项目的记忆目录
 *   bun run scripts/memory-dup-report.ts <memory目录>  # 指定目录
 *
 * 退出码：0 = 无重名；1 = 有重名（可接进自检）。
 */

import { readdirSync, readFileSync, statSync } from "fs";
import { join } from "path";
import { getAutoMemPath } from "../packages/core/src/memory/paths.ts";

const dir = process.argv[2] ?? getAutoMemPath(process.cwd());

interface FileInfo {
  file: string;
  name: string;
  updated: number;
  body: string;
}

function walk(d: string, rel = ""): string[] {
  const out: string[] = [];
  for (const ent of readdirSync(d, { withFileTypes: true })) {
    // archive/ 与 store 的枚举口径一致：归档区不参与重名判定
    if (ent.isDirectory()) {
      if (ent.name === "archive" || ent.name.startsWith(".")) continue;
      out.push(...walk(join(d, ent.name), join(rel, ent.name)));
    } else if (ent.name.endsWith(".md") && ent.name !== "MEMORY.md") {
      out.push(join(rel, ent.name));
    }
  }
  return out;
}

const infos: FileInfo[] = [];
for (const file of walk(dir).sort()) {
  const text = readFileSync(join(dir, file), "utf8");
  const fm = text.match(/^---\n([\s\S]*?)\n---/)?.[1] ?? "";
  const name = fm.match(/^name:\s*(.+)$/m)?.[1]?.trim();
  if (!name) continue;
  const upd = Number(fm.match(/^updated:\s*(\d+)/m)?.[1]);
  infos.push({
    file,
    name,
    updated: Number.isFinite(upd) ? upd : statSync(join(dir, file)).mtimeMs,
    body: text.slice(text.indexOf("---", 3) + 3).trim(),
  });
}

const byName = new Map<string, FileInfo[]>();
for (const i of infos) byName.set(i.name, [...(byName.get(i.name) ?? []), i]);
const dups = [...byName].filter(([, v]) => v.length > 1);

console.log(`目录：${dir}`);
console.log(
  `扫描 ${infos.length} 个带 name 的文件，唯一 name ${byName.size}，重名 ${dups.length} 组`,
);
for (const [name, group] of dups) {
  group.sort((a, b) => b.updated - a.updated || (a.file < b.file ? -1 : 1));
  const [winner, ...losers] = group;
  console.log(`\n## ${name}`);
  console.log(`  胜者（进索引）：${winner!.file}`);
  for (const l of losers) {
    console.log(`  被遮蔽：      ${l.file}`);
    const w = new Set(winner!.body.split("\n"));
    const only = l.body.split("\n").filter((line) => line.trim() && !w.has(line));
    console.log(
      only.length
        ? `  仅被遮蔽者有的行（${only.length}）：\n${only.map((x) => `    | ${x}`).join("\n")}`
        : "  被遮蔽者正文是胜者的子集，可直接移 archive/",
    );
  }
}
process.exit(dups.length > 0 ? 1 : 0);
