#!/usr/bin/env bun
/**
 * 新渲染底座相似度门禁（B9 / T1.3，设计文档 D-5 第 3 条）。
 *
 * 要拦的是「从旧底座复制代码进新底座」。旧底座本身也源自 ink，所以单纯数新旧之间的重复块
 * 会把共同继承自上游的骨架也算进去（实测上游 ink@7.1.1 与旧底座之间，N=30 时有 39 处跨库重复）。判据：
 *
 *   新底座 ↔ 旧底座的每个重复块，若新底座那一段（去空白后）原样出现在上游 ink 同名文件里，
 *   就算「继承自上游」，放行；否则算违规。违规数必须为 0。
 *
 * 上游基线不联网下载，用 T1.1 导入提交里 `packages/tui/src` 的 **tree 对象**（`UPSTREAM_TREE`）：
 * 它与 ink v7.1.1 tag 的 `src/` 是同一个 git tree（OID 相同即字节相同），而且以后怎么改
 * `packages/tui/src`，这个对象都还在历史里。前提是 checkout 带历史；浅克隆会明确报错，不会静默跳过。
 *
 * 扫描面（新）：`packages/tui/src` + `packages/cli/src/ui/render-port/next/`。
 * 扫描面（旧）：`packages/tui-renderer/src`（`vendor:fetch` 取回，不入库）。
 *
 * 用法：
 *   bun run tui:similarity            # 校验，有违规退 1
 *   bun run tui:similarity --report   # 额外打印放行的「继承自上游」块数
 */

import { cpSync, existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, relative, resolve } from "node:path";

const ROOT = resolve(import.meta.dir, "..");

/**
 * ink v7.1.1 `src/` 的 git tree OID（= T1.1 提交 8fd9048d 里的 `packages/tui/src`）。
 * 用 tree 而不是 commit 号：分支变基会改 commit 号，tree OID 只跟内容有关，不受影响。
 */
export const UPSTREAM_TREE = "c14ef7b43c4353f4ff5a1a0688d285a549606770";

/**
 * 最小 token 数。校准（2026-10-04，jscpd 5.4.0）：
 * - 噪声底：与渲染无关的本仓代码 ↔ 旧底座，N=20 时 core 与 cli 都是 0 处（核过 jscpd 确实扫到了两边）；
 * - 同源骨架：上游 ink ↔ 旧底座，N=30/50/70/100 时分别为 39/10/4/3 处。
 * 取 30：比噪声底高一档留余量；同源骨架由「继承自上游」规则放行，不靠调高 N 来躲。
 */
export const MIN_TOKENS = 30;

export const NEW_DIRS = ["packages/tui/src", "packages/cli/src/ui/render-port/next"];
export const LEGACY_DIR = "packages/tui-renderer/src";

interface Loc {
  name: string;
  startLoc: { position: number };
  endLoc: { position: number };
}
interface Clone {
  firstFile: Loc;
  secondFile: Loc;
  tokens: number;
  lines: number;
}

export interface Finding {
  newFile: string;
  legacyFile: string;
  tokens: number;
  lines: number;
}

const squash = (s: string) => s.replace(/\s+/g, "");

/** 新底座目录在临时扫描根下的子目录名：仓库内用仓库相对路径（报告可读），仓库外（测试夹具）用末级名。 */
function dirLabel(d: string): string {
  const rel = relative(ROOT, d);
  return rel.startsWith("..") ? basename(d) : rel;
}

/** `packages/tui/src/components/Box.tsx` → `components/Box.tsx`，用来找上游同名文件。 */
function upstreamRelative(newPath: string, newDirs: string[]): string {
  for (const d of newDirs) {
    const label = dirLabel(d);
    if (newPath.startsWith(`${label}/`)) return newPath.slice(label.length + 1);
  }
  return newPath;
}

/** 把上游 tree 解到目录里。拿不到 tree（浅克隆）就抛，不降级。 */
export function extractUpstream(dest: string): void {
  const r = Bun.spawnSync(
    ["sh", "-c", `git archive --format=tar ${UPSTREAM_TREE} | tar -x -C "$1"`, "sh", dest],
    {
      cwd: ROOT,
      stderr: "pipe",
    },
  );
  if (r.exitCode !== 0 || !existsSync(join(dest, "index.ts"))) {
    throw new Error(
      `取不到上游基线 tree ${UPSTREAM_TREE}（浅克隆？）：${r.stderr.toString().trim()}\n` +
        "门禁需要完整历史：git fetch --unshallow",
    );
  }
}

/**
 * 核心判定，目录全部由调用方给出（测试用它做变异自证）。
 * `newDirs` 里每个目录的内容会被复制到同一个 `new/` 下，按目录名分子目录。
 */
