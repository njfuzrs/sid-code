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
 * genesis 块（最老已发布版本之前的全部历史）只回溯这么多条提交。
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

/**
 * 一个已发布版本在 git 历史里的锚点：`release.sh` 自动提交的那条 `bump vX.Y.Z`。
 *
 * ⚠️ changelog **只认 bump 提交，不认 tag**（2026-10-19 改）。tag 和 Release 是
 * 「这个版本还在不在架上」，changelog 是「这个版本发生过什么」，两件事生命周期不同：
 * PR #304 撤回 v0.1.607 及更早的 tag 和 Release（旧渲染底座下架），按 tag 遍历的旧实现
 * 于是把这 26 个版本从官网 /changelog 整块删掉，生成、构建、冒烟全部是绿的。
 * bump 提交在受保护的 main 上，撤 tag、删 Release 都动不了它。
 *
 * 一个版本只取一条锚点：同号出现多次时取最新那条（log 顺序第一个）。
 */
export interface ReleaseAnchor {
  version: string;
  /** bump 提交的完整 hash */
  commit: string;
  /** bump 提交的作者日期（YYYY-MM-DD，作者本地时区，与原先取 tag 提交日的口径一致） */
  date: string;
}

const BUMP_SUBJECT_RE = /^bump v(\d+\.\d+\.\d+)$/;

function cmpSemverDesc(a: string, b: string): number {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) if (pa[i] !== pb[i]) return pb[i]! - pa[i]!;
  return 0;
}

/** HEAD 可达历史里的全部已发布版本，按版本号降序 */
export function listReleaseAnchors(): ReleaseAnchor[] {
  let out = "";
  try {
    // 不加 --first-parent：bump 提交经发布 PR 以 merge 方式进 main，落在第二父链上
    out = git([
      "log",
      "HEAD",
      "-E",
      "--grep=^bump v[0-9]+\\.[0-9]+\\.[0-9]+$",
      `--format=%H${FS}%ad${FS}%s`,
      "--date=short",
    ]);
  } catch {
    return [];
  }
  const seen = new Map<string, ReleaseAnchor>();
  for (const line of out.split("\n")) {
    const [commit = "", date = "", subject = ""] = line.split(FS);
    const m = BUMP_SUBJECT_RE.exec(subject.trim());
    if (!m || seen.has(m[1]!)) continue;
    seen.set(m[1]!, { version: m[1]!, commit: commit.trim(), date: date.trim() });
  }
  return [...seen.values()].sort((a, b) => cmpSemverDesc(a.version, b.version));
}

