/**
 * scripts/generate-changelog.ts — 从 git 历史自动生成 changelog（Markdown + HTML 两份产物）
 *
 * 用法：
 *   bun run scripts/generate-changelog.ts <version>
 *
 * 由 release.sh 在 bump 版本号之后、打 tag 之前调用。version 显式传入（与 $VERSION 同源，
 * 不自读 package.json，避免两处版本号漂移）。
 *
 * ── 设计：git 是唯一事实源，MD 与 HTML 都是「渲染视图」──
 *   旧实现用「prepend/替换版本块」的累积写法，历史块与 git 会漂移、且 HTML 无从复用。
 *   现改为每次运行都从 git 完整重建模型：
 *     - 遍历所有 semver tag（vX.Y.Z），逐个还原其提交区间 prevTag..thisTag
 *     - 正在发布的版本（<version> 参数，此刻还没打 tag）区间 = 最新 tag..HEAD
 *     - 最老的 tag 之前的历史统一并入「genesis」块（只列 subject，避免上千条提交灌爆）
 *   历史 tag 指向不可变提交 → 历史块稳定；只有「正在发布」块每次变化。确定性、幂等。
 *   文件头声明「自动生成,请勿手改」，全量重写与既有约定一致。
 *
 * ── 相比旧版的增强 ──
 *   1. 抓取 commit body 细节：subject 下挂 body 里的 bullet/编号列表（或散文段落）作为子条目，
 *      让用户看得懂「这个版本到底改了什么」，而不只是一句标题。
 *   2. 过滤机器噪声：bump 记账、Merge、`ci(eval): refresh dashboard` 刷盘提交、Co-Authored-By 尾注。
 *   3. 双产物：CHANGELOG.md（文本事实源，纳入 git）+ CHANGELOG.html（科技风页面，可直接点开）。
 *   4. commit hash 链接到 gitlab commit 页（从 origin remote 推导，推导不出则纯文本降级）。
 *
 * 退出行为：changelog 生成绝不阻断发布——「无提交」只 warn 不报错，仅 git 命令真正
 *   损坏时才非零退出（release.sh 侧也用 `|| warn` 兜底，双保险）。
 */
import { writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");
const CHANGELOG_MD_PATH = resolve(ROOT, "CHANGELOG.md");
const CHANGELOG_HTML_PATH = resolve(ROOT, "CHANGELOG.html");

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

// 分组顺序、中文标题、HTML 徽章配色 key（其余类型统一归入「其他」）
const GROUPS: Array<{ key: string; title: string; badge: string }> = [
  { key: "feat", title: "新功能", badge: "feat" },
  { key: "fix", title: "修复", badge: "fix" },
  { key: "refactor", title: "重构", badge: "refactor" },
  { key: "perf", title: "性能", badge: "perf" },
  { key: "docs", title: "文档", badge: "docs" },
  { key: "other", title: "其他", badge: "other" },
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

/** 从 origin remote 推导 gitlab commit 页 URL 前缀；推导不出返回 null（HTML 降级为纯文本 hash） */
function commitUrlBase(): string | null {
  let url = "";
  try {
    url = git(["remote", "get-url", "origin"]);
  } catch {
    return null;
  }
  // http://gitlab.example.com/zhourusheng/sid-code.git → http://gitlab.example.com/zhourusheng/sid-code/-/commit/
  const m = /^(https?:\/\/[^\s]+?)(?:\.git)?\/?$/.exec(url.trim());
  if (!m) return null;
  return `${m[1]}/-/commit/`;
}

/** 从 origin remote 推导仓库主页 URL（去掉 .git 尾缀）；推导不出返回 null（HTML 页脚降级为纯文本） */
function repoHomeUrl(): string | null {
  let url = "";
  try {
    url = git(["remote", "get-url", "origin"]);
  } catch {
    return null;
  }
  const m = /^(https?:\/\/[^\s]+?)(?:\.git)?\/?$/.exec(url.trim());
  return m ? m[1] : null;
}

interface ParsedCommit {
  group: string;
  scope: string | null;
  desc: string;
  hash: string; // 完整 hash（用于链接）
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

/** 采集某区间的提交（含 body 细节），过滤 bump/merge/dashboard 刷盘等噪声 */
function collectCommits(range: string | null): ParsedCommit[] {
  let raw = "";
  const pretty = `--pretty=format:%H${FS}%h${FS}%s${FS}%b${RS}`;
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
    const [hash = "", shortHash = "", subject = "", body = ""] = rec.split(FS);
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
      desc,
      hash: hash.trim(),
      shortHash: shortHash.trim(),
      details: extractDetails(body),
    });
  }
  return commits;
}

