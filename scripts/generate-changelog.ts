/**
 * scripts/generate-changelog.ts — 从 git 历史自动生成 changelog（三份产物）
 *
 * 用法：
 *   bun run scripts/generate-changelog.ts <version>
 *
 * 由 release.sh 在 bump 版本号之后、打 tag 之前调用。version 显式传入（与 $VERSION 同源，
 * 不自读 package.json，避免两处版本号漂移）。
 *
 * ── 设计：git 是唯一事实源，所有产物都是「渲染视图」──
 *   旧实现用「prepend/替换版本块」的累积写法，历史块与 git 会漂移。
 *   现改为每次运行都从 git 完整重建模型：
 *     - 遍历所有 semver tag（vX.Y.Z），逐个还原其提交区间 prevTag..thisTag
 *     - 正在发布的版本（<version> 参数，此刻还没打 tag）区间 = 最新 tag..HEAD
 *     - 最老的 tag 之前的历史统一并入「genesis」块（只列 subject，避免上千条灌爆）
 *   历史 tag 指向不可变提交 → 历史块稳定；只有「正在发布」块每次变化。确定性、幂等。
 *
 * ── 两个受众，两条渲染路径（2026-08-06 curated 改造）──
 *   commit message 的读者是**未来的自己**，changelog 的读者是**用户**，这两个受众要的
 *   信息不是同一件事，靠正则做不了这个转换（实测：276 条提交里 24% 是用户完全不关心的
 *   文档/杂项，剩下 76% 的文案讲的也多是符号改名而不是"这对我有什么变化"）。所以：
 *
 *     · CHANGELOG.md  ← 本脚本从 git 历史直接渲染（开发者视角，全量原始提交）
 *     · 官网 /changelog ← 读 `changelog/curated/v<version>.json`（用户视角，人工过目过）
 *
 *   curated 文件由**独立命令** `bun run changelog:curate` 生成（spawn sid-code 自己读 diff
 *   改写），入库后人工 review。本脚本**只读不生成** —— 发布路径必须确定性 + 离线 + 幂等，
 *   把一次 LLM 调用塞进发布链会同时破掉这三条。见 scripts/changelog-curate.ts 的文件头。
 *
 *   缺 curated 文件时**只 warn 不阻断**（见下方「退出行为」）：一个忘了跑 curate 的人
 *   不该被卡在发布流程里，但他应该看到一条明显的 warn。release.sh 另有一道**发布前**
 *   的交互提示（那时二进制还没构建，改还来得及）。
 *
 * ── 三份产物，各有唯一职责（2026-07-28 改造：changelog 并入官网，不再自建 mini 站）──
 *   1. CHANGELOG.md                            仓库根，文本事实源。给 diff / 脚本 / curl。
 *                                              **全量原始提交**——curated 漏了东西时
 *                                              这是唯一的回溯途径，不许精简。
 *   2. website/.vitepress/data/changelog.json   官网 /changelog 页的数据源。
 *                                              由 theme/Changelog.vue 在构建期 import 并渲染，
 *                                              视觉、深浅色、字体全部走站点 brand.css，
 *                                              用户看到的是**同一个站**而不是两个产品。
 *                                              内容来自 curated 文案，**不含** per-commit
 *                                              的 hash / scope / body 细节。
 *   3. CHANGELOG.html                          退化为 20 行跳转页 → /changelog。
 *                                              老链接（README / install.sh 收尾提示 / 用户终端
 *                                              历史输出）散落各处，直接删就是一堆 404；
 *                                              留跳转页可以完全不碰 nginx——`/releases/` 那个
 *                                              location 的 alias 极脆（设计方案 §5.3 陷阱 3
 *                                              实证过一个正则 location 就能把它旁路掉致 404）。
 *
 *   ⚠ 刻意**不生成** website/changelog.md 正文：md 会被 minisearch 纳入全站索引，
 *     几百条 commit 描述会把全站搜索结果冲成噪音。changelog 需要的是**自己的**搜索框
 *     （只搜版本变更），所以走 JSON + 组件，容器页 frontmatter 标 `search: false`。
 *
 *   ⚠ 刻意**不做**反漂移 --check 门禁：website/ref/ 那道门禁能立是因为源是源码；
 *     changelog 的源是 git 历史，每提交一次就变，纳进门禁等于每次 commit 都红。
 *     同理 website-deploy.sh **不要**重跑本脚本——那会把未发版的 HEAD 提交
 *     挂到一个已发布的版本号下，归属错乱。只有 release.sh 有资格生成它。
 *
 * ── 安全：产物不含内网地址 ──
 *   旧 HTML 版把 commit hash 链到内网 gitlab。那份产物只挂在 /releases/ 下问题不大，
 *   但并入公网官网就等于往站点撒内网主机名（撞设计方案 §6.5「website 全站无网关地址残留」）。
 *   `stripUrls`（现在住在 scripts/lib/changelog-text.ts）在**生成期**抹掉一切 URL 形态，
 *   并且**同样作用于 curated 文案** —— curated 走的是同一条通路发到公网，而且多一个
 *   风险源：agent 读 diff 时会看到内网 gitlab 地址、部署脚本里的 IP，可能原样抄进文案。
 *   校验器（入库前拦截）+ 这里（渲染期兜底）两道都要有，见方案 §7.2。
 *   tests/website/changelog-integration.test.ts 把这条钉成回归测试，不靠人眼。
 *
 * 退出行为：changelog 生成绝不阻断发布——「无提交」只 warn 不报错，仅 git 命令真正
 *   损坏时才非零退出（release.sh 侧也用 `|| warn` 兜底，双保险）。
 */
