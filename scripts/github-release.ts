/**
 * scripts/github-release.ts — 从 curated 文案生成 GitHub Release 正文，并（可选）建 Release。
 *
 * 用法：
 *   bun run scripts/github-release.ts 0.1.601            # 只打印正文到 stdout（干跑）
 *   bun run scripts/github-release.ts 0.1.601 --create    # 真建 Release（幂等：已存在则跳过）
 *   bun run scripts/github-release.ts 0.1.601 --create --force  # 已存在则覆盖正文
 *   bun run scripts/github-release.ts 0.1.601 --create --prerelease  # beta 通道：建成 pre-release
 *   bun run scripts/github-release.ts 0.1.601 --promote   # 促升：改成正式 + Latest，正文换成稳定版说明
 *
 * ── 通道标记（T2，2026-10-09）──
 *   `--upload` 只把版本发到 beta 通道，但以前这里建的是**正式** Release
 *   （v0.1.607 实测 `isPrerelease=false`），外部读者会以为它已经正式发布。
 *   现在 `--upload` 带 `--prerelease`，正文顶部加一行「beta 预发布」；
 *   `--promote` 才把**目标版本**改为正式 + Latest，正文换成合并了跳过版本的稳定版说明
 *   （`changelog/curated/stable/v<ver>.json`，没有该文件即快车道，用原 curated）。
 *   区间内被跳过的版本保持 pre-release 不动 —— 它们确实只在 beta 存在过。
 *
 * ── 为什么需要这个脚本（补的是一个真实缺口）──
 *   发布流程原本**从来没有**建 GitHub Release 这一步：`release.sh` 里 `gh release` 零命中，
 *   六个 workflow 也都没有。仓库现有的 v0.1.591…v0.1.600 那 10 个 Release 全部创建于
 *   **2026-08-13T02:22 那两分钟内**（时间戳间隔 2 秒）—— 是开源首发时一次性人工回填的，
 *   之后再没人补过。所以 v0.1.601 缺 Release 不是某次操作漏了，是流程里没有这个环节。
 *
 * ── 为什么正文取自 curated 而不是 CHANGELOG.md ──
 *   Release 页的读者是**用户**，与官网 /changelog 同一批人。CHANGELOG.md 是全量原始提交
 *   （含 docs/chore 分组、含 hash），给 diff 与脚本用的。回填那 10 个 Release 时用的也是
 *   curated 那套分组（对照 v0.1.600 的 body 可见），这里保持同一个事实源。
 *
 * ── 为什么单独成脚本而不是在 release.sh 里拼 shell ──
 *   正文要读 JSON、按受控词表排序、做 URL 脱敏。这些逻辑
 *   `changelog-curated-schema.ts` 已经有了（`toRenderSections` / `validateCurated`），
 *   在 shell 里用 jq 重写一遍等于开第二套实现 —— 而两套实现分叉的症状是
 *   「官网显示的分组顺序与 Release 页不一致」，且完全静默。
 *
 * ⚠ **不上传制品附件**。制品发在自建服务器（`PUBLIC_BASE_URL/releases/sid-code/`），
 *   Release 页只承载更新说明 —— 与现有 10 个 Release 一致（它们的 assets 都是 0 个）。
 *   两处都放二进制会出现「用户从 GitHub 下到一个版本、install.sh 装到另一个」的双轨问题。
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { ROOT } from "./lib/changelog-git.ts";
import {
  validateCurated,
  toRenderSections,
  type CuratedEntry,
} from "./lib/changelog-curated-schema.ts";
import { stripUrls } from "./lib/changelog-text.ts";

const CURATED_DIR = resolve(ROOT, "changelog/curated");
const STABLE_DIR = resolve(CURATED_DIR, "stable");

/** beta 预发布 Release 正文首行（契约测试锚这句话） */
export const BETA_BANNER = "> beta 预发布，未进入稳定通道。";
/** 与 release.sh / fetch-ripgrep.ts 同名同义，默认值也保持一致 */
const PUBLIC_BASE_URL = process.env.PUBLIC_BASE_URL || "https://www.sid-code.cc";

