#!/usr/bin/env bun
/**
 * G2/G4 每周变异复跑（质量防线分层专项总纲 §3.7 第 3 条，后续规划 PR-9）。
 *
 * 做三件事：
 *   1. 在**专用 worktree** 里把代码对齐到 `origin/main`（detached），`bun install`；
 *   2. 在那里跑 `scripts/smoke/mutate.ts --json`：全部用例，含 G4 与「仅本机」用例（A4-loop-tui）；
 *   3. 把结果写成 markdown 报告（`<报告目录>/<日期>.md` + `latest.md`），可选发到 tracking issue。
 *
 * 为什么要专用 worktree，而不是在当前 checkout 里跑：mutate.ts 会**临时改写源码**。主仓 checkout
 * 随时有别的会话在改（CLAUDE.md「⛔ 铁律」），而且被改文件只要有未提交改动它就会 abort。
 * 专用 worktree 只归本脚本，每次 `checkout --detach origin/main`，不会碰到任何人的在途工作。
 *
 * 为什么是本机而不是 CI：A4-loop-tui 这类用例单例 30–96s，CI 不守（后续规划 §6 裁决 2）；
 * 台账判据「最近一次 killed、距今 ≤ 30 天」也没限定在 CI 上跑。每周一次，30 天窗口里至少跑 4 次。
 *
 * 退出码：全部 killed 为 0；有 survived / stale / abort 为 1；脚本自身准备失败（fetch、install）为 2。
 *
 * 用法：
 *   bun run scripts/smoke/weekly.ts                    # 跑一次，报告写到缺省目录
 *   bun run scripts/smoke/weekly.ts --post-issue 618   # 另把报告作为评论发到 issue（要求 gh 已登录）
 *   bun run scripts/smoke/weekly.ts --print-plist      # 打印 launchd 配置（每周一 10:00），不安装
 *
 * 缺省目录（都可用环境变量覆盖）：
 *   worktree：`~/.sid-smoke/worktree`（`SID_SMOKE_WORKTREE`）——路径里不许含 `.claude` / `compact`，
 *             否则权限类与 hook 类测试会误报（见 CLAUDE.md 记忆的两个坑）；
 *   报告：    `~/.sid-smoke/reports`（`SID_SMOKE_REPORT_DIR`）；
 *   ref：     `origin/main`（`SID_SMOKE_REF`）。改了运行器或 mutate.ts 的分支，合入前想端到端验证时
 *             指向本地 commit（worktree 共享对象库，未推送的 commit 也能 checkout）。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import type { MutationRow } from "./mutate.ts";

const REPO_ROOT = resolve(import.meta.dir, "../..");

export interface WeeklyMeta {
  date: string;
  commit: string;
  durationMs: number;
  /** mutate.ts 因用例基线不绿或文件脏而中止时，中止在哪个用例 */
  aborted: string | null;
}

export interface WeeklyVerdict {
  killed: number;
  bad: MutationRow[];
  skipped: MutationRow[];
  ok: boolean;
}

export function judgeWeekly(rows: readonly MutationRow[], aborted: string | null): WeeklyVerdict {
  const killed = rows.filter((r) => r.outcome === "killed").length;
  const bad = rows.filter((r) => r.outcome === "survived" || r.outcome === "stale");
  const skipped = rows.filter((r) => r.outcome === "skipped");
  // 一条都没跑也不算通过：那说明用例或配方被整体弄丢了，恒绿比红更危险
  return { killed, bad, skipped, ok: aborted === null && bad.length === 0 && killed > 0 };
}

const cell = (s: string) => s.replace(/\|/g, "\\|").replace(/\n/g, " ").slice(0, 160);

export function renderWeeklyReport(rows: readonly MutationRow[], meta: WeeklyMeta): string {
  const v = judgeWeekly(rows, meta.aborted);
  const head = v.ok ? "✅ 全部 killed" : "❌ 有问题，需要处置";
  const lines = [
    `### G2/G4 每周变异复跑 ${meta.date}：${head}`,
    "",
    `- commit：\`${meta.commit}\``,
    `- 结果：${v.killed} killed，${v.bad.length} 未杀死或已陈旧，${v.skipped.length} 个用例跳过；耗时 ${(meta.durationMs / 60_000).toFixed(1)} min`,
  ];
  if (meta.aborted) {
    lines.push(
      `- **中止于 \`${meta.aborted}\`**：该用例未变异时就不通过（或被改文件不干净），后面的用例没跑。先修它`,
    );
  }
  if (v.killed === 0 && !meta.aborted) lines.push("- **一条变异都没跑**：用例或配方整体丢了");
  if (v.bad.length > 0) {
    lines.push("", "| 用例 | 结果 | 文件 | 变异 | 说明 |", "| --- | --- | --- | --- | --- |");
    for (const r of v.bad)
      lines.push(`| ${r.id} | ${r.outcome} | \`${r.file}\` | ${cell(r.why)} | ${cell(r.detail)} |`);
    lines.push(
      "",
      "`survived` = 改坏了用例还是绿，门禁已空心；`stale` = 配方的 `find` 随源码漂移，要更新配方。台账里对应行不再算「已变异自证」，处置后重跑。",
    );
  }
  if (v.skipped.length > 0) {
    lines.push("", "跳过：");
    for (const r of v.skipped) lines.push(`- ${r.id}：${cell(r.detail)}`);
  }
  // 按用例汇总 killed 数，台账回写「最近一次 killed」时直接抄
  const perCase = new Map<string, number>();
  for (const r of rows) if (r.outcome === "killed") perCase.set(r.id, (perCase.get(r.id) ?? 0) + 1);
  if (perCase.size > 0) {
    lines.push("", "<details><summary>各用例 killed 数</summary>", "");
    for (const [id, n] of [...perCase].sort()) lines.push(`- ${id}：${n}`);
    lines.push("", "</details>");
  }
  lines.push("");
  return lines.join("\n");
}