import { writeFileSync, mkdirSync, readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { execFileSync } from "node:child_process";
import {
  ROOT,
  GENESIS_LOOKBACK,
  FS,
  RS,
  listSemverTags,
  tagDate,
  today,
  isNoiseSubject,
} from "./lib/changelog-git.ts";
import { stripUrls } from "./lib/changelog-text.ts";
import {
  validateCurated,
  toRenderSections,
  SECTION_META,
  type CuratedEntry,
  type RenderSection,
} from "./lib/changelog-curated-schema.ts";

// stripUrls 的实现已搬到 scripts/lib/changelog-text.ts（curated 校验器也要用它，
// 见文件头「安全」一节）。这里 re-export 保住老的 import 路径
// （tests/website/changelog-strip-urls.test.ts 从本文件 import 它）。
export { stripUrls };

const CHANGELOG_MD_PATH = resolve(ROOT, "CHANGELOG.md");
const CHANGELOG_HTML_PATH = resolve(ROOT, "CHANGELOG.html");
const SITE_DATA_DIR = resolve(ROOT, "website/.vitepress/data");
const SITE_DATA_PATH = resolve(SITE_DATA_DIR, "changelog.json");

/** 官网 changelog 页路径（跳转页与收尾提示都用它，只在这里写一次） */
const SITE_CHANGELOG_PATH = "/changelog";

const MD_FILE_HEADER =
  "# Changelog\n\n本文件由 scripts/generate-changelog.ts 自动生成，请勿手改。\n";

/** curated 文案目录（仓库根，入库、人工过目）。本脚本**只读**它，绝不生成。 */
const CURATED_DIR = resolve(ROOT, "changelog/curated");

// 单个版本块的提交数超过此阈值时不展开 body 细节（只列 subject），保证可读性
const MAX_DETAILED_COMMITS = 40;
// 单条提交最多展开的 body 细节条数
const MAX_DETAILS_PER_COMMIT = 8;
// 单条 body 细节的最大展示长度（超出截断加省略号）
const MAX_DETAIL_LEN = 200;

/**
 * CHANGELOG.md 的分组（**开发者视角，全量原始提交**）。
 *
 * ⚠ 刻意与官网的 4 组受控词表（SECTION_META）**不同**，这不是漂移：
 * 两个产物服务两个受众。CHANGELOG.md 要能回溯「这个版本到底改了哪些提交」，
 * 所以 docs/other 这些组必须保留 —— 它恰恰是 curated 漏了东西时的回溯途径。
 * 官网那 4 组是「用户关心什么」，见 scripts/lib/changelog-curated-schema.ts。
 */
const GROUPS: Array<{ key: string; title: string }> = [
  { key: "feat", title: "新功能" },
  { key: "fix", title: "修复" },
  { key: "refactor", title: "重构" },
  { key: "perf", title: "性能" },
  { key: "docs", title: "文档" },
  { key: "other", title: "其他" },
];

// feat/fix/... → 分组 key；未列出的（style/test/build/ci/chore）归 other
const TYPE_TO_GROUP: Record<string, string> = {
  feat: "feat",
  fix: "fix",
  refactor: "refactor",
  perf: "perf",
  docs: "docs",
};

// 容错解析：type + 可选(scope) + 半角/全角冒号 + 描述
const COMMIT_RE =
  /^(feat|fix|refactor|perf|docs|style|test|build|ci|chore)(?:\(([^)]*)\))?\s*[:：]\s*(.*)$/;

