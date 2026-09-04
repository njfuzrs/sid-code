#!/usr/bin/env bun
/**
 * fetch-vendor-src.ts — 构建时准备 vendor 源码目录（不入库的第三方代码）
 *
 * 为什么存在：`packages/tui-renderer/src/` 与
 * `packages/cli/src/command/commands/claude-api/reference/` **不入库**（见 .gitignore），
 * 但它们是**编译期依赖**：
 *   · 前者被 `packages/cli/src` 下 102 个文件按 `@sid-code/tui-renderer/*` 导入；
 *   · 后者被 `claude-api.ts` 用 Bun 的 `with { type: "text" }` 内联进单二进制。
 * 因此 fresh clone / CI 上必须先把它们取回来，否则 `bun test` 与 `make build` 都跑不起来
 * —— 实测新仓首批 CI 全红就是这个原因（`Cannot find module '@sid-code/tui-renderer/stringWidth.ts'`）。
 *
 * 机制与 `fetch-ripgrep.ts` **完全同源**（刻意照抄那套先例，不另创一套）：
 *   1. 本地已有该目录 → 直接复用，全程不联网。这是本机开发的默认路径。
 *   2. 缺失时回退联网下载 tar.gz + sha256 校验 → 解包到仓库内规范路径。
 *
 * 服务器布局（nginx root=/var/www/html，与 ripgrep 并列）：
 *   https://www.sid-code.cc/vendor-bin/tui-renderer/<version>/tui-renderer-src-<version>.tar.gz
 *   https://www.sid-code.cc/vendor-bin/tui-renderer/<version>/tui-renderer-src-<version>.tar.gz.sha256
 *
 * 用法：
 *   bun run scripts/fetch-vendor-src.ts               # 缺失则下载，已有则跳过
 *   bun run scripts/fetch-vendor-src.ts --force       # 强制重新下载覆盖
 *   bun run scripts/fetch-vendor-src.ts --check       # 只检查是否齐全，不下载（退出码 0/1）
 *   bun run scripts/fetch-vendor-src.ts --pack        # 反向：把本地目录打包成可上传的 tar.gz
 *   bun run scripts/fetch-vendor-src.ts --print-version
 *
 * 环境变量：
 *   SID_VENDOR_SRC_BASE_URL  下载根地址（默认 <PUBLIC_BASE_URL>/vendor-bin/tui-renderer）
 *   SID_VENDOR_SRC_VERSION   版本（默认见 DEFAULT_VERSION）
 *   PUBLIC_BASE_URL          对外访问地址（与 release.sh / fetch-ripgrep.ts 同名同义）
 *
 * ⚠️ 更新这批 vendor 源码时：改动本地文件 → `--pack` → 上传到服务器新版本目录
 *    → 改 DEFAULT_VERSION → 提交。**不要覆盖已发布版本的 tar.gz**：
 *    已有 CI 缓存与他人本机可能仍在引用它，覆盖会让"同一版本号两份内容"，
 *    而 sha256 校验会把这件事变成一片红。
 */

import { existsSync, statSync } from "node:fs";
import { mkdir, writeFile, rm } from "node:fs/promises";
import { dirname, join } from "node:path";

const ROOT = join(dirname(new URL(import.meta.url).pathname), "..");

/**
 * 打包内容的版本。改这里 = 换一份 vendor 源码快照。
 * 用日期而非语义版本：这批文件不是我们维护的库，没有"语义"可言，只有"哪天的快照"。
 */
const DEFAULT_VERSION = "20260904";
const DEFAULT_PUBLIC_BASE_URL = "https://www.sid-code.cc";

/**
 * 需要取回的目录清单（相对仓库根）。
 *
 * ⚠️ 与 .gitignore 里那两条**必须一致**。加一条不入库目录就要同步这里，
 * 否则 CI 会在"某个模块解析不到"上失败，而错误信息完全指不到这个清单。
 */
const VENDOR_DIRS = [
  "packages/tui-renderer/src",
  "packages/cli/src/command/commands/claude-api/reference",
] as const;

function resolveVersion(): string {
  return process.env.SID_VENDOR_SRC_VERSION?.trim() || DEFAULT_VERSION;
}

function resolveBaseUrl(): string {
  const explicit = process.env.SID_VENDOR_SRC_BASE_URL?.trim();
  if (explicit) return explicit.replace(/\/$/, "");
  const publicBase = (process.env.PUBLIC_BASE_URL?.trim() || DEFAULT_PUBLIC_BASE_URL).replace(
    /\/$/,
    "",
  );
  return `${publicBase}/vendor-bin/tui-renderer`;
}

function sha256Hex(bytes: Uint8Array): string {
  const hasher = new Bun.CryptoHasher("sha256");
  hasher.update(bytes);
  return hasher.digest("hex");
}

/** 目录存在且非空才算"已有"。空目录会让 grep/scandir 静默返回 0 命中，比不存在更危险。 */
function dirPresent(rel: string): boolean {
  const abs = join(ROOT, rel);
  if (!existsSync(abs)) return false;
  try {
    if (!statSync(abs).isDirectory()) return false;
    return [...new Bun.Glob("**/*").scanSync(abs)].length > 0;
  } catch {
    return false;
  }
}

function reportPresence(): { missing: string[]; present: string[] } {
  const missing: string[] = [];
  const present: string[] = [];
  for (const d of VENDOR_DIRS) (dirPresent(d) ? present : missing).push(d);
  return { missing, present };
}

