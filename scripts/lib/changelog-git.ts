/**
 * 「某个版本号对应哪个提交区间」的**唯一实现**。
 *
 * 为什么必须共享而不是各写一份：curate 脚本要把区间里的提交清单喂给 agent，
 * 生成器要用同一个区间渲染 CHANGELOG.md，校验器要用同一个区间做覆盖率核对。
 * 三处各算一遍的话，分叉的症状是「curate 看到的提交和 changelog 里的提交不是同一批」——
 * 而这完全静默：两边各自看起来都很正常。
 *
 * ⚠ 这里的区间算法有一个**实测踩过的坑**，见 versionRange() 的注释（情形 A / B）。
 */
import { execFileSync } from "node:child_process";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

/**
 * genesis 块（最老 tag 之前的全部历史）只回溯这么多条提交。
 *
 * ⚠ 这个截断机制**必须保留**：CHANGELOG.md 要列出全量原始提交，没有它就是上千条灌爆。
 * curated 改造移除的只是**站点数据源里的 isGenesis 字段**，不是这里的算法。
 */
export const GENESIS_LOOKBACK = 60;

// git log 字段/记录分隔符：避开 subject/body 内的 :/—/• 等字符
export const FS = "\x1f";
export const RS = "\x1e";

export function git(args: string[]): string {
  return execFileSync("git", args, { cwd: ROOT, encoding: "utf-8" }).trim();
}

/** 所有 semver tag（vX.Y.Z），按版本号降序；排除 phase-1-done 等非 semver tag */
export function listSemverTags(): string[] {
  let out = "";
  try {
    out = git(["tag", "-l", "v*", "--sort=-v:refname"]);
  } catch {
    return [];
  }
  const semver = /^v\d+\.\d+\.\d+$/;
  return out
    .split("\n")
    .map((l) => l.trim())
    .filter((t) => semver.test(t));
}

export function today(): string {
  // release.sh 在真实时钟下调用；此脚本非 workflow 沙箱，Date 可用
  return new Date().toISOString().slice(0, 10);
}

/** tag 指向提交的日期（YYYY-MM-DD）；取不到则返回 today */
export function tagDate(tag: string): string {
  try {
    return git(["log", "-1", "--format=%ai", tag]).slice(0, 10);
  } catch {
    return today();
  }
}

export interface VersionRange {
  /** git log 的 range 参数；null = 全部历史（仓库还没有任何 tag 时） */
  range: string | null;
  /** 该版本的日期（tag 存在则取 tag 提交日，否则 today） */
  date: string;
  /** 是否是 genesis 块（最老的那个版本，区间被 GENESIS_LOOKBACK 截断） */
  isGenesis: boolean;
  /** 该版本的 tag（尚未打 tag 时为 null） */
  tag: string | null;
}

/**
 * 算出某个版本号的提交区间。
 *
 * 两种情形，必须分开算（合并处理会丢提交，实测踩过）：
 *
 * A. 正常发布：release.sh 在 bump 之后、打 tag **之前**调用，此刻 version
 *    还没有对应 tag → 区间 = 最新 tag..HEAD。
 *
 * B. version 的 tag **已存在**：事后补跑（`generate-changelog.ts 0.1.600`）、
 *    backfill 历史版本、或 --no-bump 复用版本号。此时若仍用 `tags[0]..HEAD`，
 *    而 tags[0] 恰好就是 version 那个 tag，算出来的是「tag 之后新加的提交」——
 *    真正属于该版本的提交全被漏掉。
 *
 *    实测：v0.1.600 打完 tag 后补跑一次，changelog 从 276 条掉到 267 条
 *    （该版本真实 11 条提交被换成 tag 之后的 1 条），且**没有任何报错**。
 */
export function versionRange(version: string, tags?: string[]): VersionRange {
  const all = tags ?? listSemverTags();
  const tag = all.find((t) => t.replace(/^v/, "") === version) ?? null;

  if (tag) {
    // 情形 B：区间 = 更老的那个 tag..thisTag（与历史块算法一致）
    const idx = all.indexOf(tag);
    const prevTag = all[idx + 1] ?? null;
    return {
      range: prevTag ? `${prevTag}..${tag}` : `${tag}~${GENESIS_LOOKBACK}..${tag}`,
      date: tagDate(tag),
      isGenesis: !prevTag,
      tag,
    };
  }

  // 情形 A：尚未打 tag，区间 = 最新 tag..HEAD
  const newestTag = all[0] ?? null;
  return {
    range: newestTag ? `${newestTag}..HEAD` : null,
    date: today(),
    isGenesis: !newestTag,
    tag: null,
  };
}

/**
 * 生成器刻意过滤的噪声提交（bump 记账 / Merge / eval dashboard 刷盘）。
 *
 * curate 与生成器必须用**同一份**判据：否则 curate 会把 `bump v0.1.601` 这种
 * 记账提交也喂给 agent（浪费、且可能被写成一条用户可见变更），而覆盖率核对
 * 又会因为两边的分母不同而永远对不上。
 */
export function isNoiseSubject(subject: string): boolean {
  const s = subject.trim();
  if (/^bump\s+v?\d/i.test(s)) return true;
  if (/^Merge\s/i.test(s)) return true;
  if (/^ci(?:\([^)]*\))?\s*[:：]\s*refresh dashboard/i.test(s)) return true;
  return false;
}

export interface RawCommit {
  hash: string;
  subject: string;
  body: string;
}

/**
 * 采集某区间的原始提交（已过滤噪声）。
 *
 * @param range null = 全部历史
 * @param fallbackToTagRoot genesis 的 `tag~N` 可能超出根提交范围，此时退化为「从根到 tag」
 */
export function collectRawCommits(range: string | null, fallbackRange?: string): RawCommit[] {
  const pretty = `--pretty=format:%h${FS}%s${FS}%b${RS}`;
  let raw = "";
  const run = (r: string | null): string => {
    const args = r ? ["log", r, "--no-merges", pretty] : ["log", "--no-merges", pretty];
    return execFileSync("git", args, { cwd: ROOT, encoding: "utf-8" });
  };
  try {
    raw = run(range);
  } catch (err: any) {
    if (fallbackRange !== undefined) {
      try {
        raw = run(fallbackRange);
      } catch {
        throw new Error(`git log 失败（range=${range ?? "ALL"}）: ${err?.message ?? err}`);
      }
    } else {
      // git 命令真正损坏（非法 range 等）——抛出让 release.sh 的 || warn 接住
      throw new Error(`git log 失败（range=${range ?? "ALL"}）: ${err?.message ?? err}`);
    }
  }

  const out: RawCommit[] = [];
  for (const rec of raw
    .split(RS)
    .map((r) => r.replace(/^\n+/, ""))
    .filter((r) => r.trim())) {
    const [hash = "", subject = "", body = ""] = rec.split(FS);
    const subj = subject.trim();
    if (!subj) continue;
    if (isNoiseSubject(subj)) continue;
    out.push({ hash: hash.trim(), subject: subj, body });
  }
  return out;
}
