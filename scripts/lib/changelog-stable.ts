/**
 * 稳定版说明（stable notes）—— beta 泡制期「一修一号」流程的配套（T1 / T2 / T5）。
 *
 * ## 为什么需要它
 *
 * beta 期每修一次就发下一个构建号（0.1.607 → 0.1.608 → 0.1.609），验收通过后 promote
 * **最后那个号**。稳定版用户从 0.1.606 直接跳到 0.1.609 —— 如果说明只取 `v0.1.609.json`，
 * 0.1.607 / 0.1.608 的用户可见变更就「消失」了。所以 promote 时要把
 * **(当前 latest, 目标版本]** 区间内全部 curated 合并成一份，落到
 * `changelog/curated/stable/v<目标>.json`（独立文件，不改已入库 curated 的语义）。
 *
 * ## 合并规则（确定性结构操作，不调 LLM —— 发布路径禁令之一）
 *
 * - 区间是**左开右闭**：下界是上一个稳定版，它的说明用户早就看过了，带进来就是重复。
 * - `betaOnly:true` 的版本整份丢弃：它只修 beta 期自己引入的问题，稳定版用户从没见过那个 bug。
 * - 「破坏性变更」**完整保留**；受控词表顺序本来就把它放在首组（`toRenderSections`）。
 * - 同组条目按版本升序拼接、逐字去重。
 * - 区间只有一个版本（快车道：upload 后立即 promote）时**原样返回该 curated 对象** ——
 *   快车道零行为变化，调用方据此不写 stable 文件。
 *
 * ## 合并稿必须人工过目
 *
 * 与 curated 同一条禁令：校验器只拦形态，拦不住「漏了一个真实的破坏性变更」。
 * 所以 release.sh 在 promote 时打印合并稿并要求交互确认，非交互直接拒绝 promote。
 */
import {
  SECTION_META,
  type CuratedEntry,
  type CuratedSection,
} from "./changelog-curated-schema.ts";

/** 稳定版说明 = curated 形态 + 覆盖了哪些版本号（含目标自身，升序） */
export interface StableNotes extends CuratedEntry {
  covers: string[];
}

const SEMVER_RE = /^\d+\.\d+\.\d+$/;

/** x.y.z 数值比较（不依赖 core 包：scripts/ 与 packages/ 的边界由 lint:boundary 管） */
export function cmpVersion(a: string, b: string): number {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    if (pa[i] !== pb[i]) return pa[i]! < pb[i]! ? -1 : 1;
  }
  return 0;
}

/**
 * 从候选版本里取 (from, to] 区间，升序去重。
 * `from` 为 null（读不到当前 latest）时只返回 `to` 自己 —— 宁可少合并（人工确认时能看出来），
 * 也不要把整段历史都并进来。
 */
export function versionsInRange(candidates: string[], from: string | null, to: string): string[] {
  const set = new Set(candidates.filter((v) => SEMVER_RE.test(v)));
  set.add(to);
  if (from === null) return [to];
  return [...set].filter((v) => cmpVersion(v, from) > 0 && cmpVersion(v, to) <= 0).sort(cmpVersion);
}

/**
 * 合并区间内的 curated。`entries` 必须恰好对应区间内每个版本（调用方负责缺文件报错），
 * 顺序不限，这里自己按版本升序排。
 *
 * @returns 单版本区间返回**原对象本身**（不是拷贝），多版本返回新的 StableNotes。
 */