export function today(): string {
  // release.sh 在真实时钟下调用；此脚本非 workflow 沙箱，Date 可用。
  // 必须取**本地**日期：锚点日期按 git 的 %ad（作者本地时区）算。用 toISOString()（UTC）
  // 时，+0800 凌晨 0–8 点发版会记成前一天（v0.1.606 实测 02:32 发版踩到）。
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export interface VersionRange {
  /** git log 的 range 参数；null = 全部历史（仓库还没有任何已发布版本时） */
  range: string | null;
  /** 该版本的日期（已发布取 bump 提交日，否则 today） */
  date: string;
  /** 是否是 genesis 块（最老的那个版本，区间被 GENESIS_LOOKBACK 截断） */
  isGenesis: boolean;
  /** 该版本的锚点提交（尚未发布时为 null）；genesis 区间越过根提交时用它退化 */
  anchor: string | null;
}

/**
 * 算出某个版本号的提交区间。
 *
 * 两种情形，必须分开算（合并处理会丢提交，实测踩过）：
 *
 * A. 正常发布：release.sh 在 bump 之后、提交 bump **之前**调用，此刻 version
 *    还没有锚点 → 区间 = 最新锚点..HEAD。
 *
 * B. version 的锚点**已存在**：事后补跑（`generate-changelog.ts 0.1.600`）、
 *    backfill 历史版本、或 --no-bump 复用版本号。此时若仍用 `最新锚点..HEAD`，
 *    而最新锚点恰好就是 version 自己，算出来的是「发布之后新加的提交」——
 *    真正属于该版本的提交全被漏掉。
 *
 *    实测：v0.1.600 发布后补跑一次，changelog 从 276 条掉到 267 条
 *    （该版本真实 11 条提交被换成之后的 1 条），且**没有任何报错**。
 */
export function versionRange(version: string, anchors?: ReleaseAnchor[]): VersionRange {
  const all = anchors ?? listReleaseAnchors();
  const idx = all.findIndex((a) => a.version === version);

  if (idx >= 0) {
    // 情形 B：区间 = 更老的那个锚点..本锚点（与历史块算法一致）
    const cur = all[idx]!;
    const prev = all[idx + 1] ?? null;
    return {
      range: prev
        ? `${prev.commit}..${cur.commit}`
        : `${cur.commit}~${GENESIS_LOOKBACK}..${cur.commit}`,
      date: cur.date,
      isGenesis: !prev,
      anchor: cur.commit,
    };
  }

  // 情形 A：尚未发布，区间 = 最新锚点..HEAD
  const newest = all[0] ?? null;
  return {
    range: newest ? `${newest.commit}..HEAD` : null,
    date: today(),
    isGenesis: !newest,
    anchor: null,
  };
}

/**
 * git log 的历史遍历口径（2026-08-19 从 `--no-merges` 改成 `--first-parent`）。
 *
 * ⚠️ 这个常量必须被**所有** changelog 取数处共用，包括 `generate-changelog.ts` 与
 * `tests/website/changelog-integration.test.ts` 的对账断言。两边口径一旦不同，
 * 覆盖率核对就永远对不上——与下面 `isNoiseSubject` 是同一条纪律。
 *
 * 为什么必须换掉 `--no-merges`：仓库从 squash-only 改成允许 merge commit 之后
 * （为了保留 agent 的中间提交做 bisect），`--no-merges` 会同时做错两件事：
 *   ① **排除掉 merge commit** → PR 标题（唯一那条人写给人看的摘要）从 CHANGELOG 里消失
 *   ② **放出所有中间提交** → `wip: 第 3 步` 这类过程记录涌进用户可见的 changelog
 * 实测（临时仓库，1 个 PR / 3 个 wip 提交）：`--no-merges` 出 3 条 wip 且无 PR 标题；
 * `--first-parent` 恰好 1 条 = PR 标题，且 `%b` 带上 PR 正文的 bullet。
 *
 * `--first-parent` 只沿主线走，所以行为与旧的 squash 流程**完全一致**——
 * 实测 v0.1.599..v0.1.600 两种口径都是 11 条，改动向前兼容。
 *
 * ⚠️ 它是**机制**而不是约定：靠「过滤 `wip:` 前缀」需要 agent 的 commit message 自觉，
 * 而 `--first-parent` 根本不看那些提交。
 */
export const HISTORY_WALK_FLAG = "--first-parent";

/**
 * 生成器刻意过滤的噪声提交（bump 记账 / Merge / eval dashboard 刷盘）。
 *
 * curate 与生成器必须用**同一份**判据：否则 curate 会把 `bump v0.1.601` 这种
 * 记账提交也喂给 agent（浪费、且可能被写成一条用户可见变更），而覆盖率核对
 * 又会因为两边的分母不同而永远对不上。
 *
 * ⚠️ `^Merge\s` 这条在改用 `--first-parent` 之后仍然要留：仓库设置把
 * `merge_commit_title` 定为 `PR_TITLE`，所以 GitHub 建的 merge commit 标题是合规的
 * Conventional Commits；但**人手工 `git merge` 造的** merge commit 标题仍是
 * `Merge branch 'x'`（历史上有一个：`9eac8c46`），它必须被过滤掉。
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
 * 每条提交在预抓 stat 里最多列出多少个文件，超出折叠成一行「…及其他 N 个文件」。
 *
 * 为什么要截断而不是给完整 stat：本仓有单个提交动 1777 个文件的历史
 * （`8ae3472e` 分包那次）。v0.1.600..HEAD 这 131 条提交的完整 stat 是 **307KB**
 * （≈77k token），其中绝大部分被那几条大重构占掉；截到 12 个文件是 **97KB**。
 *
 * 为什么是 12 而不是更小：curate 的判据是「这次改动对用户有什么影响」，
 * 而**改了哪些模块**是唯一能从 stat 层面看出这件事的信号（提示词第 3 条要求
 * 反向警惕「看着像内部改动的其实影响用户」，只给汇总行就退化成只能看 commit 标题了）。
 * 12 个文件足够看出改动落在哪几个子系统；再多就只是同一模块里的更多文件。
 */
export const STAT_TOP_FILES = 12;

/**
 * 预抓某条提交的 diff stat，**截断到 STAT_TOP_FILES 个文件**。
 *
 * ── 为什么要有这个函数（这是 curate 成本的主要杠杆）──
 *   提示词原本要求 agent「对每条打算保留的提交先跑 `git show --stat`」。
 *   131 条提交 = 主循环里 131+ 轮 bash 往返，而每轮都要重发完整对话历史，
 *   token 成本是 **O(n²)**，且 `MAX_TURNS` 会先被耗尽（40 轮根本不够 131 条）。
 *   由脚本一次性抓好塞进提示词，同样的信息量只付一次 input 成本。
 *
 * `--stat=200` 而非默认宽度：默认按终端宽度截断路径，长路径会被中间省略成
 * `packages/core/src/.../foo.ts`，恰好把「改了哪个子系统」这个唯一有用的信号删掉。
 */
export function commitStatBlock(hash: string, subject: string): string {
  let raw = "";
  try {
    raw = execFileSync("git", ["show", "--stat=200", "--format=", hash], {
      cwd: ROOT,
      encoding: "utf-8",
      // 单条提交的 stat 上限 4MB：1777 文件那条实测约 130KB，留足余量。
      // 不设上限时 execFileSync 默认 1MB，超了会抛 ENOBUFS 而不是截断。
      maxBuffer: 4 * 1024 * 1024,
    });
  } catch (err: any) {
    // 单条抓不到不该让整个 curate 失败：把失败如实写进块里，
    // agent 看到「stat 不可用」会退回读 commit 标题，而不是拿到一个静默的空块。
    return `== ${hash} ${subject}\n   （stat 读取失败：${err?.message ?? err}）`;
  }

  const lines = raw
    .split("\n")
    .map((l) => l.trimEnd())
    .filter((l) => l.trim());
  // 最后一行是 `N files changed, ...` 汇总行；merge commit 的 stat 可能整块为空
  const summary = lines.length > 0 ? lines[lines.length - 1]! : "（无文件变更）";
  const files = lines.slice(0, -1);
  const shown = files.slice(0, STAT_TOP_FILES);
  const rest = files.length - shown.length;

  return [`== ${hash} ${subject}`, ...shown, rest > 0 ? `   …及其他 ${rest} 个文件` : "", summary]
    .filter(Boolean)
    .join("\n");
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
    const args = r ? ["log", r, HISTORY_WALK_FLAG, pretty] : ["log", HISTORY_WALK_FLAG, pretty];
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