/**
 * 读并校验 curated 文案。**缺失或不合规一律返回 null**，由调用方决定是否阻断。
 *
 * 与 generate-changelog.ts 的 loadCurated 是同一套判据（都走 validateCurated），
 * 刻意不共享函数体：那边缺失时要「按无变更说明渲染」继续跑，这边缺失时应该
 * **什么都不建** —— 建一个正文为空的 Release 比不建更糟（用户看到一个空版本页，
 * 且没有任何信号说明它是残缺的）。
 */
function loadCurated(version: string, dir: string = CURATED_DIR): CuratedEntry | null {
  const p = resolve(dir, `v${version}.json`);
  if (!existsSync(p)) {
    console.error(`  ❌ 缺 curated 文案：${p}`);
    console.error(`     先跑：bun run changelog:curate ${version}`);
    return null;
  }
  let obj: unknown;
  try {
    obj = JSON.parse(readFileSync(p, "utf-8"));
  } catch (err: any) {
    console.error(`  ❌ curated/v${version}.json 解析失败：${err?.message ?? err}`);
    return null;
  }
  const errs = validateCurated(obj, version);
  if (errs.length > 0) {
    console.error(`  ❌ curated/v${version}.json 不合规：`);
    for (const e of errs) console.error(`     · ${e}`);
    return null;
  }
  return obj as CuratedEntry;
}

/**
 * 渲染 Release 正文。形态**照抄 v0.1.600 那个已有的 Release**
 * （加粗 highlight → `### 分组` → `---` → 完整日志链接 + 安装命令），
 * 好让 Release 列表翻下去时前后版本长得一样。
 *
 * `stripUrls` 兜底的理由与 generate-changelog.ts 里那处相同：curated 文案走的是同一条
 * 通路发到公网，而 agent 读 diff 时会看到内网地址与 IP，可能原样抄进文案。
 * 校验器（入库前拦）与这里（渲染期兜底）看似重复，但人工编辑 curated JSON 时不过校验器。
 */
export function renderReleaseBody(
  entry: CuratedEntry,
  opts: { prerelease?: boolean; covers?: string[] } = {},
): string {
  const out: string[] = [];

  if (opts.prerelease) out.push(BETA_BANNER, "");
  if (opts.covers && opts.covers.length > 1) {
    const skipped = opts.covers.filter((v) => v !== entry.version).map((v) => `v${v}`);
    out.push(`本次稳定版合并了 beta 期的 ${skipped.join("、")} 的变更。`, "");
  }
  if (entry.betaOnly && entry.betaNote) {
    out.push(`beta 修复：${stripUrls(entry.betaNote)}`, "");
  }

  if (entry.highlight) {
    out.push(`**${stripUrls(entry.highlight)}**`, "");
  }

  if (!entry.userFacing && !entry.betaOnly) {
    // userFacing:false 是一个**合法结论**（纯内部版本），不要为了填满而编内容。
    out.push("本版没有用户可见的变更（内部改进与维护）。", "");
  }

  for (const sec of toRenderSections(entry.sections)) {
    out.push(`### ${sec.title}`, "");
    for (const item of sec.items) out.push(`- ${stripUrls(item)}`);
    out.push("");
  }

  out.push(
    "---",
    `完整更新日志：${PUBLIC_BASE_URL}/changelog`,
    "",
    "安装 / 升级：",
    "```bash",
    `curl -fsSL ${PUBLIC_BASE_URL}/releases/sid-code/install.sh | bash`,
    "sid-code update   # 已安装过则直接升级",
    "```",
  );

  return out.join("\n");
}

function gh(args: string[]): string {
  return execFileSync("gh", args, { cwd: ROOT, encoding: "utf-8" }).trim();
}

/**
 * Release 是否已存在。`gh release view` 不存在时退出码非 0，用它做判据。
 *
 * `stdio` 里把 stderr 吞掉：不存在是**预期分支**，而 gh 会往 stderr 打
 * `release not found`。不吞的话终端上会出现一行看着像错误的输出，
 * 紧跟着又是「✅ 已创建」—— 读的人会以为发生了什么问题。
 */
