#!/usr/bin/env bun
/**
 * change-scope —— 报告本次改动的确切范围，供 affected-tests 选测试用。
 *
 * ## 它解决的问题
 *
 * CLAUDE.md 原先要求每次改完都跑全量 `bun test`（实测 202.87s → P0-1 修完 ~95s）。
 * 要改成「只跑相关」，第一步不是写映射表，是**先把「相关」这件事算准**。
 *
 * 四类路径必须分开报，而不是揉成一个 changed 数组：
 *
 * | 类别 | 取数 | 为什么要单列 |
 * | --- | --- | --- |
 * | committed | `diff merge-base..head` | 相对 merge-base 取，否则会把 base 上别人的提交算成你的改动 |
 * | staged | `diff --cached` | 已 add 未提交 |
 * | unstaged | `diff`（工作区 vs index） | 改了没 add |
 * | untracked | `ls-files --others --exclude-standard` | **新文件**，`diff` 一律看不到 |
 *
 * 这个仓库随时有多个 agent / 人并行开发（`git worktree list` 常有 7+ 个），
 * 所以「工作区里有一批不属于本次任务的文件」是常态而非异常。混在一起报，
 * 会让「本次改动范围」判断错——这和 CLAUDE.md 那条「不删与本次任务无关的文件」
 * 铁律同源：**先看清范围，再动手**。
 *
 * ## 两条刻意的设计选择
 *
 * 1. **base 必须能解析到，解析不了就报错退出，不静默兜底。**
 *    猜错 base 的后果不是报错，是**选测范围静默变错**——比如 base 猜成一个很旧的
 *    提交，changed 会膨胀成几百个文件（看起来「安全」但其实等于全量，选测白做）；
 *    猜成一个太新的提交，changed 会漏掉真实改动（**选了个空集然后全绿**，这是更危险的形态）。
 *    所以默认值只是 `origin/main` 这一个约定值，且必须真的存在。
 *
 * 2. **不 fetch。** 只读命令不该有网络副作用：CI 上 checkout 深度可能是 1，
 *    fetch 与否由 workflow 决定；本地则可能离线。fetch 失败时报错比静默用陈旧
 *    的 `origin/main` 更好——后者会把别人已合入的改动算进你的范围。
 *
 * ## 输出
 *
 * 单个 JSON 到 stdout（带 formatVersion，供下游判版本）。诊断信息一律走 stderr，
 * 这样 `bun run change-scope | jq` 不会被污染。
 */
import { spawnSync } from "node:child_process";

const FORMAT_VERSION = 1;

export interface ChangeScope {
  formatVersion: number;
  input: { base: string; head: string };
  resolved: { baseSha: string; headSha: string; mergeBaseSha: string };
  paths: {
    committed: string[];
    staged: string[];
    unstaged: string[];
    untracked: string[];
  };
}

/**
 * 跑 git 只读命令。
 *
 * `GIT_OPTIONAL_LOCKS=0`：只读命令默认也会尝试刷新并抢 `index.lock`，
 * 并行 agent 同时跑会互相阻塞（甚至报 "Unable to create index.lock"）。
 * `LC_ALL=C`：输出不受 locale 影响，中文环境下 git 的错误信息会变，
 * 下游若要匹配文本就会失效。
 */
function git(args: string[]): { ok: true; out: string } | { ok: false; err: string } {
  const r = spawnSync("git", args, {
    encoding: "utf8",
    env: { ...process.env, GIT_OPTIONAL_LOCKS: "0", LC_ALL: "C" },
    maxBuffer: 64 * 1024 * 1024,
  });
  if (r.error) return { ok: false, err: String(r.error.message ?? r.error) };
  if (r.status !== 0) {
    return { ok: false, err: (r.stderr ?? "").trim() || `exit ${r.status}` };
  }
  return { ok: true, out: r.stdout ?? "" };
}

/** git 只读命令，失败即抛。 */
function gitOrThrow(args: string[]): string {
  const r = git(args);
  if (!r.ok) throw new Error(`git ${args.join(" ")} 失败：${r.err}`);
  return r.out;
}

function lines(out: string): string[] {
  return out
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean);
}

export function parseArgs(argv: string[]): { base: string; head: string } {
  let base = "";
  let head = "HEAD";
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--base") base = argv[++i] ?? "";
    else if (argv[i] === "--head") head = argv[++i] ?? "HEAD";
  }
  // 唯一的默认值是本仓的约定主干。它必须真的能解析（下面 rev-parse 会验），
  // 解析不了就报错——不再往 main / master / HEAD~1 之类降级兜底。
  return { base: base || "origin/main", head };
}

/** 计算改动范围。base 解析失败会抛，调用方负责给出可操作的错误信息。 */
export function computeChangeScope(base: string, head: string): ChangeScope {
  const baseRev = git(["rev-parse", "--verify", `${base}^{commit}`]);
  if (!baseRev.ok) {
    throw new Error(
      `base "${base}" 解析不到。\n` +
        `  · 本地缺 origin/main 时先跑：git fetch origin main\n` +
        `  · CI 上 checkout 深度为 1 时请设 fetch-depth: 0\n` +
        `  · 或显式传：--base <ref>\n` +
        `刻意不降级兜底：base 猜错会让选测范围静默变错（膨胀成全量，或漏成空集）。\n` +
        `git 原始报错：${baseRev.err}`,
    );
  }
  const baseSha = baseRev.out.trim();
  const headSha = gitOrThrow(["rev-parse", "--verify", `${head}^{commit}`]).trim();

  // merge-base 可能不存在（如两个不相关的历史）。此时退回 baseSha 并在 stderr 提示，
  // 因为 `diff A B` 本身仍是有意义的，只是会把 base 独有的提交也算进来。
  const mb = git(["merge-base", baseSha, headSha]);
  let mergeBaseSha: string;
  if (mb.ok) {
    mergeBaseSha = mb.out.trim();
  } else {
    mergeBaseSha = baseSha;
    console.error(
      `[change-scope] 警告：${base} 与 ${head} 无共同祖先，committed 退回用 ${base} 直接 diff（范围可能偏大）。`,
    );
  }

  return {
    formatVersion: FORMAT_VERSION,
    input: { base, head },
    resolved: { baseSha, headSha, mergeBaseSha },
    paths: {
      // 三点语义：只要 head 侧的改动，不要 base 上别人的提交。
      committed: lines(gitOrThrow(["diff", "--name-only", mergeBaseSha, headSha])),
      staged: lines(gitOrThrow(["diff", "--cached", "--name-only"])),
      unstaged: lines(gitOrThrow(["diff", "--name-only"])),
      // untracked 单独取：新文件不在任何 diff 里，漏掉它就会漏掉「新增的测试」。
      untracked: lines(gitOrThrow(["ls-files", "--others", "--exclude-standard"])),
    },
  };
}

// 只有直接执行时才输出，被 import 时（测试/affected-tests）不产生副作用。
if (import.meta.main) {
  const { base, head } = parseArgs(process.argv.slice(2));
  try {
    console.log(JSON.stringify(computeChangeScope(base, head), null, 2));
  } catch (e) {
    console.error(`[change-scope] ${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
  }
}
