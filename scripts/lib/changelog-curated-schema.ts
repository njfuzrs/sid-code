/**
 * curated 更新日志文案的**共享契约**：类型 + 受控词表 + 校验器。
 *
 * 三个消费方 import 这一份，避免三套校验规则分叉：
 *   ① `scripts/changelog-curate.ts`      —— agent 落盘后当场校验，不合规就失败
 *   ② `scripts/generate-changelog.ts`    —— 读 curated 文件时校验，不合规降级为「无变更说明」
 *   ③ `tests/website/changelog-curated.test.ts` —— 单测 + 遍历已入库文件的长期防线
 *
 * ── 校验器能拦什么、拦不住什么（别抱有错误期待）──
 *   能拦：**形态**。分组名是否在词表内、长度是否合规、有没有 URL、
 *        version 是否与文件名一致、userFacing 与 sections 是否自相矛盾。
 *   拦不住：**内容对不对**。「把内部重构写成了用户特性」「漏掉了一个真实的破坏性
 *        变更」这两类错误校验器一条都拦不住，只有人能拦。这不是补测试能解决的
 *        （方案 §11.2）—— 所以 curated 文件必须**入库 + 人工过目**，
 *        校验器只是把机械错误挡在 review 之前，好让 review 的注意力用在内容上。
 */
import { hasUrl, findUrls } from "./changelog-text.ts";

/**
 * 分组受控词表。**顺序即渲染顺序。**
 *
 * 只有 4 个（旧的规则管道有 6 个：新功能/修复/重构/性能/文档/其他），理由：
 *
 * - **删掉「文档」「其他」**：实测 276 条提交里这两组占 66 条 ≈ 24%，
 *   恰好就是"用户完全不关心"的那部分。curated 阶段的规则是「不是用户可见变更
 *   就不写」，所以这两组在这一层不该存在。
 * - **「重构」「性能」合并进「改进」**：用户视角里两者没有区别，都是「同样的功能
 *   变得更好了」；区分它们是开发者的分类习惯。（一个重构若真的修掉了竞态，
 *   它属于「修复」而不是「改进」—— 判据是对用户的实际影响。）
 * - **新增「破坏性变更」**：旧的 6 组里**没有**这一类，而它恰恰是用户最需要一眼
 *   看到的。旧生成器认得 `BREAKING-CHANGE` trailer，但只是把它当噪音过滤掉了。
 *
 * 为什么是**受控词**而不是自由词：与 `blog-meta.ts` 的 SERIES 同源 ——
 * 自由词表会随版本数线性膨胀，最终每个版本一套自己的分组名，
 * 渲染层就拿不到稳定的配色与顺序了。
 */
export const SECTION_META: ReadonlyArray<{ key: string; title: string }> = [
  { key: "breaking", title: "破坏性变更" },
  { key: "feat", title: "新功能" },
  { key: "improve", title: "改进" },
  { key: "fix", title: "修复" },
];

/** 中文标题 → 渲染 key。校验器拒绝表外的 title。 */
export const TITLE_TO_KEY: Readonly<Record<string, string>> = Object.fromEntries(
  SECTION_META.map((s) => [s.title, s.key]),
);

/** 受控词表（给提示词与报错信息用，顺序与 SECTION_META 一致） */
export const SECTION_TITLES: readonly string[] = SECTION_META.map((s) => s.title);

/** 单条 item 的长度上限：防 agent 写出整段散文（用户是扫读的） */
export const MAX_ITEM_LEN = 200;
/** highlight 的长度上限：超长会把版本标题那一行的排版撑坏 */
export const MAX_HIGHLIGHT_LEN = 40;

/**
 * `commits` 覆盖率的 warn 阈值：真实区间里有超过这个比例的提交既不在 `commits` 里、
 * 也没被显式记为丢弃时，报 warn。
 *
 * ⚠ 这个数字是**拍的**，没有数据支撑（方案 §11.4 如实记录了这一点）。
 * 「漏掉一整块功能」是本方案最可能的失败模式，而它完全静默 —— 页面看起来很正常，
 * 只是少了一个功能的介绍。所以需要一道信号。
 *
 * 做成 warn 而非 error，因为「这个区间的提交确实几乎都是内部改动」是**合法情形**
 * （实测 v0.1.595 只有 2 条提交且都是 chore）。做成 error 会让合法情形无法通过。
 *
 * backfill 跑完后应回头看真实丢弃率分布再调这个值：定太低天天 warn（噪音，
 * 很快被忽略）、定太高永不 warn（等于没有）。
 */
export const COVERAGE_WARN_THRESHOLD = 0.3;