// git trailer（不作为 body 细节展示）
const TRAILER_RE =
  /^(Co-authored-by|Signed-off-by|Reviewed-by|Acked-by|Tested-by|Refs?|Closes?|Fixes?|See-also|BREAKING[- ]CHANGE)\s*[:：]/i;

// body 里的裸「章节标签」（问题：/方案：这类，独占一行且无内容时丢弃，避免噪声）
const BARE_SECTION_LABEL_RE =
  /^(问题|方案|实现|验证|背景|说明|测试|影响|原因|现象|修复|改动|变更|目的|思路|结论)[:：]?$/;

const BULLET_RE = /^\s*(?:[-*•]|\d+[.)])\s+(.*)$/;

// git / listSemverTags / tagDate / today / 区间算法都搬到了 scripts/lib/changelog-git.ts：
// curate 脚本必须用**同一套**区间算法，否则「curate 看到的提交」与「changelog 里的提交」
// 不是同一批，而这完全静默 —— 两边各自看起来都很正常。

interface ParsedCommit {
  group: string;
  scope: string | null;
  desc: string;
  shortHash: string;
  details: string[]; // body 细节（bullet / 散文段落）
}

interface VersionModel {
  version: string;
  date: string;
  commits: ParsedCommit[];
  detailed: boolean; // 是否展开 body 细节
  isGenesis: boolean;
}

/** 从 commit body 抽取「子条目」：优先 bullet/编号列表，无则退化为散文段落 */
function extractDetails(body: string): string[] {
  const lines = body.split("\n").map((l) => l.replace(/\s+$/, ""));

  // 先剔除 trailer 行
  const kept: string[] = [];
  for (const line of lines) {
    if (TRAILER_RE.test(line.trim())) continue;
    kept.push(line);
  }

  // 模式一：bullet/编号列表——bullet 起一条，缩进续行拼接到上一条
  const items: string[] = [];
  let cur: string | null = null;
  let sawBullet = false;
  for (const line of kept) {
    const m = BULLET_RE.exec(line);
    if (m) {
      sawBullet = true;
      if (cur !== null) items.push(cur.trim());
      cur = m[1];
    } else if (cur !== null) {
      if (line.trim() === "") {
        items.push(cur.trim());
        cur = null;
      } else {
        cur += " " + line.trim(); // 换行续写
      }
    }
  }
  if (cur !== null) items.push(cur.trim());

  let details: string[];
  if (sawBullet && items.length > 0) {
    details = items;
  } else {
    // 模式二:散文段落——丢弃裸章节标签,保留有内容的行
    details = kept
      .map((l) => l.trim())
      .filter(Boolean)
      .filter((l) => !BARE_SECTION_LABEL_RE.test(l));
  }

  // 去重 + 截断长度 + 封顶条数
  const seen = new Set<string>();
  const out: string[] = [];
  for (let d of details) {
    if (!d) continue;
    if (d.length > MAX_DETAIL_LEN) d = d.slice(0, MAX_DETAIL_LEN - 1).trimEnd() + "…";
    if (seen.has(d)) continue;
    seen.add(d);
    out.push(d);
    if (out.length >= MAX_DETAILS_PER_COMMIT) break;
  }
  return out;
}

