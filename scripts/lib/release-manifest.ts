/**
 * 版本清单 versions.json 的生成与 I1 审计（B46 P5 / P6）—— 纯函数，供 scripts/release-manifest.ts 与测试用。
 *
 * 输入是服务器上 `manifest-ops.sh dump` 的原样输出（一次 `ossutil ls` + 全部 .sha256 / provenance.json），
 * 输出是 versions.json。清单是**派生物**：任何时候都能从归档重建，所以这里不读、不合并旧清单 ——
 * 合并旧清单就等于让一份手改过的清单把错误永远传下去。
 */

import { compareVersions, isValidVersion } from "@sid-code/core/update/versions.ts";
import type {
  ManifestLost,
  ManifestPlatform,
  ManifestVersion,
  ReleaseManifest,
} from "@sid-code/core/update/manifest.ts";

/** install.sh 只会拼这 4 个平台（linux-x64-baseline 给评测显式取用，不是安装必需） */
export const INSTALL_PLATFORMS = ["darwin-arm64", "darwin-x64", "linux-x64", "linux-arm64"];

/** 归档机制上线后的第一个版本（B46 P1 用 --archive-existing 收进的最老原始字节） */
export const ARCHIVE_SINCE = "0.1.602";

/**
 * 归档上线前丢失的版本（P4 2026-10-08 裁决不补）。
 * 只登记事实，不登记「将来可能丢的」：ARCHIVE_SINCE 及之后出现缺口一律算违规（I1）。
 */
export const LOST_REASON =
  "归档机制上线前已被服务器保留窗口清理，原始字节无处留存（B46 P4 裁决不重建）";

/** 已知且不会再修的问题，按版本区间登记（闭区间） */
export const KNOWN_ISSUES: { from: string; to: string; id: string }[] = [
  // 0.1.582–0.1.599 内置 http://121.196.144.227，该通道 2026-09-22 起整体 410
  { from: "0.1.582", to: "0.1.599", id: "self-update-broken" },
];

export function knownIssuesFor(version: string): string[] {
  return KNOWN_ISSUES.filter(
    (k) => compareVersions(version, k.from) >= 0 && compareVersions(version, k.to) <= 0,
  ).map((k) => k.id);
}

export interface DumpParse {
  /** key → size（来自 ls 行尾：大小 = $(NF-3)，对象名 = $NF） */
  sizes: Map<string, number>;
  /** key → 文件内容 */
  files: Map<string, string>;
}

export function parseDump(text: string): DumpParse {
  const lines = text.split("\n");
  if (!lines.some((l) => l.trim() === "__DUMP_OK__")) {
    throw new Error("dump 输出缺少 __DUMP_OK__（服务器侧取数没跑完）");
  }
  const sizes = new Map<string, number>();
  const files = new Map<string, string>();
  let i = 0;
  const lsStart = lines.indexOf("__LS_BEGIN__");
  const lsEnd = lines.indexOf("__LS_END__");
  if (lsStart < 0 || lsEnd < lsStart) throw new Error("dump 输出缺少 ls 段");
  for (const l of lines.slice(lsStart + 1, lsEnd)) {
    const cols = l.trim().split(/\s+/);
    const key = cols[cols.length - 1] ?? "";
    if (!key.startsWith("oss://") || cols.length < 4) continue;
    const size = Number(cols[cols.length - 4]);
    if (Number.isFinite(size)) sizes.set(key, size);
  }
  i = lsEnd + 1;
  while (i < lines.length) {
    const l = lines[i]!;
    if (l.startsWith("__FILE__ ")) {
      const key = l.slice("__FILE__ ".length).trim();
      const body: string[] = [];
      i += 1;
      while (i < lines.length && lines[i] !== "__ENDFILE__") body.push(lines[i++]!);
      if (i >= lines.length) throw new Error(`dump 输出里 ${key} 没有结束标记`);
      files.set(key, body.join("\n"));
    }
    i += 1;
  }
  return { sizes, files };
}

export interface BuildResult {
  manifest: ReleaseManifest;
  /** 归档里有、但不够格进清单的版本（缺平台 / 缺 provenance / sha256 不一致），附原因 */
  skipped: { version: string; reason: string }[];
}

/**
 * @param prefix 归档前缀，如 oss://sid-code-releases/sid-code（不带末尾 /）
 * @param tags   `git tag -l 'v*'` 去掉 v 前缀后的版本号；用于生成 lost 列表
 */