export interface CuratedSection {
  title: string;
  items: string[];
}

export interface CuratedEntry {
  version: string;
  highlight: string | null;
  userFacing: boolean;
  sections: CuratedSection[];
  /** 溯源：本版覆盖了哪些 commit。**不渲染到页面**，只用于覆盖率核对与人工回溯。 */
  commits: string[];
  /**
   * 显式记为「看过但丢弃」的 commit。有它，覆盖率检查才能区分
   * 「agent 判断这些是内部改动」与「agent 根本没看到这些提交」——
   * 后者是真正要报警的那种。可选：早期 backfill 的文件可能没有。
   */
  discarded?: string[];
  generatedBy?: string;
  reviewedBy?: string;
}

/** 渲染用的 section（带 key，key 由 title 派生，不让人工在 JSON 里手写 key） */
export interface RenderSection {
  key: string;
  title: string;
  items: string[];
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

const SEMVER_RE = /^\d+\.\d+\.\d+$/;

/**
 * 校验一个 curated 对象。返回**人类可读的错误列表**，空数组 = 通过。
 *
 * 刻意返回列表而不是 throw first error：agent 产出的文件可能同时有好几处不合规，
 * 一次全列出来才好一轮改完（也才好把这些错误回喂给 agent 重试）。
 *
 * @param expectedVersion 文件名里的版本号。传了就比对 —— 错配会让文案挂到
 *   错误的版本名下，且**没有任何报错**（页面照旧渲染，只是内容对错了版本）。
 */
export function validateCurated(obj: unknown, expectedVersion?: string): string[] {
  const errs: string[] = [];

  if (!isPlainObject(obj)) {
    return ["顶层必须是一个 JSON 对象"];
  }

  // ── version ──
  if (typeof obj.version !== "string" || !SEMVER_RE.test(obj.version)) {
    errs.push(`version 必须是 x.y.z 形态的字符串，实际是 ${JSON.stringify(obj.version)}`);
  } else if (expectedVersion && obj.version !== expectedVersion) {
    errs.push(
      `version（${obj.version}）与文件名版本号（${expectedVersion}）不一致 —— ` +
        `错配会让这份文案挂到错误的版本名下且不报错`,
    );
  }

  // ── userFacing ──
  const userFacing = obj.userFacing;
  if (typeof userFacing !== "boolean") {
    errs.push(`userFacing 必须是布尔值，实际是 ${JSON.stringify(userFacing)}`);
  }

  // ── highlight ──
  const highlight = obj.highlight;
  if (highlight !== null && typeof highlight !== "string") {
    errs.push("highlight 必须是字符串或 null（没有值得强调的就写 null，不要写「无」这种占位文字）");
  } else if (typeof highlight === "string") {
    if (highlight.trim().length === 0) {
      errs.push("highlight 不能是空字符串 —— 没有亮点就写 null");
    }
    if (highlight.length > MAX_HIGHLIGHT_LEN) {
      errs.push(
        `highlight 超长（${highlight.length} > ${MAX_HIGHLIGHT_LEN} 字）：会破坏版本标题的排版`,
      );
    }
    if (hasUrl(highlight)) {
      errs.push(`highlight 含 URL（${findUrls(highlight).join(", ")}）—— 这份文案会发布到公网`);
    }
  }

  // ── sections ──
  const sections = obj.sections;
  if (!Array.isArray(sections)) {
    errs.push("sections 必须是数组");
  } else {
    // userFacing 与 sections 必须自洽：两者矛盾说明 agent 没读懂规则，
    // 而矛盾的后果是页面上出现一个只有标题的空版本块。
    if (userFacing === true && sections.length === 0) {
      errs.push("userFacing 为 true 但 sections 为空 —— 要么补上条目，要么把 userFacing 改成 false");
    }
    if (userFacing === false && sections.length > 0) {
      errs.push(
        `userFacing 为 false 但 sections 有 ${sections.length} 组 —— ` +
          `「无用户可见变更」与「有条目」自相矛盾`,
      );
    }

    const seenTitles = new Set<string>();
    sections.forEach((sec, i) => {
      const at = `sections[${i}]`;
      if (!isPlainObject(sec)) {
        errs.push(`${at} 必须是对象`);
        return;
      }
      const title = sec.title;
      if (typeof title !== "string") {
        errs.push(`${at}.title 必须是字符串`);
      } else if (!TITLE_TO_KEY[title]) {
        errs.push(
          `${at}.title「${title}」不在受控词表内，只能是：${SECTION_TITLES.join(" / ")}` +
            `（表外词渲染层拿不到配色与顺序）`,
        );
      } else if (seenTitles.has(title)) {
        errs.push(`${at}.title「${title}」重复 —— 同一分组的条目要合并到一组里`);
      } else {
        seenTitles.add(title);
      }

      const items = sec.items;
      if (!Array.isArray(items)) {
        errs.push(`${at}.items 必须是数组`);
        return;
      }
      if (items.length === 0) {
        errs.push(`${at}.items 为空 —— 空分组会渲染出一个只有徽章的空壳，直接删掉这一组`);
      }
      items.forEach((item, j) => {
        const iat = `${at}.items[${j}]`;
        if (typeof item !== "string") {
          errs.push(`${iat} 必须是字符串`);
          return;
        }
        if (item.trim().length === 0) {
          errs.push(`${iat} 是空字符串`);
          return;
        }
        if (item.length > MAX_ITEM_LEN) {
          errs.push(
            `${iat} 超长（${item.length} > ${MAX_ITEM_LEN} 字）：一条一句话，用户是扫读的`,
          );
        }
        if (hasUrl(item)) {
          errs.push(`${iat} 含 URL（${findUrls(item).join(", ")}）—— 这份文案会发布到公网`);
        }
      });
    });
  }

  // ── commits（溯源，可以为空数组但字段必须在） ──
  if (!Array.isArray(obj.commits)) {
    errs.push("commits 必须是数组（本版覆盖了哪些 commit，用于覆盖率核对与人工回溯）");
  } else if (obj.commits.some((c) => typeof c !== "string" || !/^[0-9a-f]{7,40}$/i.test(c))) {
    errs.push("commits 每一项必须是 7-40 位十六进制的 commit hash");
  }

  if (obj.discarded !== undefined) {
    if (!Array.isArray(obj.discarded)) {
      errs.push("discarded 若存在必须是数组");
    } else if (
      obj.discarded.some((c) => typeof c !== "string" || !/^[0-9a-f]{7,40}$/i.test(c))
    ) {
      errs.push("discarded 每一项必须是 7-40 位十六进制的 commit hash");
    }
  }

  return errs;
}

/**
 * 把 curated 的 sections 归一成渲染形态：补上 key、按受控词表顺序重排。
 *
 * 为什么在这一层排序而不是信任 JSON 里的顺序：JSON 是人工可编辑的，
 * 「破坏性变更」被人不小心放到最后就会排在最不显眼的位置 —— 而它恰恰是
 * 用户升级前最该先看到的。受控词表的顺序是唯一事实源。
 */
export function toRenderSections(sections: CuratedSection[]): RenderSection[] {
  const byTitle = new Map(sections.map((s) => [s.title, s]));
  const out: RenderSection[] = [];
  for (const meta of SECTION_META) {
    const sec = byTitle.get(meta.title);
    if (!sec || sec.items.length === 0) continue;
    out.push({ key: meta.key, title: meta.title, items: [...sec.items] });
  }
  return out;
}

export interface CoverageResult {
  /** 真实区间里的提交数（已扣掉生成器过滤的噪声） */
  total: number;
  /** 既不在 commits 也不在 discarded 里的提交 */
  unaccounted: string[];
  ratio: number;
  /** 是否超过 warn 阈值 */
  warn: boolean;
}

/**
 * `commits` 覆盖率检查：真实提交里有多少既没被采用、也没被显式丢弃。
 *
 * 为什么值得单独一道检查：**漏掉一整块功能是本方案最可能的失败模式，
 * 而它完全静默** —— 页面看起来很正常，只是少了一个功能的介绍，
 * 没有任何断言、任何构建步骤会发现。
 *
 * 比对用 hash 前缀而非全等：curated 里存的是 short hash（`git log %h`，
 * 通常 8 位），真实区间可能拿到不同长度。两边都截到较短的那个长度再比。
 */
export function checkCoverage(
  entry: Pick<CuratedEntry, "commits" | "discarded">,
  realHashes: string[],
  threshold: number = COVERAGE_WARN_THRESHOLD,
): CoverageResult {
  const accounted = [...(entry.commits ?? []), ...(entry.discarded ?? [])].map((h) =>
    h.toLowerCase(),
  );
  const unaccounted = realHashes.filter((real) => {
    const r = real.toLowerCase();
    return !accounted.some((a) => r.startsWith(a) || a.startsWith(r));
  });
  const total = realHashes.length;
  const ratio = total === 0 ? 0 : unaccounted.length / total;
  return { total, unaccounted, ratio, warn: total > 0 && ratio > threshold };
}