/**
 * 采集某区间的提交（含 body 细节），过滤 bump/merge/dashboard 刷盘等噪声。
 *
 * 噪声判据走共享的 `isNoiseSubject`：curate 必须用**同一份**判据，否则 curate 会把
 * `bump v0.1.601` 这种记账提交也喂给 agent，而覆盖率核对又会因为两边分母不同而永远对不上。
 */
function collectCommits(range: string | null): ParsedCommit[] {
  let raw = "";
  const pretty = `--pretty=format:%h${FS}%s${FS}%b${RS}`;
  try {
    const args = range
      ? ["log", range, "--no-merges", pretty]
      : ["log", "--no-merges", pretty];
    raw = execFileSync("git", args, { cwd: ROOT, encoding: "utf-8" });
  } catch (err: any) {
    // git 命令真正损坏（非法 range 等）——抛出让 release.sh 的 || warn 接住
    throw new Error(`git log 失败（range=${range ?? "ALL"}）: ${err?.message ?? err}`);
  }

  const records = raw
    .split(RS)
    .map((r) => r.replace(/^\n+/, ""))
    .filter((r) => r.trim());

  const commits: ParsedCommit[] = [];
  for (const rec of records) {
    const [shortHash = "", subject = "", body = ""] = rec.split(FS);
    const subj = subject.trim();
    if (!subj) continue;
    if (isNoiseSubject(subj)) continue;

    const m = COMMIT_RE.exec(subj);
    let group: string;
    let scope: string | null;
    let desc: string;
    if (m) {
      group = TYPE_TO_GROUP[m[1]] ?? "other";
      scope = m[2] ? m[2].trim() : null;
      desc = m[3].trim();
      if (!desc) continue;
    } else {
      group = "other";
      scope = null;
      desc = subj;
    }

    commits.push({
      group,
      scope,
      // desc 与 details 都要抹 URL：两者都会进 changelog.json 并发到公网（见 stripUrls）
      desc: stripUrls(desc),
      shortHash: shortHash.trim(),
      details: extractDetails(body).map(stripUrls),
    });
  }
  return commits;
}