export function buildManifest(
  dump: DumpParse,
  prefix: string,
  tags: string[],
  now: Date = new Date(),
): BuildResult {
  const p = prefix.replace(/\/+$/, "");
  const byVersion = new Map<string, Set<string>>();
  for (const key of dump.sizes.keys()) {
    const rest = key.startsWith(`${p}/`) ? key.slice(p.length + 1) : null;
    if (!rest) continue;
    const [ver, name, ...more] = rest.split("/");
    if (!ver || !name || more.length || !isValidVersion(ver)) continue; // _probe/ 等不进清单
    if (!byVersion.has(ver)) byVersion.set(ver, new Set());
    byVersion.get(ver)!.add(name);
  }

  const versions: ManifestVersion[] = [];
  const skipped: BuildResult["skipped"] = [];
  for (const [ver, names] of byVersion) {
    const platforms: Record<string, ManifestPlatform> = {};
    let bad = "";
    for (const name of names) {
      const m = name.match(new RegExp(`^sid-code-${ver.replace(/\./g, "\\.")}-(.+)\\.tar\\.gz$`));
      if (!m) continue;
      const shaKey = `${p}/${ver}/${name}.sha256`;
      const shaText = dump.files.get(shaKey);
      if (shaText === undefined) {
        bad ||= `${name} 缺 .sha256`;
        continue;
      }
      const [sha, file] = shaText.trim().split(/\s+/);
      if (!sha || !/^[0-9a-f]{64}$/.test(sha)) {
        bad ||= `${name}.sha256 内容不是 sha256`;
        continue;
      }
      if (file && file !== name) {
        bad ||= `${name}.sha256 指向的文件名是 ${file}`;
        continue;
      }
      platforms[m[1]!] = { sha256: sha, size: dump.sizes.get(`${p}/${ver}/${name}`) ?? 0 };
    }
    const missing = INSTALL_PLATFORMS.filter((pl) => !platforms[pl]);
    if (missing.length) bad ||= `缺安装平台 ${missing.join(", ")}`;

    let prov: Record<string, unknown> | null = null;
    const provText = dump.files.get(`${p}/${ver}/provenance.json`);
    if (provText === undefined) bad ||= "缺 provenance.json";
    else {
      try {
        prov = JSON.parse(provText);
      } catch {
        bad ||= "provenance.json 不是合法 JSON";
      }
    }
    if (prov && prov.version !== ver) bad ||= `provenance.json 的版本号是 ${String(prov.version)}`;
    const provenance = prov?.provenance;
    if (prov && provenance !== "original" && provenance !== "rebuilt") {
      bad ||= `provenance 取值非法: ${String(provenance)}`;
    }
    if (bad) {
      skipped.push({ version: ver, reason: bad });
      continue;
    }

    const issues = [
      ...knownIssuesFor(ver),
      ...(Array.isArray(prov!.known_issues) ? (prov!.known_issues as string[]) : []),
    ];
    const builtAt = typeof prov!.built_at === "string" ? prov!.built_at : "";
    const commit = typeof prov!.commit === "string" ? prov!.commit : "";
    versions.push({
      version: ver,
      provenance: provenance as "original" | "rebuilt",
      ...(builtAt && builtAt !== "unknown" ? { built_at: builtAt } : {}),
      ...(/^[0-9a-f]{40}$/.test(commit) ? { commit } : {}),
      platforms,
      ...(issues.length ? { known_issues: [...new Set(issues)] } : {}),
    });
  }
  versions.sort((a, b) => compareVersions(b.version, a.version));

  const archived = new Set(versions.map((v) => v.version));
  const lost: ManifestLost[] = tags
    .filter((t) => isValidVersion(t) && !archived.has(t) && compareVersions(t, ARCHIVE_SINCE) < 0)
    .sort(compareVersions)
    .map((version) => ({ version, reason: LOST_REASON }));

  return {
    manifest: {
      schema: 1,
      generated_at: now.toISOString(),
      archive_since: ARCHIVE_SINCE,
      versions,
      lost,
    },
    skipped,
  };
}

export interface AuditResult {
  ok: boolean;
  /** 打了 tag 但既不在归档、也不在 lost 列表 */
  gaps: string[];
  /** lost 里出现了 archive_since 及之后的版本（归档上线后不允许新缺口） */
  illegalLost: string[];
}

/**
 * I1：`git tag -l 'v*'` ⊆ 归档中可安装的版本 ∪ lost。
 *
 * ⚠️ 传进来的 manifest 必须是**本次从归档现生成的**，不能是服务器上那份 versions.json：
 * 那份可能是上一次发布写的，用它审计等于拿昨天的照片证明今天没丢东西。
 */
export function auditArchive(manifest: ReleaseManifest, tags: string[]): AuditResult {
  const covered = new Set([
    ...manifest.versions.map((v) => v.version),
    ...manifest.lost.map((l) => l.version),
  ]);
  const since = manifest.archive_since ?? ARCHIVE_SINCE;
  const gaps = tags.filter((t) => isValidVersion(t) && !covered.has(t)).sort(compareVersions);
  const illegalLost = manifest.lost
    .map((l) => l.version)
    .filter((v) => compareVersions(v, since) >= 0)
    .sort(compareVersions);
  return { ok: gaps.length === 0 && illegalLost.length === 0, gaps, illegalLost };
}

/** 最老的已归档版本（P6 回源冒烟的目标：通常早已不在热缓存里） */
export function oldestArchived(manifest: ReleaseManifest): string | null {
  const vs = manifest.versions.map((v) => v.version).sort(compareVersions);
  return vs[0] ?? null;
}
