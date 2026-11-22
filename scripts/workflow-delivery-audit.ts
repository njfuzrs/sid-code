#!/usr/bin/env bun
/**
 * 批量交付审计（B2）：回答一个只有 git 状态能回答的问题——**每个单元的产出到底落在哪了**。
 *
 * ## 为什么存在这个脚本
 *
 * 2026-11-19 实测：4 个并行 agent 跑完、主控汇总时有两类静默损失，靠 agent 自觉报告一句话防不住：
 *
 * 1. **worktree 里有未提交改动，主控直接删了 worktree** → 几个小时的产出永久丢失（无 reflog 可救）。
 * 2. **提交了，但 commit 没进任何分支**（agent 在自己的 worktree 分支上 commit，主控没 merge/cherry-pick）
 *    → 主控以为「这个单元没产出」，实际代码躺在 .sid-code/worktrees 下没人管。
 *
 * 「agent 跑完 ≠ 交付完成」。所以把它做成一个可以随时、重复运行的审计：列每个 worktree 的
 * commits / dirty 两个数字与一个 verdict，并给出对应的补救命令。
 *
 * ## 判据
 *
 * - worktree 根 = `<repo>/.sid-code/worktrees`（与 `packages/core/src/worktree/manager.ts` 同一常量）
 * - 对每个 `wf_*` 目录：commits = `git log --oneline <base>..HEAD` 的行数；dirty = `git status --porcelain` 的行数
 * - verdict：commits > 0 → committed；否则 dirty > 0 → uncommitted；都为 0 → empty；任一命令失败 → unknown
 *   （顺序有意义：既提交又有未提交改动时，**未提交那部分更危险**，所以报 committed 的同时
 *   必须在修复提示里点出「还有 dirty 行数」。但**只提示不够**——这点在 2026-11-22 修掉了：
 *   当时 `--export-dir` 只导出 verdict=uncommitted 的单元，committed-but-dirty 的单元既不进
 *   导出列表、提示里也没有导出命令，主控 merge 完那 N 个提交就删 worktree，剩余改动永久丢失。
 *   现在导出的判据是 **dirty > 0**（与 verdict 解耦），committed-but-dirty 的单元也会被导出。）
 * - 路径与名字都可能是真 git worktree，也可能只是普通目录：普通目录上 git 命令失败 → null → unknown，
 *   不会因为「读不到」而被误判成 empty。
 *
 * ## 只读，除了 --export-dir
 *
 * 默认不写任何东西（连 `.sid-code/worktrees` 都不碰）。`--export-dir` 是显式的救援动作，
 * 给**所有 dirty > 0 的** worktree（uncommitted，以及 committed-but-dirty 那种）执行
 * `git add -A` 再 `git diff --binary HEAD` 落成 patch：
 * **先 add -A 才能让 untracked 进 patch** —— 2026-11-19 踩过的坑，只 diff 工作区会漏掉新建文件。
 *
 * ## 退出码
 *
 * 0 = 全部 committed，或没有 wf_* 目录（没东西可审不算失败）；
 * 1 = 存在 uncommitted / unknown（需要人处理）；2 = 参数错误。
 *
 * ## 用法
 *
 *   bun run scripts/workflow-delivery-audit.ts
 *   bun run scripts/workflow-delivery-audit.ts --base origin/main --repo <path>
 *   bun run scripts/workflow-delivery-audit.ts --export-dir /tmp/patches
 *   bun run scripts/workflow-delivery-audit.ts --help
 */