/** 构建完整版本模型：正在发布的版本 + 所有历史 tag（含 genesis） */
function buildModel(currentVersion: string): VersionModel[] {
  const tags = listSemverTags(); // 降序
  const models: VersionModel[] = [];

  // ── 目标版本的提交区间 ──
  //
  // 两种情形，必须分开算（合并处理会丢提交，实测踩过，见下）：
  //
  // A. 正常发布：release.sh 在 bump 之后、打 tag **之前**调用，此刻 currentVersion
  //    还没有对应 tag → 区间 = 最新 tag..HEAD。
  //
  // B. currentVersion 的 tag **已存在**：事后补跑（`bun run scripts/generate-changelog.ts
  //    0.1.600`）、或 --no-bump 复用版本号。此时若仍用 `tags[0]..HEAD`，而 tags[0]
  //    恰好就是 currentVersion 那个 tag，算出来的是「tag 之后新加的提交」——
  //    真正属于该版本的提交全被漏掉，而下面的历史循环又因 `version === currentVersion`
  //    跳过了它，于是这些提交**两头都不认，彻底消失**。
  //
  //    实测：v0.1.600 打完 tag 后补跑一次，changelog 从 276 条掉到 267 条
  //    （该版本真实 11 条提交被换成 tag 之后的 1 条），且历史块也拿不回来。
  //    产物是站点数据源，静默少 9 条不会有任何报错。
  const currentTag = tags.find((t) => t.replace(/^v/, "") === currentVersion) ?? null;
  let currentRange: string | null;
  let currentDate: string;
  let currentIsGenesis: boolean;
  if (currentTag) {
    // 情形 B：区间 = 更老的那个 tag..currentTag（与历史块算法一致）
    const idx = tags.indexOf(currentTag);
    const prevTag = tags[idx + 1] ?? null;
    currentRange = prevTag ? `${prevTag}..${currentTag}` : currentTag;
    currentDate = tagDate(currentTag);
    currentIsGenesis = !prevTag;
  } else {
    // 情形 A：尚未打 tag，区间 = 最新 tag..HEAD
    const newestTag = tags[0] ?? null;
    currentRange = newestTag ? `${newestTag}..HEAD` : null;
    currentDate = today();
    currentIsGenesis = !newestTag;
  }
  const currentCommits = collectCommits(currentRange);
  models.push({
    version: currentVersion,
    date: currentDate,
    commits: currentCommits,
    detailed: !currentIsGenesis && currentCommits.length <= MAX_DETAILED_COMMITS,
    isGenesis: currentIsGenesis,
  });

  // 历史 tag（降序遍历，逐个还原 prevTag..thisTag）
  for (let i = 0; i < tags.length; i++) {
    const tag = tags[i];
    const version = tag.replace(/^v/, "");

    // 若正在发布的版本号恰好等于某个已存在 tag（--no-bump 复用场景）：跳过重复
    if (version === currentVersion) continue;

    const prevTag = tags[i + 1] ?? null; // 更老的 tag
    const isGenesis = !prevTag;
    let range: string;
    if (isGenesis) {
      // 最老 tag：并入其之前的历史，但限制回溯条数，避免上千条灌爆
      range = `${tag}~${GENESIS_LOOKBACK}..${tag}`;
    } else {
      range = `${prevTag}..${tag}`;
    }

    let commits: ParsedCommit[];
    try {
      commits = collectCommits(range);
    } catch {
      // genesis 的 tag~N 可能超出根提交范围，退化为「从根到 tag」
      commits = isGenesis ? collectCommits(tag) : [];
    }

    models.push({
      version,
      date: tagDate(tag),
      commits,
      detailed: !isGenesis && commits.length <= MAX_DETAILED_COMMITS,
      isGenesis,
    });
  }

  return models;
}

// ─────────────────────── Markdown 渲染（文本事实源）───────────────────────

function renderMarkdownBlock(v: VersionModel): string {
  const lines: string[] = [`## v${v.version} (${v.date})`, ""];

  if (v.commits.length === 0) {
    lines.push("### 其他", "- 无显著变更", "");
    return lines.join("\n").trimEnd() + "\n";
  }

  for (const g of GROUPS) {
    const items = v.commits.filter((c) => c.group === g.key);
    if (items.length === 0) continue;
    lines.push(`### ${g.title}`);
    for (const c of items) {
      const scopePrefix = c.scope ? `**${c.scope}** · ` : "";
      const hashSuffix = c.shortHash ? ` \`${c.shortHash}\`` : "";
      lines.push(`- ${scopePrefix}${c.desc}${hashSuffix}`);
      if (v.detailed) {
        for (const d of c.details) {
          lines.push(`  - ${d}`);
        }
      }
    }
    lines.push("");
  }
  return lines.join("\n").trimEnd() + "\n";
}

function renderMarkdown(models: VersionModel[]): string {
  const blocks = models.map(renderMarkdownBlock).join("\n");
  return `${MD_FILE_HEADER}\n${blocks}`;
}

// ─────────────── 官网数据源（website/.vitepress/data/changelog.json）───────────────

/**
 * 站点数据结构。刻意做成「已分组、已排序、渲染即用」的形态：
 * 组件只负责显示与过滤，不在浏览器里重做分组/排序（那份逻辑已经在这儿了，
 * 两处实现同一套分组规则迟早分叉）。
 *
 * ── 2026-08-06 curated 改造：per-commit 字段全部移除 ──
 *   `hash` / `scope` / `details` 不再进站点数据源（它们只留在 CHANGELOG.md），
 *   `isGenesis` 也一并移除。为什么：这些都是**开发者视角**的坐标，
 *   而这份 JSON 唯一的消费者是官网 /changelog，那一页的读者是用户。
 *
 *   两个键**改了名**，因为语义真的变了 —— 同名不同义是最坏的一种漂移：
 *     · `groupMeta`    → `sectionMeta`（词表从 6 组换成 4 组受控词）
 *     · `totalCommits` → `totalItems` （从「commit 总数」变成「curated 条目总数」）
 *
 *   `items` 保持为**字符串数组**，刻意不升级成 `{ text, tags[] }`：curated 条目
 *   总量级是每版 3-8 条 × 20 版 ≈ 150 条，少到不需要二级筛选；加结构只会让
 *   人工编辑成本上升（review 时要改 JSON 嵌套）。
 *
 * 不含任何 URL —— 见文件头「安全」一节。
 */
