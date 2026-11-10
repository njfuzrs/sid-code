#!/usr/bin/env bun
/**
 * Agent Note 缺失提醒（质量防线分层专项总纲 §3.6，M6 左移）：**只报告，永不阻断**。
 *
 * 判据：PR diff 触及 `packages/core/src/{query,tool,permission,hook,llm,context}/` 下的源码，
 * 而同一 diff 里没有任何 `.agents/notes/` 改动 → 打一条 `::warning::` 注解，并写进 step summary。
 *
 * 为什么只报告：「非平凡」需要语义判断。做成阻断会逼人写空 Note 过闸，等于奖励重贴标签；
 * 而这六个目录是主循环、工具、权限、hook、模型调用、上下文——改了几乎总在改行为，
 * 提醒的误报率可以接受。只改这六处的拼写或注释时，忽略这条提醒即可。
 *
 * 为什么不在 PR 上发评论（总纲原写法）：ci.yml 顶层权限刻意只读（见文件头注释），
 * 发评论要给这个 job 加 `pull-requests: write`；fork PR 的 GITHUB_TOKEN 无论怎么声明都是只读，
 * 评论在外部贡献者的 PR 上一定发不出去。注解出现在 PR 的 checks 页和 Files changed 页，
 * 不需要任何写权限。
 *
 * 退出码恒为 0：脚本自己出错（取不到 diff）也只打 warning。提醒不能变成一道会红的门禁。
 *
 * 用法：
 *   bun run scripts/note-reminder.ts                           # 本地：merge-base(origin/main, HEAD)..HEAD
 *   bun run scripts/note-reminder.ts --base HEAD^1 --head HEAD # CI：PR 的合并提交
 */
import { appendFileSync } from "node:fs";
import { parseArgs } from "node:util";

/** 改了就提醒的源码目录。与总纲 §3.6 同一份清单，改这里要同步改总纲 */
export const WATCHED_DIRS = [
  "packages/core/src/query/",
  "packages/core/src/tool/",
  "packages/core/src/permission/",
  "packages/core/src/hook/",
  "packages/core/src/llm/",
  "packages/core/src/context/",
] as const;

export const NOTES_PREFIX = ".agents/notes/";

export interface Reminder {
  /** 触及的受关注源码文件 */
  watched: string[];
  /** diff 里是否有 Note 改动（README / 模板也算：动它们的 PR 本身就是在讲 Note） */
  hasNote: boolean;
  remind: boolean;
}

export function judgeReminder(files: readonly string[]): Reminder {
  const watched = files.filter((f) => WATCHED_DIRS.some((d) => f.startsWith(d)));
  const hasNote = files.some((f) => f.startsWith(NOTES_PREFIX));
  return { watched, hasNote, remind: watched.length > 0 && !hasNote };
}

export function renderReminder(r: Reminder): string {
  const shown = r.watched.slice(0, 10).map((f) => `- \`${f}\``);
  if (r.watched.length > 10) shown.push(`- …另 ${r.watched.length - 10} 个`);
  return [
    "### Agent Note 提醒（只报告，不阻断）",
    "",
    "本 PR 改了主循环 / 工具 / 权限 / hook / 模型调用 / 上下文的源码，但没有 `.agents/notes/` 改动：",
    "",
    ...shown,
    "",
    "非平凡改动（改行为、契约、结构、流程、理由）须在同一 PR 内带一份 Agent Note，见 `.agents/notes/README.md`。",
    "只是拼写、注释、提取变量这类平凡改动的话，忽略本提醒即可。",
    "",
  ].join("\n");
}

function git(args: string[]): { ok: boolean; out: string } {
  const r = Bun.spawnSync(["git", ...args], { stdout: "pipe", stderr: "pipe" });
  return { ok: r.exitCode === 0, out: r.stdout.toString() };
}

if (import.meta.main) {
  const { values } = parseArgs({
    args: Bun.argv.slice(2),
    options: { base: { type: "string" }, head: { type: "string", default: "HEAD" } },
  });
  const head = values.head!;
  let base = values.base;
  if (!base) {
    const mb = git(["merge-base", "origin/main", head]);
    base = mb.ok ? mb.out.trim() : undefined;
  }
  const diff = base ? git(["diff", "--name-only", "--no-renames", base, head]) : null;
  if (!diff?.ok) {
    console.log(
      `::warning::note-reminder 取不到 diff（base=${base ?? "?"}，head=${head}），本次没有检查`,
    );
    process.exit(0);
  }
  const files = diff.out.split("\n").filter(Boolean);
  const r = judgeReminder(files);
  if (!r.remind) {
    console.log(
      r.watched.length === 0
        ? "note-reminder: 没有触及受关注目录"
        : `note-reminder: 触及 ${r.watched.length} 个受关注文件，已带 Agent Note`,
    );
    process.exit(0);
  }
  const md = renderReminder(r);
  console.log(md);
  // 注解只取一行：GitHub 把 ::warning:: 的消息当单行显示
  console.log(
    `::warning title=缺 Agent Note？::改了 ${r.watched.length} 个主循环/工具/权限/hook/llm/上下文源码文件，但 PR 里没有 .agents/notes/ 改动。非平凡改动须带 Note；平凡改动忽略即可（只报告，不阻断）`,
  );
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, md + "\n");
  process.exit(0);
}