import { existsSync, mkdirSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";

/** 单个 worktree 的审计结论 */
export type Verdict = "committed" | "uncommitted" | "empty" | "unknown";

export interface WorktreeAudit {
  /** worktree 目录名，如 `wf_a`（输出里的 unit 列） */
  unit: string;
  path: string;
  /** `<base>..HEAD` 的提交数；命令失败为 null */
  commits: number | null;
  /** `git status --porcelain` 的行数；命令失败为 null */
  dirty: number | null;
  verdict: Verdict;
  /** `git log --oneline <base>..HEAD` 的原始行（未知时为空数组） */
  log: string[];
  /** 取不到状态时的 git 报错首行，便于人排查是「不是 git 目录」还是「base 不存在」 */
  error?: string;
}

interface GitResult {
  ok: boolean;
  out: string;
  err: string;
}

function git(cwd: string, args: string[]): GitResult {
  const r = Bun.spawnSync(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  return { ok: r.exitCode === 0, out: r.stdout.toString(), err: r.stderr.toString() };
}

/** 行数：空输出算 0，非空按换行切（末尾换行不产生空行） */
function countLines(out: string): number {
  return out.split("\n").filter((l) => l.length > 0).length;
}

/** worktree 根：`<repo>/.sid-code/worktrees`，与 WorktreeManager 的常量一致 */
export function worktreesDir(repoRoot: string): string {
  return join(repoRoot, ".sid-code", "worktrees");
}

/**
 * 审计一个 worktree 目录。纯读：只跑 git 查询，不写任何文件。
 *
 * 「基底无法解析」也算 unknown —— 与 `scripts/change-scope.ts` 同一哲学：base 猜错会让
 * diff 范围静默变错，此时报 0 个提交比报到错的范围更害人。
 */
export function auditWorktree(wtPath: string, base: string): WorktreeAudit {
  const unit = wtPath.replace(/\/+$/, "").split("/").pop() ?? wtPath;
  const range = `${base}..HEAD`;
  const committed = git(wtPath, ["log", "--oneline", range]);
  const status = git(wtPath, ["status", "--porcelain"]);

  if (!committed.ok || !status.ok) {
    const bad = !committed.ok ? committed : status;
    const error = bad.err.trim().split("\n")[0] ?? "";
    return { unit, path: wtPath, commits: null, dirty: null, verdict: "unknown", log: [], error };
  }

  const log = committed.out.split("\n").filter((l) => l.length > 0);
  const commits = log.length;
  const dirty = countLines(status.out);
  const verdict: Verdict = commits > 0 ? "committed" : dirty > 0 ? "uncommitted" : "empty";
  return { unit, path: wtPath, commits, dirty, verdict, log };
}

/** 扫 `<repo>/.sid-code/worktrees` 下的 wf_* 目录（按名字排序，保证输出稳定）。目录不存在返回 null。 */
export function listWorktrees(repoRoot: string): string[] | null {
  const dir = worktreesDir(repoRoot);
  if (!existsSync(dir) || !statSync(dir).isDirectory()) return null;
  return readdirSync(dir)
    .filter((n) => n.startsWith("wf_"))
    .sort()
    .map((n) => join(dir, n))
    .filter((p) => {
      try {
        return statSync(p).isDirectory();
      } catch {
        return false;
      }
    });
}

/**
 * 把一个 worktree 的工作区（含 untracked）导出成 patch，返回字节数。
 *
 * 先 `git add -A`：untracked 文件不进 `git diff`，只 diff 工作区会静默漏掉新建文件
 * （2026-11-19 实际踩过，导出成功、patch 却少了整个新文件）。
 */
export function exportPatch(wtPath: string, outFile: string): number {
  const add = git(wtPath, ["add", "-A"]);
  if (!add.ok) throw new Error(`git add -A 失败（${wtPath}）：${add.err.trim()}`);
  const diff = Bun.spawnSync(["git", "-C", wtPath, "diff", "--binary", "HEAD"], {
    stdout: "pipe",
    stderr: "pipe",
  });
  if (diff.exitCode !== 0) {
    throw new Error(`git diff 失败（${wtPath}）：${diff.stderr.toString().trim()}`);
  }
  mkdirSync(join(outFile, ".."), { recursive: true });
  const buf = Buffer.from(diff.stdout);
  writeFileSync(outFile, buf);
  return buf.byteLength;
}

/** 表 + 修复提示的文本渲染。纯函数，便于断言文案。 */
export function renderReport(
  audits: WorktreeAudit[],
  opts: { worktreesDir: string | null },
): string {
  if (audits.length === 0) {
    return opts.worktreesDir
      ? `没有 wf_* worktree：${opts.worktreesDir} 下没有需要审计的单元`
      : "没有 wf_* worktree：.sid-code/worktrees 不存在，无需审计";
  }

  const rows: Array<[string, string, string, string, string]> = audits.map((a) => [
    a.unit,
    a.verdict,
    a.commits === null ? "?" : String(a.commits),
    a.dirty === null ? "?" : String(a.dirty),
    a.path,
  ]);
  const header: [string, string, string, string, string] = [
    "unit",
    "verdict",
    "commits",
    "dirty",
    "path",
  ];
  const widths = header.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i]!.length)));
  const fmt = (r: string[]) =>
    r
      .map((c, i) => c.padEnd(widths[i]!))
      .join("  ")
      .trimEnd();

  const lines = [fmt(header), ...rows.map(fmt), ""];

  const uncommitted = audits.filter((a) => a.verdict === "uncommitted");
  const committed = audits.filter((a) => a.verdict === "committed");
  const unknown = audits.filter((a) => a.verdict === "unknown");
  const empty = audits.filter((a) => a.verdict === "empty");

  if (uncommitted.length > 0) {
    lines.push("未提交改动（先导出再清理 worktree，否则改动会永久丢失）：");
    for (const a of uncommitted) {
      lines.push(`  · ${a.unit}：`);
      lines.push(`      git -C ${a.path} add -A`);
      lines.push(`      git -C ${a.path} diff --binary HEAD > /tmp/${a.unit}.patch`);
      lines.push(`      # 然后在主仓 git apply /tmp/${a.unit}.patch 后重新 commit`);
    }
  }
  if (committed.length > 0) {
    lines.push("已提交但不在 base 上（确认是否已合入）：");
    for (const a of committed) {
      const dirtyNote =
        a.dirty && a.dirty > 0 ? `（另有 ${a.dirty} 处未提交改动，**先导出再清理**）` : "";
      lines.push(`  · ${a.unit}：${a.commits} 个提交${dirtyNote}`);
      lines.push(`      git -C ${a.path} format-patch --stdout <base>..HEAD | git am`);
      lines.push(`      # 或逐个 cherry-pick：git -C ${a.path} log --oneline <base>..HEAD`);
      for (const l of a.log) lines.push(`        ${l}`);
      // 只提示「还有 dirty 行数」不够：主控 merge 完提交就删 worktree 时，这部分改动会永久
      // 丢失，而 format-patch 只含已提交内容。所以这里必须把导出 dirty 的命令也写出来
      // （手敲等价于 --export-dir 对该单元做的事）。
      if (a.dirty && a.dirty > 0) {
        lines.push(`      # 未提交的那 ${a.dirty} 处改动**不在上面的 patch 里**，单独导出：`);
        lines.push(`      git -C ${a.path} add -A`);
        lines.push(`      git -C ${a.path} diff --binary HEAD > /tmp/${a.unit}.dirty.patch`);
      }
    }
  }
  if (unknown.length > 0) {
    lines.push("状态未知（git 命令失败，可能是普通目录 / 不是 git 仓 / base 不存在）：");
    for (const a of unknown) lines.push(`  · ${a.unit}（${a.path}）：${a.error || "git 命令失败"}`);
  }
  if (empty.length > 0) {
    lines.push("没有产出（0 提交、0 未提交改动）：");
    for (const a of empty) lines.push(`  · ${a.unit}：该单元没有产出，需要人工检查 agent 报告`);
  }
  return lines.join("\n").trimEnd();
}