interface SiteChangelog {
  /** 生成日期（YYYY-MM-DD） */
  generatedAt: string;
  /** 本次发布的版本号（页顶「最新版本」统计用） */
  currentVersion: string;
  totalVersions: number;
  /** ⚠ curated **条目**总数，不是 commit 数（键名与语义一起改的，见上） */
  totalItems: number;
  /** 分组元信息，供组件渲染徽章（顺序即显示顺序） */
  sectionMeta: Array<{ key: string; title: string }>;
  versions: Array<{
    version: string;
    date: string;
    /** 本版一句话亮点；无则为 null */
    highlight: string | null;
    /** false = 本版无用户可见变更（纯内部）。组件据此渲染一行淡色说明。 */
    userFacing: boolean;
    count: number;
    sections: RenderSection[];
  }>;
}

/**
 * 读一个版本的 curated 文案。缺失 / 不合规都返回 null（**不抛异常**）。
 *
 * 为什么缺失只 warn 不阻断发布：release.sh 现有的调用形态是
 * `bun run scripts/generate-changelog.ts "$VERSION" || warn "…（不阻断发布）"`，
 * 而「changelog 生成绝不阻断发布」这条设计写在本文件头的「退出行为」一节。
 * 一个忘了跑 curate 的人不应该被卡在发布流程里 —— 但他应该看到一条明显的 warn，
 * 并且 release.sh 另有一道**发布前**的交互提示（那时二进制还没构建，改还来得及）。
 */
function loadCurated(version: string): CuratedEntry | null {
  const p = resolve(CURATED_DIR, `v${version}.json`);
  if (!existsSync(p)) return null;
  let obj: unknown;
  try {
    obj = JSON.parse(readFileSync(p, "utf-8"));
  } catch (err: any) {
    console.log(`  ⚠️  curated/v${version}.json 解析失败，按「无变更说明」渲染：${err?.message ?? err}`);
    return null;
  }
  const errs = validateCurated(obj, version);
  if (errs.length > 0) {
    console.log(`  ⚠️  curated/v${version}.json 不合规，按「无变更说明」渲染：`);
    for (const e of errs) console.log(`       · ${e}`);
    return null;
  }
  return obj as CuratedEntry;
}

function buildSiteData(models: VersionModel[], currentVersion: string): SiteChangelog {
  const missing: string[] = [];

  const versions = models.map((v) => {
    const curated = loadCurated(v.version);
    if (!curated) missing.push(v.version);

    // stripUrls 同样作用于 curated 文案 —— 它走的是同一条通路发到公网，而且多一个
    // 风险源：agent 读 diff 时会看到内网地址与 IP，可能原样抄进文案。校验器
    // （入库前拦截）与这里（渲染期兜底）看似重复，但**必须都有**：人工编辑
    // curated JSON 时不会再跑校验器，这里才是最终闸门。见方案 §7.2。
    const sections = curated
      ? toRenderSections(curated.sections).map((s) => ({
          ...s,
          items: s.items.map(stripUrls),
        }))
      : [];

    return {
      version: v.version,
      date: v.date,
      highlight: curated?.highlight ? stripUrls(curated.highlight) : null,
      // 缺 curated 时按「无用户可见变更」渲染：组件会显示一行淡色说明，
      // 而**版本块本身仍然存在** —— 否则左栏时间线点进来会没有落点。
      userFacing: curated ? curated.userFacing : false,
      count: sections.reduce((n, s) => n + s.items.length, 0),
      sections,
    };
  });

  if (missing.length > 0) {
    console.log(
      `  ⚠️  ${missing.length} 个版本缺 curated 文案，官网将显示「本版无变更说明」：` +
        `${missing.slice(0, 8).join(" ")}${missing.length > 8 ? " …" : ""}`,
    );
    console.log(`      补跑：bun run changelog:curate <version>`);
  }

  return {
    generatedAt: today(),
    currentVersion,
    totalVersions: versions.length,
    totalItems: versions.reduce((n, v) => n + v.count, 0),
    sectionMeta: SECTION_META.map((s) => ({ key: s.key, title: s.title })),
    versions,
  };
}

