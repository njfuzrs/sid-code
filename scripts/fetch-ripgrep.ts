#!/usr/bin/env bun
/**
 * fetch-ripgrep.ts — 构建时准备预编译 ripgrep 二进制到 vendor/
 *
 * 只在**构建时**运行；运行时二进制已嵌入产物、不联网（见 src/tool/rg-embedded.ts）。
 *
 * 查找优先级（每个平台独立判断）：
 *   1. 仓库内规范路径 vendor/ripgrep/<version>/rg-<platform>（已 git 提交，随 clone 直接可用）——
 *      命中则直接使用，全程不联网。这是团队协作/CI 的默认路径。
 *   2. 缺失时回退联网下载（公司服务器），下载结果直接落到上述规范路径 —— 下载一次后，
 *      文件已经躺在该 `git add` 的位置，供后续提交入库，团队其他人无需再各自联网。
 *
 * 平台标识与 release.sh 的打包后缀对齐：darwin-arm64 / darwin-x64 / linux-x64 / linux-arm64。
 * 服务器布局（nginx root=/var/www/html，仅作为仓库内文件缺失时的回退/首次填充来源）：
 *   http://<host>/vendor-bin/ripgrep/<version>/rg-<platform>
 *   http://<host>/vendor-bin/ripgrep/<version>/rg-<platform>.sha256
 * 与 releases 版本目录隔离，不被 release.sh 的旧版本清理逻辑误删。
 *
 * 用法：
 *   bun run scripts/fetch-ripgrep.ts                 # 准备当前平台到 vendor/ripgrep/<version>/rg-<platform>
 *   bun run scripts/fetch-ripgrep.ts --as-embed      # 准备当前平台并落成 vendor/rg-embed（供 make build）
 *   bun run scripts/fetch-ripgrep.ts --platform=linux-x64
 *   bun run scripts/fetch-ripgrep.ts --all           # 准备全部 4 平台（供 release.sh 交叉编译）
 *   bun run scripts/fetch-ripgrep.ts --print-version # 仅打印解析后的版本号（供 shell 脚本读取，避免版本号硬编码漂移）
 *
 * 环境变量：
 *   SID_RG_BASE_URL   下载根地址（默认 http://<DEPLOY_SSH_HOST>/vendor-bin/ripgrep）
 *   SID_RG_VERSION    ripgrep 版本（默认见 DEFAULT_RG_VERSION）
 *   DEPLOY_SSH_HOST   服务器地址（与 deploy.env 一致，默认 121.196.144.227）
 *
 * 升级 ripgrep 版本时：改下面的 DEFAULT_RG_VERSION → 跑 `--all`（联网下载新版本到规范路径）
 * → `git add vendor/ripgrep/<新版本>/` 提交（可选 `git rm` 旧版本目录避免仓库无限膨胀）
 * → 可选 `release.sh --upload-ripgrep` 同步一份到服务器作为团队协作的备用源。
 */

import { mkdir, writeFile, copyFile, chmod } from "node:fs/promises";
import { existsSync, statSync } from "node:fs";
import { join, dirname } from "node:path";

const ROOT = join(dirname(new URL(import.meta.url).pathname), "..");
const VENDOR_DIR = join(ROOT, "vendor");

/** 支持的平台（与 release.sh TARGETS 的打包后缀一致） */
const ALL_PLATFORMS = ["darwin-arm64", "darwin-x64", "linux-x64", "linux-arm64"] as const;
type Platform = (typeof ALL_PLATFORMS)[number];

/**
 * 默认嵌入的 ripgrep 版本（升级时改这里，并按上方说明补齐 vendor/ripgrep/<新版本>/）。
 *
 * 14.1.1 → 15.1.0（2026-07-09）：14.1.1 在 macOS aarch64 上动态链接 PCRE2
 * （运行时报 `Library not loaded: /opt/homebrew/opt/pcre2/...`，没装 Homebrew
 * pcre2 的机器直接崩溃，违背"摆脱环境依赖"的初衷）。该 bug 于 15.0.0 修复
 * （BurntSushi/ripgrep #3155：statically compile PCRE2 into macOS aarch64 artifacts）。
 * 15.1.0 是当前最新稳定版。
 */
const DEFAULT_RG_VERSION = "15.1.0";

/** 仓库内规范存放路径：vendor/ripgrep/<version>/rg-<platform>（已 git 提交） */
function repoPath(platform: Platform, version: string): string {
  return join(VENDOR_DIR, "ripgrep", version, `rg-${platform}`);
}

function getBaseUrl(): string {
  const explicit = process.env.SID_RG_BASE_URL?.trim();
  if (explicit) return explicit.replace(/\/+$/, "");
  const host = process.env.DEPLOY_SSH_HOST?.trim() || "121.196.144.227";
  return `http://${host}/vendor-bin/ripgrep`;
}

/** 当前机器对应的平台标识 */
function selfPlatform(): Platform {
  const os = process.platform === "darwin" ? "darwin" : process.platform === "linux" ? "linux" : null;
  const arch = process.arch === "arm64" ? "arm64" : process.arch === "x64" ? "x64" : null;
  if (!os || !arch) {
    throw new Error(`不支持的平台: ${process.platform}/${process.arch}`);
  }
  return `${os}-${arch}` as Platform;
}

function sha256Hex(bytes: Uint8Array): string {
  const hasher = new Bun.CryptoHasher("sha256");
  hasher.update(bytes);
  return hasher.digest("hex");
}

/**
 * 准备单个平台的 rg 到仓库规范路径 vendor/ripgrep/<version>/rg-<platform>。
 * 仓库内已有该文件（已提交入库）则直接复用，全程不联网；否则联网下载并落到该路径。
 * 返回落盘路径。
 */