/** launchd 配置：每周一 10:00 跑一次。只打印，安装由人决定（会在本机常驻） */
export function renderPlist(bun: string, script: string, logDir: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>dev.sid-code.smoke-weekly</string>
  <key>ProgramArguments</key>
  <array><string>${bun}</string><string>run</string><string>${script}</string></array>
  <key>StartCalendarInterval</key>
  <dict><key>Weekday</key><integer>1</integer><key>Hour</key><integer>10</integer><key>Minute</key><integer>0</integer></dict>
  <key>StandardOutPath</key><string>${join(logDir, "launchd.out.log")}</string>
  <key>StandardErrorPath</key><string>${join(logDir, "launchd.err.log")}</string>
</dict>
</plist>
`;
}

function sh(args: string[], cwd: string): { ok: boolean; out: string; err: string } {
  const r = Bun.spawnSync(args, { cwd, stdout: "pipe", stderr: "pipe" });
  return { ok: r.exitCode === 0, out: r.stdout.toString(), err: r.stderr.toString() };
}

function fail(msg: string): never {
  console.error(`smoke-weekly: ${msg}`);
  process.exit(2);
}

if (import.meta.main) {
  const { values } = parseArgs({
    args: Bun.argv.slice(2),
    options: {
      "post-issue": { type: "string" },
      "print-plist": { type: "boolean", default: false },
    },
  });
  const base = join(homedir(), ".sid-smoke");
  const wt = process.env.SID_SMOKE_WORKTREE ?? join(base, "worktree");
  const reportDir = process.env.SID_SMOKE_REPORT_DIR ?? join(base, "reports");
  const ref = process.env.SID_SMOKE_REF || "origin/main";

  if (values["print-plist"]) {
    console.log(
      renderPlist(process.execPath, join(REPO_ROOT, "scripts/smoke/weekly.ts"), reportDir),
    );
    process.exit(0);
  }
  if (/\.claude|compact/i.test(wt))
    fail(`worktree 路径 ${wt} 含 .claude 或 compact，会让测试误报，换一个`);

  const started = Date.now();
  if (!sh(["git", "fetch", "-q", "origin", "main"], REPO_ROOT).ok)
    fail("git fetch origin main 失败");
  if (!existsSync(join(wt, ".git"))) {
    mkdirSync(base, { recursive: true });
    const add = sh(["git", "worktree", "add", "--detach", wt, ref], REPO_ROOT);
    if (!add.ok) fail(`建 worktree 失败：${add.err.trim()}`);
  } else {
    // 专用 worktree 只归本脚本；上次被杀可能留下没还原的变异，--force 丢掉它们正是想要的
    const co = sh(["git", "checkout", "-q", "--force", "--detach", ref], wt);
    if (!co.ok) fail(`worktree 对齐 ${ref} 失败：${co.err.trim()}`);
  }
  const commit = sh(["git", "rev-parse", "--short=8", "HEAD"], wt).out.trim();
  if (!sh(["bun", "install", "--frozen-lockfile"], wt).ok) fail("worktree 里 bun install 失败");

  mkdirSync(reportDir, { recursive: true });
  const date = new Date().toISOString().slice(0, 10);
  const jsonPath = join(reportDir, `${date}.json`);
  const proc = Bun.spawnSync(["bun", "run", "scripts/smoke/mutate.ts", "--json", jsonPath], {
    cwd: wt,
    stdout: "inherit",
    stderr: "inherit",
    // CI 变量不能带进来：带了，仅本机用例（A4-loop-tui）会被判 skip，保鲜静默失效
    env: { ...process.env, CI: "" },
  });
  if (!existsSync(jsonPath)) fail(`mutate.ts 没写出结果（exit=${proc.exitCode}）`);
  const result = JSON.parse(readFileSync(jsonPath, "utf8")) as {
    aborted: string | null;
    rows: MutationRow[];
  };
  const md = renderWeeklyReport(result.rows, {
    date,
    commit: ref === "origin/main" || ref.startsWith(commit) ? commit : `${commit}（${ref}）`,
    durationMs: Date.now() - started,
    aborted: result.aborted,
  });
  writeFileSync(join(reportDir, `${date}.md`), md);
  writeFileSync(join(reportDir, "latest.md"), md);
  console.log(`\n${md}\n报告：${join(reportDir, `${date}.md`)}`);

  if (values["post-issue"]) {
    const post = sh(
      [
        "gh",
        "issue",
        "comment",
        values["post-issue"],
        "--body-file",
        join(reportDir, `${date}.md`),
      ],
      REPO_ROOT,
    );
    if (!post.ok)
      console.error(`smoke-weekly: 发到 issue #${values["post-issue"]} 失败：${post.err.trim()}`);
  }
  process.exit(judgeWeekly(result.rows, result.aborted).ok ? 0 : 1);
}