export function mergeStableNotes(
  entries: CuratedEntry[],
  target: string,
): CuratedEntry | StableNotes {
  const sorted = [...entries].sort((a, b) => cmpVersion(a.version, b.version));
  const last = sorted[sorted.length - 1];
  if (!last || last.version !== target) {
    throw new Error(`合并区间的最后一个版本必须是目标 v${target}`);
  }
  if (sorted.length === 1 && !last.betaOnly) return last;

  const kept = sorted.filter((e) => !e.betaOnly && e.userFacing);
  const byTitle = new Map<string, string[]>();
  for (const e of kept) {
    for (const sec of e.sections) {
      const items = byTitle.get(sec.title) ?? [];
      for (const it of sec.items) if (!items.includes(it)) items.push(it);
      byTitle.set(sec.title, items);
    }
  }
  const sections: CuratedSection[] = [];
  for (const meta of SECTION_META) {
    const items = byTitle.get(meta.title);
    if (items && items.length > 0) sections.push({ title: meta.title, items });
  }

  // highlight 取区间内最新的那个非空值：它最贴近用户升级后看到的状态
  const highlight =
    [...kept].reverse().find((e) => typeof e.highlight === "string")?.highlight ?? null;

  const uniq = (xs: string[]) => [...new Set(xs)];
  return {
    version: target,
    highlight,
    userFacing: sections.length > 0,
    sections,
    commits: uniq(sorted.flatMap((e) => e.commits ?? [])),
    discarded: uniq(sorted.flatMap((e) => e.discarded ?? [])),
    covers: sorted.map((e) => e.version),
    generatedBy: "changelog-stable",
    reviewedBy: "pending",
  };
}

/** 稳定版说明的一行摘要（积压清单 / 合并稿打印用） */
export function entrySummary(e: CuratedEntry | undefined): string {
  if (!e) return "（缺 curated 文案）";
  if (e.betaOnly) return `beta 修复：${e.betaNote ?? "（无说明）"}`;
  if (e.highlight) return e.highlight;
  if (!e.userFacing) return "无用户可见变更";
  const n = e.sections.reduce((k, s) => k + s.items.length, 0);
  return `${n} 项变更`;
}

/**
 * 积压清单（T5）：stable → beta 之间还没促升的 beta 号。纯函数，只读。
 */
export function describeBacklog(
  stable: string | null,
  beta: string | null,
  candidates: string[],
  lookup: (v: string) => CuratedEntry | undefined,
): string[] {
  if (!beta) return ["beta 通道没有版本"];
  if (stable && cmpVersion(beta, stable) <= 0) {
    return [`stable v${stable} 与 beta v${beta} 无积压（beta 不比 stable 新）`];
  }
  const list = versionsInRange(candidates, stable, beta);
  const out = [`stable v${stable ?? "?"} → beta v${beta}，积压 ${list.length} 个 beta 号：`];
  for (const v of list) out.push(`  · v${v}  ${entrySummary(lookup(v))}`);
  return out;
}

/**
 * 发布通道判定（T2，官网 / 数据源用）。
 *
 * - 比当前 stable 新 → beta（还在泡制期）
 * - 被某个稳定版说明 `covers` 却不是那份说明自己 → beta（被跳过的中间号，已并入 mergedInto）
 * - 其余 → stable（含历史版本：一修一号流程之前每个号都是正式版）
 *
 * `stable` 为 null（不知道当前稳定版）时只用 covers 判，不猜。
 */
export function resolveVersionChannel(
  version: string,
  stable: string | null,
  stableNotes: Array<Pick<StableNotes, "version" | "covers">>,
): { channel: "stable" | "beta"; mergedInto: string | null } {
  if (stable && cmpVersion(version, stable) > 0) return { channel: "beta", mergedInto: null };
  for (const n of stableNotes) {
    if (n.version !== version && n.covers.includes(version)) {
      return { channel: "beta", mergedInto: n.version };
    }
  }
  return { channel: "stable", mergedInto: null };
}

/**
 * betaOnly 的反向约束（T3）：已经成了稳定版、又没有任何稳定版说明覆盖它的号，不能标 betaOnly ——
 * 否则它的说明在官网 / Release 上就彻底没了（合并时被丢、自己又是正式版）。
 */
export function betaOnlyViolation(
  entry: Pick<CuratedEntry, "version" | "betaOnly">,
  stable: string | null,
  stableNotes: Array<Pick<StableNotes, "version" | "covers">>,
): string | null {
  if (!entry.betaOnly || !stable) return null;
  if (cmpVersion(entry.version, stable) > 0) return null;
  // 只认「别的稳定版说明」覆盖它：自己就是促升目标时，它的说明正是稳定版说明本身
  if (stableNotes.some((n) => n.version !== entry.version && n.covers.includes(entry.version))) {
    return null;
  }
  return (
    `v${entry.version} 标了 betaOnly，但它 ≤ 当前稳定版 v${stable} 且没有任何稳定版说明覆盖它 —— ` +
    `已经是正式版的号不能标 beta-only`
  );
}