async function fetchOne(platform: Platform, version: string, baseUrl: string): Promise<string> {
  const dest = repoPath(platform, version);

  // 优先级 1：仓库内规范路径已有该文件（已 git 提交），直接使用，全程不联网。
  if (existsSync(dest)) {
    console.log(`  ✓ ${platform} 命中仓库内文件（已入库），跳过下载`);
    return dest;
  }

  // 优先级 2：回退联网下载
  const binUrl = `${baseUrl}/${version}/rg-${platform}`;
  const shaUrl = `${binUrl}.sha256`;

  let expectedSha: string | null = null;
  try {
    const shaResp = await fetch(shaUrl);
    if (shaResp.ok) {
      expectedSha = (await shaResp.text()).trim().split(/\s+/)[0]?.toLowerCase() ?? null;
    }
  } catch {
    // .sha256 拉取失败不致命，下面按无校验处理
  }

  console.log(`  ↓ 下载 ${binUrl} ...`);
  const resp = await fetch(binUrl);
  if (!resp.ok) {
    throw new Error(
      `下载失败 ${binUrl}: HTTP ${resp.status}。` +
        `请确认服务器上已上传该平台/版本的 rg（用 release.sh --upload-ripgrep 上传）。`,
    );
  }
  const bytes = new Uint8Array(await resp.arrayBuffer());

  if (bytes.byteLength === 0) {
    throw new Error(`下载到空文件 ${binUrl}`);
  }

  // 校验 sha256（有期望值时）
  if (expectedSha) {
    const actualSha = sha256Hex(bytes);
    if (actualSha !== expectedSha) {
      throw new Error(`sha256 校验失败 ${platform}: 期望 ${expectedSha}，实际 ${actualSha}`);
    }
  } else {
    console.log(`  ⚠️  ${platform} 无 .sha256 校验文件，跳过完整性校验`);
  }

  await mkdir(dirname(dest), { recursive: true });
  await writeFile(dest, bytes);
  await chmod(dest, 0o755);
  console.log(`  ✓ ${platform} → ${dest}（${bytes.byteLength} 字节，记得 git add 提交入库）`);
  return dest;
}

async function main() {
  const args = process.argv.slice(2);
  const asEmbed = args.includes("--as-embed");
  const all = args.includes("--all");
  const printVersion = args.includes("--print-version");
  const platformArg = args.find((a) => a.startsWith("--platform="))?.split("=")[1];

  const version = process.env.SID_RG_VERSION?.trim() || DEFAULT_RG_VERSION;

  if (printVersion) {
    console.log(version);
    return;
  }

  const baseUrl = getBaseUrl();

  console.log(`fetch-ripgrep: version=${version} baseUrl=${baseUrl}`);

  await mkdir(VENDOR_DIR, { recursive: true });

  if (all) {
    for (const p of ALL_PLATFORMS) {
      await fetchOne(p, version, baseUrl);
    }
    console.log("  全部平台 rg 就绪");
    return;
  }

  const platform = (platformArg as Platform) || selfPlatform();
  if (!ALL_PLATFORMS.includes(platform)) {
    throw new Error(`未知平台: ${platform}。支持: ${ALL_PLATFORMS.join(", ")}`);
  }

  const dest = await fetchOne(platform, version, baseUrl);

  // --as-embed：落成固定 import 路径 vendor/rg-embed（供 make build / bun build --compile）。
  // 该文件是纯本地构建产物，不入库；缺失来源时保底写 0 字节占位，保证 bun build --compile 不因缺文件报错。
  if (asEmbed) {
    const embedPath = join(VENDOR_DIR, "rg-embed");
    await copyFile(dest, embedPath);
    await chmod(embedPath, 0o755);
    console.log(`  ✓ 已落成嵌入占位 → ${embedPath}`);
  }
}

main().catch(async (err) => {
  console.error(`  ❌ ${err instanceof Error ? err.message : String(err)}`);
  // --as-embed 场景下拉取失败时，必须把 vendor/rg-embed **无条件截断为 0 字节**。
  //
  // ⚠ 这里原先是 `if (!existsSync(embedPath))`——只在文件缺失时兜底。那个条件有个致命
  // 缺口：release.sh 的 4 平台循环跑完会在这个固定路径上残留**最后一个 target**
  // （linux-arm64）的二进制。此后在 mac 上跑 make build，若 --as-embed 失败
  //（Makefile 那行有前导 `-`，失败被 make 忽略），文件是"存在"的于是兜底不触发，
  // 于是一个 Linux rg 被嵌进 mac 产物。运行时不报错，只在 probeRg 探测失败后静默
  // 降级回系统 rg——极难发现。
  //
  // 正确语义是「本次没能准备好 rg」而不是「文件在不在」：拉取失败就该把这个共享的
  // 可变状态清空，让产物明确退化为设计内的"无内嵌 rg"，而不是继承上一次的脏值。
  if (process.argv.slice(2).includes("--as-embed")) {
    const embedPath = join(VENDOR_DIR, "rg-embed");
    await mkdir(VENDOR_DIR, { recursive: true });
    const hadStale = existsSync(embedPath) && statSync(embedPath).size > 0;
    await writeFile(embedPath, new Uint8Array(0));
    if (hadStale) {
      console.error(
        `  ⚠️  已清空 ${embedPath}（原有内容来源不明，可能是上次 release.sh 循环残留的其它平台二进制，` +
          `继承它会把错平台 rg 嵌进本次产物）`,
      );
    } else {
      console.error(`  ⚠️  已写入 0 字节兜底 → ${embedPath}（本次产物不含内嵌 rg，运行时回退系统 rg）`);
    }
  }
  process.exit(1);
});