async function runTar(args: string[], cwd: string): Promise<void> {
  const proc = Bun.spawn(["tar", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  const code = await proc.exited;
  if (code !== 0) {
    const err = await new Response(proc.stderr).text();
    throw new Error(`tar ${args.join(" ")} 失败（exit ${code}）: ${err.trim()}`);
  }
}

/** 反向操作：把本地目录打包成可上传的 tar.gz + .sha256。 */
async function pack(version: string): Promise<void> {
  const { missing } = reportPresence();
  if (missing.length > 0) {
    throw new Error(`本地缺少这些目录，无法打包:\n  ${missing.join("\n  ")}`);
  }
  const name = `tui-renderer-src-${version}.tar.gz`;
  const out = join("/tmp", name);
  // 确定性打包：清零 owner、固定 ustar 格式，保证同内容同 sha256
  await runTar(
    [
      "--numeric-owner",
      "--owner=0",
      "--group=0",
      "--format=ustar",
      "--no-mac-metadata",
      "-czf",
      out,
      ...VENDOR_DIRS,
    ],
    ROOT,
  );
  const bytes = new Uint8Array(await Bun.file(out).arrayBuffer());
  const sha = sha256Hex(bytes);
  await writeFile(`${out}.sha256`, `${sha}\n`);
  console.log(`  ✓ 已打包 ${out}（${(bytes.byteLength / 1024).toFixed(0)} KB）`);
  console.log(`  sha256: ${sha}`);
  console.log(`\n上传（照 ripgrep 的路子，走 scripts/deploy.env 的凭据）：`);
  console.log(
    `  scp ${out}{,.sha256} <user>@<host>:/var/www/html/vendor-bin/tui-renderer/${version}/`,
  );
}

async function download(version: string, baseUrl: string, force: boolean): Promise<void> {
  const { missing, present } = reportPresence();

  if (missing.length === 0 && !force) {
    for (const d of present) console.log(`  ✓ ${d} 本地已有，跳过下载`);
    return;
  }

  const name = `tui-renderer-src-${version}.tar.gz`;
  const tarUrl = `${baseUrl}/${version}/${name}`;
  const shaUrl = `${tarUrl}.sha256`;

  let expectedSha: string | null = null;
  try {
    const shaResp = await fetch(shaUrl);
    if (shaResp.ok) {
      expectedSha = (await shaResp.text()).trim().split(/\s+/)[0]?.toLowerCase() ?? null;
    }
  } catch {
    // .sha256 拉不到不致命，下面按无校验处理并明确告警
  }

  console.log(`  ↓ 下载 ${tarUrl} ...`);
  const resp = await fetch(tarUrl);
  if (!resp.ok) {
    throw new Error(
      `下载失败 ${tarUrl}: HTTP ${resp.status}。\n` +
        `请确认服务器上已上传该版本（用 --pack 打包后 scp 到 vendor-bin/tui-renderer/${version}/）。`,
    );
  }
  const bytes = new Uint8Array(await resp.arrayBuffer());
  if (bytes.byteLength === 0) throw new Error(`下载到空文件 ${tarUrl}`);

  if (expectedSha) {
    const actual = sha256Hex(bytes);
    if (actual !== expectedSha) {
      throw new Error(`sha256 校验失败: 期望 ${expectedSha}，实际 ${actual}`);
    }
    console.log(`  ✓ sha256 校验通过`);
  } else {
    console.log(`  ⚠️  无 .sha256 校验文件，跳过完整性校验`);
  }

  const tmp = join("/tmp", name);
  await mkdir(dirname(tmp), { recursive: true });
  await writeFile(tmp, bytes);

  // force 时先清掉旧目录，避免新旧文件混在一起（删了文件的新版本会留下孤儿）
  if (force) {
    for (const d of VENDOR_DIRS) await rm(join(ROOT, d), { recursive: true, force: true });
  }

  await runTar(["-xzf", tmp], ROOT);
  await rm(tmp, { force: true });

  const after = reportPresence();
  if (after.missing.length > 0) {
    throw new Error(
      `解包后仍缺少这些目录（tar 包内容与 VENDOR_DIRS 不一致？）:\n  ${after.missing.join("\n  ")}`,
    );
  }
  for (const d of VENDOR_DIRS) {
    const n = [...new Bun.Glob("**/*").scanSync(join(ROOT, d))].length;
    console.log(`  ✓ ${d}（${n} 个文件）`);
  }
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const version = resolveVersion();

  if (argv.includes("--print-version")) {
    console.log(version);
    return;
  }

  if (argv.includes("--check")) {
    const { missing, present } = reportPresence();
    for (const d of present) console.log(`  ✓ ${d}`);
    for (const d of missing) console.log(`  ✗ ${d} 缺失`);
    if (missing.length > 0) {
      console.error(`\nvendor 源码不齐（缺 ${missing.length} 个）。跑 bun run vendor:fetch 取回。`);
      process.exit(1);
    }
    console.log(`vendor 源码齐全（version=${version}）。`);
    return;
  }

  if (argv.includes("--pack")) {
    await pack(version);
    return;
  }

  console.log(`fetch-vendor-src: version=${version} baseUrl=${resolveBaseUrl()}`);
  await download(version, resolveBaseUrl(), argv.includes("--force"));
}

await main();
