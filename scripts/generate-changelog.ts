/**
 * scripts/generate-changelog.ts — 从 git 历史自动生成 changelog
 *
 * 用法：
 *   bun run scripts/generate-changelog.ts <version>
 *
 * 由 release.sh 在 bump 版本号之后、构建之前调用，version 显式传入（与 $VERSION 同源，
 * 不自读 package.json，避免两处版本号漂移）。
 *
 * 生成逻辑：
 *   - 范围：上一个 semver tag（vX.Y.Z）→ HEAD；首次无 tag 则回溯最近 ~50 条提交
 *   - 按 conventional commit 前缀（feat/fix/refactor…）分组，容错半角/全角冒号与可选 scope
 *   - 过滤 bump 记账提交与 merge 提交
 *   - 累积写入仓库根 CHANGELOG.md（新版本块 prepend 到文件头之下），纳入 git 追踪
 *   - 幂等：同版本块已存在则原地替换，保证 --no-bump 重跑 / 上传失败重试安全
 *
 * 退出行为：changelog 生成绝不阻断发布——「无提交」只 warn 不报错，仅 git 命令真正
 *   损坏时才非零退出（release.sh 侧也用 `|| warn` 兜底，双保险）。
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");
const CHANGELOG_PATH = resolve(ROOT, "CHANGELOG.md");

const FILE_HEADER =
  "# Changelog\n\n本文件由 scripts/generate-changelog.ts 自动生成，请勿手改。\n";

const FIRST_RUN_LOOKBACK = 50;

// 单元分隔符：git log 字段分隔，避开 subject 内的 :/— 等字符
const US = "\x1f";

// 分组顺序与中文标题（其余类型统一归入「其他」）
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
const COMMIT_RE = /^(feat|fix|refactor|perf|docs|style|test|build|ci|chore)(?:\(([^)]*)\))?\s*[:：]\s*(.*)$/;

function git(args: string[]): string {
  return execFileSync("git", args, { cwd: ROOT, encoding: "utf-8" }).trim();
}

/** 最新的 semver tag（vX.Y.Z），排除 phase-1-done 等非 semver tag；无则返回 null */
function lastSemverTag(): string | null {
  let out = "";
  try {
    out = git(["tag", "-l", "v*", "--sort=-v:refname"]);
  } catch {
    return null;
  }
  const semver = /^v\d+\.\d+\.\d+$/;
  for (const line of out.split("\n")) {
    const tag = line.trim();
    if (semver.test(tag)) return tag;
  }
  return null;
}

/** 计算 git log 的 range 参数：有 tag → tag..HEAD；首次 → HEAD~N..HEAD */
function resolveRange(): { range: string; firstRun: boolean } {
  const tag = lastSemverTag();
  if (tag) return { range: `${tag}..HEAD`, firstRun: false };

  let count = 0;
  try {
    count = parseInt(git(["rev-list", "--count", "HEAD"]), 10) || 0;
  } catch {
    count = 0;
  }
  const n = Math.min(FIRST_RUN_LOOKBACK, count);
  console.log(`  首次生成 changelog：无历史 tag，回溯最近 ${n} 条提交`);
  // n 条提交 → HEAD~n..HEAD；n 为 0/1 时退化为全历史，避免 HEAD~0 的空范围
  return { range: n > 1 ? `HEAD~${n}..HEAD` : "HEAD", firstRun: true };
}

interface ParsedCommit {
  group: string;
  scope: string | null;
  desc: string;
}

