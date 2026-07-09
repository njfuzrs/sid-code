#!/usr/bin/env bun
/**
 * fetch-ripgrep.ts — 构建时从公司服务器下载预编译 ripgrep 二进制到 vendor/
 *
 * 只在**构建时**运行；运行时二进制已嵌入产物、不联网（见 src/tool/rg-embedded.ts）。
 *
 * 平台标识与 release.sh 的打包后缀对齐：darwin-arm64 / darwin-x64 / linux-x64 / linux-arm64。
 * 服务器布局（nginx root=/var/www/html）：
 *   http://<host>/vendor-bin/ripgrep/<version>/rg-<platform>
 *   http://<host>/vendor-bin/ripgrep/<version>/rg-<platform>.sha256
 * 与 releases 版本目录隔离，不被 release.sh 的旧版本清理逻辑误删。
 *
 * 用法：
 *   bun run scripts/fetch-ripgrep.ts                 # 拉当前平台到 vendor/rg-<platform>
 *   bun run scripts/fetch-ripgrep.ts --as-embed      # 拉当前平台并落成 vendor/rg-embed（供 make build）
 *   bun run scripts/fetch-ripgrep.ts --platform=linux-x64
 *   bun run scripts/fetch-ripgrep.ts --all           # 拉全部 4 平台（供 release.sh 交叉编译）
 *
 * 环境变量：
 *   SID_RG_BASE_URL   下载根地址（默认 http://<DEPLOY_SSH_HOST>/vendor-bin/ripgrep）
 *   SID_RG_VERSION    ripgrep 版本（默认见 DEFAULT_RG_VERSION）
 *   DEPLOY_SSH_HOST   服务器地址（与 deploy.env 一致，默认 121.196.144.227）
 *
 * 缓存：目标文件已存在且 sha256 匹配则跳过下载。
 */

import { mkdir, readFile, writeFile, copyFile, chmod } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, dirname } from "node:path";

const ROOT = join(dirname(new URL(import.meta.url).pathname), "..");
const VENDOR_DIR = join(ROOT, "vendor");

/** 支持的平台（与 release.sh TARGETS 的打包后缀一致） */
const ALL_PLATFORMS = ["darwin-arm64", "darwin-x64", "linux-x64", "linux-arm64"] as const;
type Platform = (typeof ALL_PLATFORMS)[number];

/**
 * 默认嵌入的 ripgrep 版本（升级时改这里，并把对应二进制上传服务器）。
 *
 * 14.1.1 → 15.1.0（2026-07-09）：14.1.1 在 macOS aarch64 上动态链接 PCRE2
 * （运行时报 `Library not loaded: /opt/homebrew/opt/pcre2/...`，没装 Homebrew
 * pcre2 的机器直接崩溃，违背"摆脱环境依赖"的初衷）。该 bug 于 15.0.0 修复
 * （BurntSushi/ripgrep #3155：statically compile PCRE2 into macOS aarch64 artifacts）。
 * 15.1.0 是当前最新稳定版。
 */
const DEFAULT_RG_VERSION = "15.1.0";

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
 * 下载单个平台的 rg 到 vendor/rg-<platform>。
 * 已存在且 sha256 匹配则跳过。返回落盘路径。
 */
async function fetchOne(platform: Platform, version: string, baseUrl: string): Promise<string> {
  const dest = join(VENDOR_DIR, `rg-${platform}`);
  const binUrl = `${baseUrl}/${version}/rg-${platform}`;
  const shaUrl = `${binUrl}.sha256`;

  // 先取期望 sha256（远端 .sha256 文件，内容为 hex，可含文件名）
  let expectedSha: string | null = null;
  try {
    const shaResp = await fetch(shaUrl);
    if (shaResp.ok) {
      expectedSha = (await shaResp.text()).trim().split(/\s+/)[0]?.toLowerCase() ?? null;
    }
  } catch {
    // .sha256 拉取失败不致命，下面按无校验处理
  }

  // 缓存命中：本地已有且哈希匹配则跳过
  if (existsSync(dest) && expectedSha) {
    const localSha = sha256Hex(await readFile(dest));
    if (localSha === expectedSha) {
      console.log(`  ✓ ${platform} 已是最新（sha 匹配），跳过下载`);
      return dest;
    }
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

  await mkdir(VENDOR_DIR, { recursive: true });
  await writeFile(dest, bytes);
  await chmod(dest, 0o755);
  console.log(`  ✓ ${platform} → ${dest}（${bytes.byteLength} 字节）`);
  return dest;
}

async function main() {
  const args = process.argv.slice(2);
  const asEmbed = args.includes("--as-embed");
  const all = args.includes("--all");
  const platformArg = args.find((a) => a.startsWith("--platform="))?.split("=")[1];

  const version = process.env.SID_RG_VERSION?.trim() || DEFAULT_RG_VERSION;
  const baseUrl = getBaseUrl();

  console.log(`fetch-ripgrep: version=${version} baseUrl=${baseUrl}`);

  await mkdir(VENDOR_DIR, { recursive: true });

  if (all) {
    for (const p of ALL_PLATFORMS) {
      await fetchOne(p, version, baseUrl);
    }
    console.log("  全部平台 rg 下载完成");
    return;
  }

  const platform = (platformArg as Platform) || selfPlatform();
  if (!ALL_PLATFORMS.includes(platform)) {
    throw new Error(`未知平台: ${platform}。支持: ${ALL_PLATFORMS.join(", ")}`);
  }

  const dest = await fetchOne(platform, version, baseUrl);

  // --as-embed：落成固定 import 路径 vendor/rg-embed（供 make build / bun build --compile）
  if (asEmbed) {
    const embedPath = join(VENDOR_DIR, "rg-embed");
    await copyFile(dest, embedPath);
    await chmod(embedPath, 0o755);
    console.log(`  ✓ 已落成嵌入占位 → ${embedPath}`);
  }
}

main().catch((err) => {
  console.error(`  ❌ ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