export const HELP = `批量交付审计（B2）

判据：<repo>/.sid-code/worktrees 下每个 wf_* 目录
  commits = git log --oneline <base>..HEAD 的行数
  dirty   = git status --porcelain 的行数
  verdict = commits>0 → committed；否则 dirty>0 → uncommitted；都为 0 → empty；任一命令失败 → unknown

用法：
  bun run scripts/workflow-delivery-audit.ts [--base <sha>] [--repo <path>] [--export-dir <dir>] [--help]

   --base <sha>        比对基准，默认 origin/main
   --repo <path>       仓库根，默认 git rev-parse --show-toplevel（以 cwd 为准）
   --export-dir <dir>  给所有 dirty>0 的 worktree 导出 patch（含 verdict=committed 但仍有
                       未提交改动的单元——format-patch 只含已提交内容，这部分不导出就会丢）。
                       会执行 git add -A，因为 untracked 不进 git diff，只 diff 工作区会漏掉新建文件

退出码：0 = 全部 committed 或没有 wf_*；1 = 存在 uncommitted / unknown；2 = 参数错误。
`;

if (import.meta.main) {
  let parsed: { base?: string; repo?: string; "export-dir"?: string; help?: boolean };
  try {
    parsed = parseArgs({
      args: process.argv.slice(2),
      options: {
        base: { type: "string", default: "origin/main" },
        repo: { type: "string" },
        "export-dir": { type: "string" },
        help: { type: "boolean", default: false },
      },
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

  let repoRoot = parsed.repo ? resolve(parsed.repo) : null;
  if (!repoRoot) {
    const top = git(process.cwd(), ["rev-parse", "--show-toplevel"]);
    if (!top.ok || !top.out.trim()) {
      console.error("参数错误：当前目录不在 git 仓库内，且没有传 --repo");
      process.exit(2);
    }
    repoRoot = top.out.trim();
  }
  const base = parsed.base!;
  const dir = worktreesDir(repoRoot);
  const wts = listWorktrees(repoRoot);

  if (wts === null) {
    console.log(`没有 wf_* worktree：${dir} 不存在，无需审计`);
    process.exit(0);
  }

  const audits = wts.map((p) => auditWorktree(p, base));
  console.log(renderReport(audits, { worktreesDir: dir }));

  if (parsed["export-dir"]) {
    const outDir = resolve(parsed["export-dir"]);
    mkdirSync(outDir, { recursive: true });
    console.log("");
    // 判据是 **dirty > 0**，不是 verdict === "uncommitted"：committed-but-dirty 的单元
    // 同样有未提交改动，而它们连 `format-patch` 都带不走（那命令只含已提交内容）。
    // 2026-11-22 之前这里只导 uncommitted，主控 merge 完提交就删 worktree，剩余改动丢失。
    for (const a of audits.filter((x) => x.dirty !== null && x.dirty > 0)) {
      const file = join(outDir, `${a.unit}.patch`);
      try {
        const bytes = exportPatch(a.path, file);
        console.log(`已对 ${a.unit} 执行 git add -A`);
        if (a.commits !== null && a.commits > 0) {
          // 说清楚 patch 里**没有**那 N 个提交，否则主控会以为导出的就是全部产出。
          console.log(
            `  导出 ${file}（${bytes} 字节，仅含 ${a.dirty} 处未提交改动；${a.commits} 个提交需另行 merge/cherry-pick）`,
          );
        } else {
          console.log(`  导出 ${file}（${bytes} 字节）`);
        }
      } catch (e) {
        console.error(`✗ ${a.unit} 导出失败：${e instanceof Error ? e.message : String(e)}`);
      }
    }
  }

  // 退出码判据同样是「有没有未提交改动」，与 verdict 解耦：
  // committed-but-dirty 的单元若退 0，脚本化调用（`if ! bun run audit; then`）会整条漏掉它。
  const bad = audits.some((a) => (a.dirty !== null && a.dirty > 0) || a.verdict === "unknown");
  process.exit(bad ? 1 : 0);
}