function collectCommits(range: string): ParsedCommit[] {
  let raw = "";
  try {
    raw = execFileSync(
      "git",
      ["log", range, "--no-merges", `--pretty=format:%s${US}`],
      { cwd: ROOT, encoding: "utf-8" },
    );
  } catch (err: any) {
    // git 命令真正损坏（非法 range 等）——抛出让 release.sh 的 || warn 接住
    throw new Error(`git log 失败（range=${range}）: ${err?.message ?? err}`);
  }

  const subjects = raw
    .split(US)
    .map((s) => s.replace(/^\n+/, "").trim())
    .filter(Boolean);

  const commits: ParsedCommit[] = [];
  for (const subject of subjects) {
    // 过滤 bump 记账提交（bump v0.1.581 / bump 0.1.581）与 Merge 提交
    if (/^bump\s+v?\d/i.test(subject)) continue;
    if (/^Merge\s/i.test(subject)) continue;

    const m = COMMIT_RE.exec(subject);
    if (m) {
      const type = m[1];
      const scope = m[2] ? m[2].trim() : null;
      const desc = m[3].trim();
      if (!desc) continue;
      commits.push({ group: TYPE_TO_GROUP[type] ?? "other", scope, desc });
    } else {
      // 无前缀提交：整条归入「其他」
      commits.push({ group: "other", scope: null, desc: subject });
    }
  }
  return commits;
}

function today(): string {
  // release.sh 在真实时钟下调用；此脚本非 workflow 沙箱，Date 可用
  return new Date().toISOString().slice(0, 10);
}

/** 渲染单个版本块（不含末尾多余空行） */
function renderBlock(version: string, commits: ParsedCommit[]): string {
  const lines: string[] = [`## v${version} (${today()})`, ""];

  const isEmpty = commits.length === 0;
  if (isEmpty) {
    lines.push("### 其他", "- 无显著变更", "");
  } else {
    for (const g of GROUPS) {
      const items = commits.filter((c) => c.group === g.key);
      if (items.length === 0) continue;
      lines.push(`### ${g.title}`);
      for (const c of items) {
        lines.push(c.scope ? `- (${c.scope}): ${c.desc}` : `- ${c.desc}`);
      }
      lines.push("");
    }
  }
  return lines.join("\n").trimEnd() + "\n";
}

/**
 * 把新版本块合并进 CHANGELOG.md：
 *   - 文件不存在 → 写文件头 + 新块
 *   - 同版本块已存在 → 原地替换（幂等）
 *   - 否则 → prepend 到文件头之下、旧版本之上
 */
function mergeIntoChangelog(version: string, block: string): void {
  const versionHeadingRe = new RegExp(
    `^## v${version.replace(/\./g, "\\.")} `,
    "m",
  );

  if (!existsSync(CHANGELOG_PATH)) {
    writeFileSync(CHANGELOG_PATH, `${FILE_HEADER}\n${block}`);
    return;
  }

  const existing = readFileSync(CHANGELOG_PATH, "utf-8");

  // 拆出文件头（第一处 "## " 之前的内容）与版本区
  const firstVersionIdx = existing.search(/^## /m);
  const header = firstVersionIdx >= 0 ? existing.slice(0, firstVersionIdx) : existing;
  let body = firstVersionIdx >= 0 ? existing.slice(firstVersionIdx) : "";

  if (versionHeadingRe.test(body)) {
    // 幂等替换：定位本版本块 [start, nextVersionStart)
    const start = body.search(versionHeadingRe);
    const after = body.slice(start + 1);
    const nextRel = after.search(/^## /m);
    const end = nextRel >= 0 ? start + 1 + nextRel : body.length;
    body = body.slice(0, start) + block + "\n" + body.slice(end);
  } else {
    body = `${block}\n${body}`;
  }

  const normalizedHeader = header.length > 0 ? header.replace(/\n*$/, "\n\n") : `${FILE_HEADER}\n`;
  writeFileSync(CHANGELOG_PATH, normalizedHeader + body.replace(/\n*$/, "\n"));
}

function main(): void {
  const version = process.argv[2]?.trim();
  if (!version) {
    console.error("用法: bun run scripts/generate-changelog.ts <version>");
    process.exit(1);
  }

  const { range } = resolveRange();
  const commits = collectCommits(range);

  if (commits.length === 0) {
    console.log(`  ⚠️  范围 ${range} 无可归类提交，写入最小版本块（- 无显著变更）`);
  }

  const block = renderBlock(version, commits);
  mergeIntoChangelog(version, block);
  console.log(`  ✅ CHANGELOG.md 已更新（v${version}，${commits.length} 条提交）`);
}

main();