// ─────────── CHANGELOG.html：跳转页（保住散落各处的老链接不 404）───────────

function renderRedirectHtml(): string {
  // 用 /changelog 绝对路径：与 host 无关（老链接在同一站点下），域名切换时无需改。
  // meta refresh + JS replace 双写：前者不依赖 JS，后者不留一条多余的历史记录。
  return `<!doctype html>
<html lang="zh">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta http-equiv="refresh" content="0; url=${SITE_CHANGELOG_PATH}" />
<link rel="canonical" href="${SITE_CHANGELOG_PATH}" />
<title>sid-code · 更新日志已迁移</title>
<style>
body { margin: 0; min-height: 100vh; display: grid; place-items: center;
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", sans-serif;
  color: #1a2236; background: #f5f7fb; line-height: 1.7; }
.box { text-align: center; padding: 32px; }
a { color: #2554e0; }
code { font-family: ui-monospace, "SF Mono", Menlo, monospace; font-size: 13px;
  background: rgba(59,108,246,0.1); padding: 2px 7px; border-radius: 5px; }
</style>
</head>
<body>
<div class="box">
  <p>更新日志已并入官网文档站。</p>
  <p>正在跳转到 <a href="${SITE_CHANGELOG_PATH}">${SITE_CHANGELOG_PATH}</a> …</p>
  <p>纯文本版仍在 <code>CHANGELOG.md</code>（与本页同目录）。</p>
</div>
<script>location.replace(${JSON.stringify(SITE_CHANGELOG_PATH)});</script>
</body>
</html>
`;
}

// ─────────────────────── 主流程 ───────────────────────

function main(): void {
  const version = process.argv[2]?.trim();
  if (!version) {
    console.error("用法: bun run scripts/generate-changelog.ts <version>");
    process.exit(1);
  }

  const models = buildModel(version);
  const currentCommitCount = models[0]?.commits.length ?? 0;

  if (currentCommitCount === 0) {
    console.log(
      `  ⚠️  v${version} 区间无可归类提交，仍写入最小版本块（无显著变更）`,
    );
  }

  const siteData = buildSiteData(models, version);

  writeFileSync(CHANGELOG_MD_PATH, renderMarkdown(models));
  mkdirSync(SITE_DATA_DIR, { recursive: true });
  // 尾随换行：让它像仓库里其它文本产物一样对 git diff 友好
  writeFileSync(SITE_DATA_PATH, JSON.stringify(siteData, null, 2) + "\n");
  writeFileSync(CHANGELOG_HTML_PATH, renderRedirectHtml());

  console.log(
    `  ✅ CHANGELOG.md（v${version} ${currentCommitCount} 条原始提交）+ ` +
      `changelog.json（${siteData.totalVersions} 版本 / ${siteData.totalItems} 条 curated 文案）已生成`,
  );
  console.log(`  ✅ CHANGELOG.html 已写为跳转页 → ${SITE_CHANGELOG_PATH}`);
  console.log(
    `  ⚠️  站点页是构建期快照：bump 提交后需跑 ./scripts/website-deploy.sh 才会上线`,
  );
}

// 只在被直接执行时跑；被 import 时（如单测 import stripUrls）不能有副作用——
// 否则一次 import 就会真的重写 CHANGELOG.md / changelog.json，把测试变成写盘操作。
if (import.meta.main) main();