/** 构建完整版本模型：正在发布的版本 + 所有历史 tag（含 genesis） */
function buildModel(currentVersion: string): VersionModel[] {
  const tags = listSemverTags(); // 降序
  const models: VersionModel[] = [];

  // 正在发布的版本（此刻还没 tag）：区间 = 最新 tag..HEAD；无 tag 则全历史
  const newestTag = tags[0] ?? null;
  const currentRange = newestTag ? `${newestTag}..HEAD` : null;
  const currentCommits = collectCommits(currentRange);
  models.push({
    version: currentVersion,
    date: today(),
    commits: currentCommits,
    detailed: currentCommits.length <= MAX_DETAILED_COMMITS,
    isGenesis: !newestTag,
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

// ─────────────────────── Markdown 渲染 ───────────────────────

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

// ─────────────────────── HTML 渲染（自包含,科技风）───────────────────────

function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function renderCommitHtml(c: ParsedCommit, detailed: boolean, urlBase: string | null): string {
  const scopeChip = c.scope
    ? `<span class="scope">${esc(c.scope)}</span>`
    : "";
  const hash =
    c.shortHash && urlBase && c.hash
      ? `<a class="hash" href="${esc(urlBase + c.hash)}" target="_blank" rel="noopener">${esc(c.shortHash)}</a>`
      : c.shortHash
        ? `<span class="hash">${esc(c.shortHash)}</span>`
        : "";

  const hasDetails = detailed && c.details.length > 0;
  const summaryInner = `${scopeChip}<span class="desc">${esc(c.desc)}</span>${hash}`;

  if (!hasDetails) {
    return `<li class="commit"><div class="commit-head">${summaryInner}</div></li>`;
  }

  const detailItems = c.details
    .map((d) => `<li>${esc(d)}</li>`)
    .join("");
  return `<li class="commit has-details">
  <details>
    <summary><span class="chev">▸</span><div class="commit-head">${summaryInner}</div></summary>
    <ul class="details">${detailItems}</ul>
  </details>
</li>`;
}

function renderVersionHtml(v: VersionModel, urlBase: string | null): string {
  const groupBlocks: string[] = [];
  for (const g of GROUPS) {
    const items = v.commits.filter((c) => c.group === g.key);
    if (items.length === 0) continue;
    const commitsHtml = items
      .map((c) => renderCommitHtml(c, v.detailed, urlBase))
      .join("\n");
    groupBlocks.push(`<section class="group" data-group="${g.badge}">
  <h3><span class="badge badge-${g.badge}">${esc(g.title)}</span><span class="count">${items.length}</span></h3>
  <ul class="commits">
${commitsHtml}
  </ul>
</section>`);
  }

  const body =
    groupBlocks.length > 0
      ? groupBlocks.join("\n")
      : `<p class="empty">无显著变更</p>`;

  const genesisTag = v.isGenesis
    ? `<span class="genesis-tag" title="最初版本，汇总早期历史提交（仅列标题）">初始汇总</span>`
    : "";

  return `<article class="version" id="v${esc(v.version)}" data-version="${esc(v.version)}">
  <div class="version-head">
    <span class="dot"></span>
    <h2>v${esc(v.version)}</h2>
    ${genesisTag}
    <time>${esc(v.date)}</time>
    <span class="vcount">${v.commits.length} 项变更</span>
  </div>
  <div class="version-body">
${body}
  </div>
</article>`;
}

function renderHtml(models: VersionModel[], currentVersion: string): string {
  const urlBase = commitUrlBase();
  const repoUrl = repoHomeUrl();
  const totalVersions = models.length;
  const totalCommits = models.reduce((n, v) => n + v.commits.length, 0);
  const generatedAt = today();

  const navLinks = models
    .map(
      (v) =>
        `<a href="#v${esc(v.version)}" class="nav-item"><span class="nav-ver">v${esc(v.version)}</span><span class="nav-date">${esc(v.date)}</span></a>`,
    )
    .join("\n");

  const versionsHtml = models.map((v) => renderVersionHtml(v, urlBase)).join("\n");

  // 自包含：全部 CSS/JS 内联，不依赖 CDN，服务器纯 http 也能离线打开
  return `<!doctype html>
<html lang="zh">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>sid-code · 更新日志</title>
<style>
:root {
  --bg: #f5f7fb;
  --bg-grad-1: rgba(59,108,246,0.06);
  --bg-grad-2: rgba(124,92,246,0.05);
  --panel: #ffffff;
  --panel-2: #fbfcfe;
  --border: #e3e8f0;
  --border-soft: #eef1f6;
  --text: #1a2236;
  --text-dim: #4a5568;
  --text-mute: #8a94a6;
  --brand: #3b6cf6;
  --brand-strong: #2554e0;
  --brand-soft: rgba(59,108,246,0.10);
  --brand-glow: rgba(59,108,246,0.28);
  --shadow-sm: 0 1px 2px rgba(20,30,60,0.04), 0 1px 3px rgba(20,30,60,0.06);
  --shadow-md: 0 4px 16px rgba(20,30,60,0.06), 0 2px 6px rgba(20,30,60,0.05);
  --feat: #1f9d57;   --feat-bg: #e8f7ee;   --feat-bd: #b6e6c9;
  --fix: #d93a54;    --fix-bg: #fdecef;    --fix-bd: #f4c2cc;
  --refactor: #3b6cf6; --refactor-bg: #eaf0fe; --refactor-bd: #c4d5fb;
  --perf: #8250df;   --perf-bg: #f2ecfd;   --perf-bd: #d9c8f5;
  --docs: #0e8a8a;   --docs-bg: #e4f6f5;   --docs-bd: #b6e3e0;
  --other: #64708a;  --other-bg: #eef1f6;  --other-bd: #d6dce6;
  --mono: ui-monospace, "SF Mono", "JetBrains Mono", "Fira Code", Menlo, Consolas, monospace;
  --sans: -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif;
}
* { box-sizing: border-box; }
html { scroll-behavior: smooth; }
body {
  margin: 0;
  font-family: var(--sans);
  color: var(--text);
  background:
    radial-gradient(1200px 620px at 82% -12%, var(--bg-grad-1), transparent 60%),
    radial-gradient(900px 520px at -12% 8%, var(--bg-grad-2), transparent 55%),
    var(--bg);
  background-attachment: fixed;
  line-height: 1.62;
  -webkit-font-smoothing: antialiased;
}
a { color: inherit; text-decoration: none; }

/* ── 顶栏 ── */
header.top {
  position: sticky; top: 0; z-index: 20;
  background: rgba(255,255,255,0.85);
  backdrop-filter: blur(14px);
  border-bottom: 1px solid var(--border);
  padding: 15px 24px;
}
.top-inner { max-width: 1180px; margin: 0 auto; display: flex; align-items: center; gap: 16px; flex-wrap: wrap; }
.brand-mark { display: flex; align-items: center; gap: 10px; font-family: var(--mono); font-size: 18px; font-weight: 700; letter-spacing: 0.3px; }
.brand-mark .cursor { display: inline-block; width: 9px; height: 18px; background: var(--brand); box-shadow: 0 0 10px var(--brand-glow); border-radius: 2px; animation: blink 1.2s steps(1) infinite; }
@keyframes blink { 50% { opacity: 0.28; } }
.brand-mark .name { color: var(--text); }
.brand-mark .sub { color: var(--brand); }
.top-tag { color: var(--text-mute); font-size: 13px; }
.top-stats { margin-left: auto; display: flex; gap: 20px; font-family: var(--mono); font-size: 11px; color: var(--text-mute); }
.top-stats b { color: var(--brand-strong); font-size: 16px; font-weight: 700; }
.top-stats .stat { display: flex; flex-direction: column; align-items: flex-end; line-height: 1.3; }
.search-wrap { flex-basis: 100%; margin-top: 12px; }
#search {
  width: 100%; padding: 10px 15px; border-radius: 11px;
  background: var(--panel); border: 1px solid var(--border); color: var(--text);
  font-family: var(--mono); font-size: 13px; outline: none;
  box-shadow: var(--shadow-sm);
  transition: border-color .15s, box-shadow .15s;
}
#search:focus { border-color: var(--brand); box-shadow: 0 0 0 3px var(--brand-glow); }
#search::placeholder { color: var(--text-mute); }

/* ── 布局 ── */
.layout { max-width: 1180px; margin: 0 auto; display: grid; grid-template-columns: 210px 1fr; gap: 32px; padding: 34px 24px 80px; }

/* ── 侧栏版本导航 ── */
nav.side { position: sticky; top: 100px; align-self: start; max-height: calc(100vh - 128px); overflow-y: auto; }
nav.side .nav-title { font-size: 11px; text-transform: uppercase; letter-spacing: 1px; color: var(--text-mute); margin: 0 0 10px 4px; font-weight: 700; }
.nav-item { display: flex; justify-content: space-between; align-items: baseline; padding: 8px 11px; border-radius: 9px; border-left: 2px solid transparent; transition: background .12s, border-color .12s; }
.nav-item:hover { background: var(--brand-soft); border-left-color: var(--brand); }
.nav-ver { font-family: var(--mono); font-size: 13px; color: var(--text); font-weight: 600; }
.nav-date { font-family: var(--mono); font-size: 10px; color: var(--text-mute); }

/* ── 版本卡 ── */
main.stream { min-width: 0; }
.version { margin-bottom: 26px; }
.version-head { display: flex; align-items: center; gap: 12px; margin-bottom: 14px; }
.version-head .dot { width: 11px; height: 11px; border-radius: 50%; background: var(--brand); box-shadow: 0 0 0 4px var(--brand-soft); flex-shrink: 0; }
.version-head h2 { margin: 0; font-family: var(--mono); font-size: 22px; letter-spacing: 0.3px; color: var(--brand-strong); font-weight: 700; }
.version-head time { font-family: var(--mono); font-size: 12px; color: var(--text-mute); }
.version-head .vcount { margin-left: auto; font-family: var(--mono); font-size: 11px; color: var(--text-dim); background: var(--panel); border: 1px solid var(--border); padding: 3px 10px; border-radius: 999px; box-shadow: var(--shadow-sm); }
.genesis-tag { font-size: 10px; color: var(--other); border: 1px dashed var(--other-bd); padding: 2px 8px; border-radius: 999px; }
.version-body { border: 1px solid var(--border); border-radius: 16px; background: var(--panel); padding: 6px 22px 16px; box-shadow: var(--shadow-md); }

/* ── 分组 ── */
.group { padding: 15px 0; border-bottom: 1px solid var(--border-soft); }
.group:last-child { border-bottom: none; }
.group h3 { margin: 0 0 11px; display: flex; align-items: center; gap: 10px; }
.badge { font-size: 12px; font-weight: 700; padding: 4px 12px; border-radius: 8px; letter-spacing: 0.2px; }
.badge-feat { color: var(--feat); background: var(--feat-bg); border: 1px solid var(--feat-bd); }
.badge-fix { color: var(--fix); background: var(--fix-bg); border: 1px solid var(--fix-bd); }
.badge-refactor { color: var(--refactor); background: var(--refactor-bg); border: 1px solid var(--refactor-bd); }
.badge-perf { color: var(--perf); background: var(--perf-bg); border: 1px solid var(--perf-bd); }
.badge-docs { color: var(--docs); background: var(--docs-bg); border: 1px solid var(--docs-bd); }
.badge-other { color: var(--other); background: var(--other-bg); border: 1px solid var(--other-bd); }
.group .count { font-family: var(--mono); font-size: 11px; color: var(--text-mute); }

/* ── 提交条目 ── */
ul.commits { list-style: none; margin: 0; padding: 0; }
.commit { padding: 4px 0; }
.commit-head { display: inline-flex; align-items: baseline; gap: 9px; flex-wrap: wrap; }
.scope { font-family: var(--mono); font-size: 11px; color: var(--brand-strong); background: var(--brand-soft); padding: 2px 8px; border-radius: 6px; border: 1px solid var(--refactor-bd); font-weight: 600; }
.desc { color: var(--text); font-size: 14.5px; }
.hash { font-family: var(--mono); font-size: 11px; color: var(--text-mute); background: var(--panel-2); border: 1px solid var(--border); padding: 1px 7px; border-radius: 6px; transition: color .12s, border-color .12s, background .12s; }
a.hash:hover { color: var(--brand-strong); border-color: var(--brand); background: var(--brand-soft); }
.commit.has-details details summary { list-style: none; cursor: pointer; display: flex; align-items: baseline; gap: 6px; padding: 3px 0; border-radius: 7px; transition: background .12s; }
.commit.has-details details summary:hover { background: var(--border-soft); }
.commit.has-details details summary::-webkit-details-marker { display: none; }
.commit .chev { color: var(--text-mute); font-size: 11px; transition: transform .15s, color .15s; display: inline-block; }
.commit.has-details details[open] .chev { transform: rotate(90deg); color: var(--brand); }
ul.details { list-style: none; margin: 5px 0 9px; padding: 9px 15px; border-left: 2px solid var(--refactor-bd); margin-left: 6px; background: var(--panel-2); border-radius: 0 8px 8px 0; }
ul.details li { color: var(--text-dim); font-size: 13px; padding: 3px 0; position: relative; padding-left: 15px; line-height: 1.55; }
ul.details li::before { content: "›"; position: absolute; left: 0; color: var(--brand); font-weight: 700; }
.empty { color: var(--text-mute); font-size: 13px; padding: 12px 0; }

/* ── 隐藏（搜索过滤）── */
.hidden { display: none !important; }

/* ── 页脚 ── */
footer.foot { max-width: 1180px; margin: 0 auto; padding: 24px; border-top: 1px solid var(--border); color: var(--text-mute); font-size: 12px; font-family: var(--mono); text-align: center; }
footer.foot a { color: var(--brand); }
footer.foot a:hover { color: var(--brand-strong); text-decoration: underline; }

/* ── 响应式 ── */
@media (max-width: 860px) {
  .layout { grid-template-columns: 1fr; gap: 18px; }
  nav.side { display: none; }
  .top-stats { gap: 14px; }
}
</style>
</head>
<body>

<header class="top">
  <div class="top-inner">
    <div class="brand-mark">
      <span class="cursor"></span>
      <span><span class="name">sid</span><span class="sub">-code</span></span>
    </div>
    <span class="top-tag">更新日志 · Changelog</span>
    <div class="top-stats">
      <div class="stat"><b>v${esc(currentVersion)}</b><span>最新版本</span></div>
      <div class="stat"><b>${totalVersions}</b><span>版本</span></div>
      <div class="stat"><b>${totalCommits}</b><span>变更项</span></div>
    </div>
    <div class="search-wrap">
      <input id="search" type="search" placeholder="搜索变更内容、scope、提交描述…" autocomplete="off" />
    </div>
  </div>
</header>

<div class="layout">
  <nav class="side">
    <p class="nav-title">版本</p>
${navLinks}
  </nav>
  <main class="stream" id="stream">
${versionsHtml}
    <p class="empty hidden" id="no-result">没有匹配的变更</p>
  </main>
</div>

<footer class="foot">
  ${repoUrl ? `<a href="${esc(repoUrl)}" target="_blank" rel="noopener">sid-code</a>` : "sid-code"} · 由 scripts/generate-changelog.ts 自动生成 · ${esc(generatedAt)}
</footer>

<script>
(function () {
  var input = document.getElementById('search');
  var stream = document.getElementById('stream');
  var noResult = document.getElementById('no-result');
  var versions = Array.prototype.slice.call(stream.querySelectorAll('.version'));

  function normalize(s) { return (s || '').toLowerCase(); }

  input.addEventListener('input', function () {
    var q = normalize(input.value.trim());
    var anyVisible = false;

    versions.forEach(function (ver) {
      var groups = ver.querySelectorAll('.group');
      var verHasMatch = false;

      groups.forEach(function (group) {
        var commits = group.querySelectorAll('.commit');
        var groupHasMatch = false;
        commits.forEach(function (c) {
          var text = normalize(c.textContent);
          var match = q === '' || text.indexOf(q) !== -1;
          c.classList.toggle('hidden', !match);
          if (match) groupHasMatch = true;
        });
        group.classList.toggle('hidden', !groupHasMatch);
        if (groupHasMatch) verHasMatch = true;
      });

      ver.classList.toggle('hidden', !verHasMatch);
      if (verHasMatch) anyVisible = true;
    });

    noResult.classList.toggle('hidden', anyVisible);

    // 搜索时自动展开命中的 details，方便直接看到细节
    if (q !== '') {
      stream.querySelectorAll('.commit:not(.hidden) details').forEach(function (d) { d.open = true; });
    }
  });
})();
</script>

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

  writeFileSync(CHANGELOG_MD_PATH, renderMarkdown(models));
  writeFileSync(CHANGELOG_HTML_PATH, renderHtml(models, version));

  const totalCommits = models.reduce((n, v) => n + v.commits.length, 0);
  console.log(
    `  ✅ CHANGELOG.md + CHANGELOG.html 已生成（当前 v${version} ${currentCommitCount} 条 / 全部 ${models.length} 版本 ${totalCommits} 条）`,
  );
}

main();