export function scan(opts: {
  newDirs: string[];
  legacyDir: string;
  upstreamDir: string;
  /** 防空转下限，默认 100（真实仓库新 62+ / 旧 120+）；合成夹具测试才调低 */
  minSources?: number;
}): {
  violations: Finding[];
  inherited: number;
} {
  const work = mkdtempSync(join(tmpdir(), "tui-similarity-"));
  try {
    // jscpd 报告里的路径相对于扫描根，所以把两边复制到同一根下的 new/ 与 legacy/，路径才不会撞名
    for (const d of opts.newDirs) {
      cpSync(d, join(work, "new", dirLabel(d)), { recursive: true, dereference: true });
    }
    cpSync(realpathSync(opts.legacyDir), join(work, "legacy"), {
      recursive: true,
      dereference: true,
    });

    const out = join(work, "_report");
    const bin = join(ROOT, "node_modules", "jscpd", "run-jscpd.js");
    const r = Bun.spawnSync(
      [
        process.execPath,
        bin,
        work,
        "--min-tokens",
        String(MIN_TOKENS),
        "--format",
        "typescript,tsx",
        "--ignore",
        "**/_report/**",
        "--no-gitignore",
        "--reporters",
        "json",
        "--output",
        out,
        "--silent",
      ],
      { stdout: "pipe", stderr: "pipe" },
    );
    const reportPath = join(out, "jscpd-report.json");
    if (r.exitCode !== 0 || !existsSync(reportPath)) {
      throw new Error(`jscpd 运行失败（rc=${r.exitCode}）：${r.stderr.toString().trim()}`);
    }
    const report = JSON.parse(readFileSync(reportPath, "utf8")) as {
      duplicates: Clone[];
      statistics: { total: { sources: number } };
    };
    // 防空转：两边都得真扫到文件（新底座 62+、旧底座 120+）
    if (report.statistics.total.sources < (opts.minSources ?? 100)) {
      throw new Error(`jscpd 只扫到 ${report.statistics.total.sources} 个文件，门禁在空转`);
    }

    const violations: Finding[] = [];
    let inherited = 0;
    for (const c of report.duplicates) {
      const a = c.firstFile,
        b = c.secondFile;
      const side = (l: Loc) => l.name.split("/")[0];
      if (
        new Set([side(a), side(b)]).size !== 2 ||
        !["new", "legacy"].includes(side(a)) ||
        !["new", "legacy"].includes(side(b))
      )
        continue;
      const n = side(a) === "new" ? a : b;
      const l = n === a ? b : a;
      const newRel = upstreamRelative(n.name.slice("new/".length), opts.newDirs);
      const fragment = readFileSync(join(work, n.name), "utf8").slice(
        n.startLoc.position,
        n.endLoc.position,
      );
      const upstreamFile = join(opts.upstreamDir, newRel);
      const fromUpstream =
        existsSync(upstreamFile) &&
        squash(readFileSync(upstreamFile, "utf8")).includes(squash(fragment));
      if (fromUpstream) inherited++;
      else
        violations.push({
          newFile: n.name.slice(4),
          legacyFile: l.name.slice(7),
          tokens: c.tokens,
          lines: c.lines,
        });
    }
    return { violations, inherited };
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

export function scanRepo() {
  const legacyDir = join(ROOT, LEGACY_DIR);
  if (!existsSync(legacyDir)) {
    throw new Error(`${LEGACY_DIR} 不存在，先跑 bun run vendor:fetch`);
  }
  const upstreamDir = mkdtempSync(join(tmpdir(), "tui-upstream-"));
  try {
    extractUpstream(upstreamDir);
    return scan({ newDirs: NEW_DIRS.map((d) => join(ROOT, d)), legacyDir, upstreamDir });
  } finally {
    rmSync(upstreamDir, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  const { violations, inherited } = scanRepo();
  if (process.argv.includes("--report")) {
    console.log(`继承自上游、已放行的新旧重复块：${inherited} 处（N=${MIN_TOKENS}）`);
  }
  if (violations.length) {
    console.error(`❌ 新底座有 ${violations.length} 处与旧底座重复、且上游 ink 里没有的代码块：`);
    for (const v of violations) {
      console.error(
        `  ${v.newFile}  ↔  旧底座 ${v.legacyFile}（${v.tokens} tokens / ${v.lines} 行）`,
      );
    }
    console.error("要么改写，要么证明它来自上游 ink（设计文档 D-5 第 3 条）。");
    process.exit(1);
  }
  console.log(
    `✅ 新底座与旧底座之间没有非上游来源的重复块（N=${MIN_TOKENS}，放行继承自上游 ${inherited} 处）。`,
  );
}
