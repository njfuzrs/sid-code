#!/usr/bin/env bun
/**
 * 版本清单 CLI（B46 P5 / P6）—— 给 release.sh 用的桥，判定逻辑全在 scripts/lib/release-manifest.ts。
 *
 * 用法：
 *   bun run scripts/release-manifest.ts build <dump 文件> <输出文件>
 *       从 `manifest-ops.sh dump` 的输出生成 versions.json。
 *       归档里一个合格版本都没有时 exit 2：宁可不发清单，也不发一份空清单
 *       （空清单会让 --list 说「没有可安装的版本」，而 --version 会把每个版本都判成不存在）。
 *   bun run scripts/release-manifest.ts audit <dump 文件> [--smoke <发布地址前缀>]
 *       I1 审计：`git tag -l 'v*'` 减去「归档 ∪ lost」必须为空；
 *       --smoke 时再对清单里最老的已归档版本发 HEAD，必须 200（验回源链路没断）。
 *       任一不过 exit 1。
 *
 * ⚠️ audit 一律从**本次 dump 现生成**的清单审计，不读服务器上的 versions.json ——
 * 那份可能是上一次发布写的，拿它审计等于用昨天的照片证明今天没丢东西。
 */

import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import type { ReleaseManifest } from "@sid-code/core/update/manifest.ts";
import { auditArchive, buildManifest, oldestArchived, parseDump } from "./lib/release-manifest.ts";

const REPO_ROOT = resolve(import.meta.dir, "..");
const PREFIX = process.env.ARCHIVE_PREFIX || "oss://sid-code-releases/sid-code";

function gitTags(): string[] {
  const r = spawnSync("git", ["tag", "-l", "v*"], { cwd: REPO_ROOT, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`git tag 失败: ${r.stderr}`);
  return r.stdout
    .split("\n")
    .map((t) => t.trim().replace(/^v/, ""))
    .filter(Boolean);
}

/**
 * 一个版本一行的 JSON：仍是合法 JSON，但 install.sh（不依赖 jq / python3）
 * 可以用 grep 取出某个版本那一行读 known_issues。改成多行缩进会让 install.sh 的提示静默失效。
 */
export function serializeManifest(m: ReleaseManifest): string {
  const head = JSON.stringify({
    schema: m.schema,
    generated_at: m.generated_at,
    archive_since: m.archive_since,
  }).slice(0, -1);
  const rows = (xs: unknown[]) => xs.map((x) => `  ${JSON.stringify(x)}`).join(",\n");
  return `${head},\n"versions": [\n${rows(m.versions)}\n],\n"lost": [\n${rows(m.lost)}\n]}\n`;
}

function loadBuilt(dumpFile: string) {
  return buildManifest(parseDump(readFileSync(dumpFile, "utf8")), PREFIX, gitTags());
}

function reportSkipped(skipped: { version: string; reason: string }[]) {
  for (const s of skipped) console.error(`  ⚠️  v${s.version} 不进清单：${s.reason}`);
}

async function smoke(base: string, version: string): Promise<boolean> {
  const url = `${base.replace(/\/+$/, "")}/${version}/sid-code-${version}-linux-x64.tar.gz`;
  try {
    const res = await fetch(url, { method: "HEAD", signal: AbortSignal.timeout(15000) });
    const src = res.headers.get("x-release-source");
    if (res.status === 200) {
      console.log(
        `  ✅ 最老已归档版本 v${version} 可下载（HTTP 200${src ? `，X-Release-Source: ${src}` : "，热缓存命中"}）`,
      );
      return true;
    }
    console.error(`  ❌ 最老已归档版本 v${version} 下载失败：HTTP ${res.status}（${url}）`);
  } catch (err) {
    console.error(`  ❌ 最老已归档版本 v${version} 请求异常：${err}（${url}）`);
  }
  console.error(
    "     回源链路可能断了：nginx @release_archive / bucket policy / resolver 被改过？",
  );
  return false;
}

async function main(argv: string[]): Promise<number> {
  const [sub, ...rest] = argv;
  if (sub === "build" && rest.length === 2) {
    const { manifest, skipped } = loadBuilt(rest[0]!);
    reportSkipped(skipped);
    if (!manifest.versions.length) {
      console.error("  ❌ 归档里没有任何合格版本，拒绝生成空清单");
      return 2;
    }
    writeFileSync(rest[1]!, serializeManifest(manifest));
    const vs = manifest.versions.map((v) => v.version);
    console.log(
      `  清单：${vs.length} 个可安装版本（${vs[vs.length - 1]} … ${vs[0]}），lost ${manifest.lost.length} 个`,
    );
    return 0;
  }
  if (sub === "audit" && (rest.length === 1 || (rest.length === 3 && rest[1] === "--smoke"))) {
    const { manifest, skipped } = loadBuilt(rest[0]!);
    reportSkipped(skipped);
    const a = auditArchive(manifest, gitTags());
    let ok = a.ok;
    if (a.gaps.length) {
      console.error(
        `  ❌ I1 违规：${a.gaps.length} 个打过 tag 的版本既不在归档、也不在 lost 列表：${a.gaps.join(" ")}`,
      );
      console.error(
        "     修法：服务器上若还有该版本目录，跑 ./scripts/release.sh --archive-existing",
      );
    }
    if (a.illegalLost.length) {
      console.error(
        `  ❌ I1 违规：归档上线（${manifest.archive_since}）之后不允许新缺口：${a.illegalLost.join(" ")}`,
      );
    }
    if (a.ok) {
      console.log(
        `  ✅ I1 审计通过：${manifest.versions.length} 个已归档 + ${manifest.lost.length} 个登记丢失 = 全部 tag`,
      );
    }
    if (rest[1] === "--smoke") {
      const oldest = oldestArchived(manifest);
      if (!oldest) {
        console.error("  ❌ 清单里没有已归档版本，无法做回源冒烟");
        ok = false;
      } else if (!(await smoke(rest[2]!, oldest))) {
        ok = false;
      }
    }
    return ok ? 0 : 1;
  }
  console.error(
    [
      "用法：",
      "  release-manifest.ts build <dump 文件> <输出文件>",
      "  release-manifest.ts audit <dump 文件> [--smoke <发布地址前缀>]",
    ].join("\n"),
  );
  return 64;
}

if (import.meta.main) {
  process.exit(await main(process.argv.slice(2)));
}