function releaseExists(tag: string): boolean {
  try {
    execFileSync("gh", ["release", "view", tag, "--json", "tagName"], {
      cwd: ROOT,
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * tag 必须已存在于远端：Release 挂在 tag 上，tag 没推上去时 gh 会自己建一个
 * 指向默认分支 HEAD 的 tag —— 那会让 Release 指向错误的提交，且不报错。
 */
function requireRemoteTag(tag: string): void {
  try {
    gh(["api", `repos/{owner}/{repo}/git/ref/tags/${tag}`, "--jq", ".ref"]);
  } catch {
    console.error(`  ❌ 远端没有 tag ${tag}。先 git push origin ${tag} 再建 Release`);
    console.error(
      `     （不然 gh 会自建一个指向默认分支 HEAD 的 tag，Release 指向错误提交且不报错）`,
    );
    process.exit(1);
  }
}

function main(): void {
  const argv = process.argv.slice(2);
  const version = argv.find((a) => /^\d+\.\d+\.\d+$/.test(a));
  if (!version) {
    console.error(
      "用法: bun run scripts/github-release.ts <version> [--create [--prerelease] [--force] | --promote]",
    );
    console.error("  不加 --create 只打印正文（干跑），不碰 GitHub。");
    process.exit(1);
  }
  const create = argv.includes("--create");
  const force = argv.includes("--force");
  const prerelease = argv.includes("--prerelease");
  const promote = argv.includes("--promote");
  const tag = `v${version}`;

  // 促升：正文优先取稳定版说明（多版本合并稿），没有即快车道，用原 curated
  let entry: CuratedEntry | null = null;
  let covers: string[] | undefined;
  if (promote && existsSync(resolve(STABLE_DIR, `v${version}.json`))) {
    entry = loadCurated(version, STABLE_DIR);
    covers = (entry as (CuratedEntry & { covers?: string[] }) | null)?.covers;
  } else {
    entry = loadCurated(version);
  }
  if (!entry) process.exit(1);
  const body = renderReleaseBody(entry, {
    prerelease: prerelease && !promote,
    covers,
  });

  if (promote) {
    // 只作用于目标版本：被跳过的中间号保持 pre-release（它们确实只在 beta 存在过）
    if (releaseExists(tag)) {
      gh(["release", "edit", tag, "--prerelease=false", "--latest", "--notes", body]);
      console.log(`  ✅ Release ${tag} 已改为正式版（Latest），正文换成稳定版说明`);
    } else {
      requireRemoteTag(tag);
      gh(["release", "create", tag, "--title", tag, "--latest", "--notes", body]);
      console.log(`  ✅ Release ${tag} 已按正式版创建（Latest）`);
    }
    return;
  }

  if (!create) {
    console.log(body);
    return;
  }

  requireRemoteTag(tag);

  if (releaseExists(tag)) {
    if (!force) {
      // 幂等：release.sh 可能被重跑，已存在时安静跳过而不是失败。
      console.log(`  ⏭  Release ${tag} 已存在，跳过（要覆盖正文加 --force）`);
      return;
    }
    gh(["release", "edit", tag, "--notes", body, ...(prerelease ? ["--prerelease"] : [])]);
    console.log(`  ✅ Release ${tag} 正文已更新`);
    return;
  }

  // beta 预发布：--latest=false 防止 GitHub 首页把一个 beta 号当「当前版本」展示
  gh([
    "release",
    "create",
    tag,
    "--title",
    tag,
    "--notes",
    body,
    ...(prerelease ? ["--prerelease", "--latest=false"] : []),
  ]);
  console.log(`  ✅ Release ${tag} 已创建${prerelease ? "（pre-release）" : ""}`);
}

// 只在被直接执行时跑；被 import 时（单测 import renderReleaseBody）不能有副作用
if (import.meta.main) {
  try {
    main();
  } catch (err: any) {
    console.error(`  ❌ ${err?.message ?? err}`);
    process.exit(1);
  }
}
