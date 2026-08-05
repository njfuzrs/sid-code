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
 * ── 三份产物，各有唯一职责（2026-07-28 改造：changelog 并入官网，不再自建 mini 站）──
 *   1. CHANGELOG.md                            仓库根，文本事实源。给 diff / 脚本 / curl。
 *   2. website/.vitepress/data/changelog.json   官网 /changelog 页的数据源。
 *                                              由 theme/Changelog.vue 在构建期 import 并渲染，
 *                                              视觉、深浅色、字体全部走站点 brand.css，
 *                                              用户看到的是**同一个站**而不是两个产品。
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
 *   旧 HTML 版把 commit hash 链到 `http://gitlab.example.com/...`。那份产物只挂在
 *   /releases/ 下问题不大，但并入公网官网就等于往站点撒内网主机名（撞设计方案 §6.5
 *   「website 全站无网关地址残留」）。JSON 只保留纯文本 short hash，不带任何 URL。
 *   tests/website/changelog-data.test.ts 把这条钉成回归测试，不靠人眼。
 *
 * 退出行为：changelog 生成绝不阻断发布——「无提交」只 warn 不报错，仅 git 命令真正
 *   损坏时才非零退出（release.sh 侧也用 `|| warn` 兜底，双保险）。
 */
import { writeFileSync, mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");
const CHANGELOG_MD_PATH = resolve(ROOT, "CHANGELOG.md");
const CHANGELOG_HTML_PATH = resolve(ROOT, "CHANGELOG.html");
const SITE_DATA_DIR = resolve(ROOT, "website/.vitepress/data");
const SITE_DATA_PATH = resolve(SITE_DATA_DIR, "changelog.json");

/** 官网 changelog 页路径（跳转页与收尾提示都用它，只在这里写一次） */
const SITE_CHANGELOG_PATH = "/changelog";

const MD_FILE_HEADER =
  "# Changelog\n\n本文件由 scripts/generate-changelog.ts 自动生成，请勿手改。\n";

// genesis 块（最老 tag 之前的全部历史）只回溯这么多条提交，且只列 subject，避免上千条灌爆
const GENESIS_LOOKBACK = 60;
// 单个版本块的提交数超过此阈值时不展开 body 细节（只列 subject），保证可读性
const MAX_DETAILED_COMMITS = 40;
// 单条提交最多展开的 body 细节条数
const MAX_DETAILS_PER_COMMIT = 8;
// 单条 body 细节的最大展示长度（超出截断加省略号）
const MAX_DETAIL_LEN = 200;

// git log 字段/记录分隔符：避开 subject/body 内的 :/—/• 等字符
const FS = "\x1f"; // 字段分隔
const RS = "\x1e"; // 记录分隔

// 分组顺序、中文标题、徽章配色 key（其余类型统一归入「其他」）
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

function git(args: string[]): string {
  return execFileSync("git", args, { cwd: ROOT, encoding: "utf-8" }).trim();
}

/** 所有 semver tag（vX.Y.Z），按版本号降序；排除 phase-1-done 等非 semver tag */
function listSemverTags(): string[] {
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

/** tag 指向提交的日期（YYYY-MM-DD）；取不到则返回 today */
function tagDate(tag: string): string {
  try {
    const iso = git(["log", "-1", "--format=%ai", tag]);
    return iso.slice(0, 10);
  } catch {
    return today();
  }
}

function today(): string {
  // release.sh 在真实时钟下调用；此脚本非 workflow 沙箱，Date 可用
  return new Date().toISOString().slice(0, 10);
}

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

/**
 * 从 commit 文本里抹掉 URL —— changelog.json 会随站点发布到公网。
 *
 * 为什么必须在**生成期**做，而不是靠 review 或测试兜：
 * commit message 是**开发者随手写**的自由文本，作者当时想的是"把改动说清楚"，
 * 不是"这段字会被发到公网"。链路（commit → generate-changelog → changelog.json →
 * 站点构建 → 公网）足够长，没有任何一步会自然提醒作者这件事。
 * `tests/website/changelog-integration.test.ts` 的两条断言是**事后闸门**（能发现，
 * 但发现时脏数据已经进了仓库）；这里是**源头预防**。两者都要有，职责不同。
 *
 * 实际踩过：2026-08-06 那次域名切换，commit 标题里写了新官网地址，
 * 于是 `https://www.sid-code.cc` 被原样搬进 changelog.json，测试报红。
 * 那次泄的恰好是公开地址所以无害，但同一条通路搬的若是内网 gitlab / 私网 IP，
 * 就是真的把内部坐标发到公网了 —— 判定标准只能是"URL 形态"，不能靠"看起来是否敏感"。
 *
 * 处理方式是替换成占位符而非整段删除：把 "地址切到 https://x" 变成
 * "地址切到 <链接已省略>" 仍读得通，直接删会留下悬空的"切到"。
 */
export function stripUrls(text: string): string {
  // 正则写在函数内而非模块级：带 /g 的正则有 lastIndex 状态，模块级共享一个实例，
  // 以后若有人改用 .test()/.exec() 就会踩到"隔次匹配失败"的经典坑。
  // （当前 .replace() 会自动重置 lastIndex，所以现在是安全的——但别留这个雷。）
  return text.replace(/https?:\/\/[^\s"'）)\]]+/g, "<链接已省略>");
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

/** 采集某区间的提交（含 body 细节），过滤 bump/merge/dashboard 刷盘等噪声 */
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

    // 过滤 bump 记账、Merge、eval dashboard 刷盘噪声
    if (/^bump\s+v?\d/i.test(subj)) continue;
    if (/^Merge\s/i.test(subj)) continue;
    if (/^ci(?:\([^)]*\))?\s*[:：]\s*refresh dashboard/i.test(subj)) continue;

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
 * 不含任何 URL —— 见文件头「安全」一节。
 */
interface SiteChangelog {
  /** 生成日期（YYYY-MM-DD） */
  generatedAt: string;
  /** 本次发布的版本号（页顶「最新版本」统计用） */
  currentVersion: string;
  totalVersions: number;
  totalCommits: number;
  /** 分组元信息，供组件渲染徽章（顺序即显示顺序） */
  groupMeta: Array<{ key: string; title: string }>;
  versions: Array<{
    version: string;
    date: string;
    isGenesis: boolean;
    count: number;
    groups: Array<{
      key: string;
      title: string;
      commits: Array<{
        scope: string | null;
        desc: string;
        hash: string;
        /** detailed=false 的版本这里是空数组（组件据此不渲染折叠箭头） */
        details: string[];
      }>;
    }>;
  }>;
}

function buildSiteData(models: VersionModel[], currentVersion: string): SiteChangelog {
  return {
    generatedAt: today(),
    currentVersion,
    totalVersions: models.length,
    totalCommits: models.reduce((n, v) => n + v.commits.length, 0),
    groupMeta: GROUPS.map((g) => ({ key: g.key, title: g.title })),
    versions: models.map((v) => ({
      version: v.version,
      date: v.date,
      isGenesis: v.isGenesis,
      count: v.commits.length,
      groups: GROUPS.flatMap((g) => {
        const items = v.commits.filter((c) => c.group === g.key);
        if (items.length === 0) return [];
        return [
          {
            key: g.key,
            title: g.title,
            commits: items.map((c) => ({
              scope: c.scope,
              desc: c.desc,
              hash: c.shortHash,
              details: v.detailed ? c.details : [],
            })),
          },
        ];
      }),
    })),
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
    `  ✅ CHANGELOG.md + website/.vitepress/data/changelog.json 已生成` +
      `（当前 v${version} ${currentCommitCount} 条 / 全部 ${siteData.totalVersions} 版本 ${siteData.totalCommits} 条）`,
  );
  console.log(`  ✅ CHANGELOG.html 已写为跳转页 → ${SITE_CHANGELOG_PATH}`);
  console.log(
    `  ⚠️  站点页是构建期快照：bump 提交后需跑 ./scripts/website-deploy.sh 才会上线`,
  );
}

// 只在被直接执行时跑；被 import 时（如单测 import stripUrls）不能有副作用——
// 否则一次 import 就会真的重写 CHANGELOG.md / changelog.json，把测试变成写盘操作。
if (import.meta.main) main();
