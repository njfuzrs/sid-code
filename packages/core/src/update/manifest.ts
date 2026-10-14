/**
 * 版本清单 versions.json（B46 P5）—— 客户端侧：拉取、解析、查询、格式化
 *
 * versions.json 是**派生物**：由 scripts/release-manifest.ts 从 OSS 归档（.sha256 + provenance.json）
 * 生成，放在服务器指针层（与 latest.txt / beta.txt 同级，nginx 不回源）。
 *
 * 两条刻意的取舍：
 *   · 清单里**不写通道**。通道以 latest.txt / beta.txt 为准，这里读回来自己标注 ——
 *     否则同一件事有两个事实源，promote 只改指针时清单就过期了。
 *   · 清单拉不到（网络 / 服务器还没发布清单）时，`--version` **直接进入安装**，由 install.sh 报 404；
 *     既不静默降级成「装最新」，也不因为清单不可用而拒绝安装（lookup 返回 unknown）。
 */

import { RELEASE_ORIGIN } from "./config.ts";
import { compareVersions, isValidVersion } from "./versions.ts";

export interface ManifestPlatform {
  sha256: string;
  size: number;
}

export interface ManifestVersion {
  version: string;
  /** original = 用户当年装到的就是这份字节；rebuilt = 事后重建（sha256 与当年不同） */
  provenance: "original" | "rebuilt";
  built_at?: string;
  commit?: string;
  platforms: Record<string, ManifestPlatform>;
  /** 已知且不会再修的问题 id，如 self-update-broken */
  known_issues?: string[];
}

/** 打过 tag 但原始字节已经找不回来的版本（归档机制上线前），如实登记，不冒充可安装 */
export interface ManifestLost {
  version: string;
  reason: string;
}

export interface ReleaseManifest {
  schema: 1;
  generated_at: string;
  /** 归档机制上线后的第一个版本：lost 只允许出现在它之前 */
  archive_since?: string;
  versions: ManifestVersion[];
  lost: ManifestLost[];
}

/** known_issues id → 给人看的说明。未登记的 id 原样显示 */
export const KNOWN_ISSUE_TEXT: Record<string, string> = {
  "self-update-broken":
    "此版本内置的更新地址已停用，sid-code update 与自动更新都会失败；换版本请重新运行 install.sh",
};

export function describeKnownIssue(id: string): string {
  return KNOWN_ISSUE_TEXT[id] ?? id;
}

export const MANIFEST_URL = `${RELEASE_ORIGIN}/releases/sid-code/versions.json`;

function isStr(x: unknown): x is string {
  return typeof x === "string" && x.length > 0;
}

/**
 * 校验并规整清单。schema 不对返回 null（当作「拿不到清单」）；
 * 单个条目不合法就丢掉该条目而不是整份作废 —— 一个坏条目不该让 --list 整体不可用。
 */
export function parseManifest(raw: unknown): ReleaseManifest | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  if (r.schema !== 1 || !Array.isArray(r.versions)) return null;

  const versions: ManifestVersion[] = [];
  for (const item of r.versions) {
    if (!item || typeof item !== "object") continue;
    const v = item as Record<string, unknown>;
    if (!isStr(v.version) || !isValidVersion(v.version)) continue;
    if (v.provenance !== "original" && v.provenance !== "rebuilt") continue;
    const platforms: Record<string, ManifestPlatform> = {};
    if (v.platforms && typeof v.platforms === "object") {
      for (const [p, info] of Object.entries(v.platforms as Record<string, unknown>)) {
        const i = info as Record<string, unknown> | null;
        if (i && isStr(i.sha256) && typeof i.size === "number") {
          platforms[p] = { sha256: i.sha256, size: i.size };
        }
      }
    }
    versions.push({
      version: v.version,
      provenance: v.provenance,
      ...(isStr(v.built_at) ? { built_at: v.built_at } : {}),
      ...(isStr(v.commit) ? { commit: v.commit } : {}),
      platforms,
      ...(Array.isArray(v.known_issues) && v.known_issues.every(isStr)
        ? { known_issues: v.known_issues as string[] }
        : {}),
    });
  }

  const lost: ManifestLost[] = [];
  if (Array.isArray(r.lost)) {
    for (const item of r.lost) {
      const l = item as Record<string, unknown> | null;
      if (l && isStr(l.version) && isValidVersion(l.version)) {
        lost.push({ version: l.version, reason: isStr(l.reason) ? l.reason : "" });
      }
    }
  }

  return {
    schema: 1,
    generated_at: isStr(r.generated_at) ? r.generated_at : "",
    ...(isStr(r.archive_since) && isValidVersion(r.archive_since)
      ? { archive_since: r.archive_since }
      : {}),
    versions,
    lost,
  };
}

/** 清单 + 两个通道指针。任何一项拉不到都是 null，由调用方决定怎么降级 */
export interface ReleaseIndex {
  manifestUrl: string;
  manifest: ReleaseManifest | null;
  latest: string | null;
  beta: string | null;
}

export type FetchText = (url: string) => Promise<string | null>;

/** 5s 超时、非 2xx / 异常一律返回 null（不抛） */
export const defaultFetchText: FetchText = async (url) => {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5000);
    const res = await fetch(url, { signal: controller.signal });
    clearTimeout(timer);
    if (!res.ok) return null;
    return await res.text();
  } catch {
    return null;
  }
};

export async function fetchReleaseIndex(
  fetchText: FetchText = defaultFetchText,
): Promise<ReleaseIndex> {
  const base = `${RELEASE_ORIGIN}/releases/sid-code`;
  const pointer = (text: string | null) => {
    const v = text?.trim() ?? "";
    return isValidVersion(v) ? v : null;
  };
  const [m, latest, beta] = await Promise.all([
    fetchText(MANIFEST_URL),
    fetchText(`${base}/latest.txt`),
    fetchText(`${base}/beta.txt`),
  ]);
  let manifest: ReleaseManifest | null = null;
  if (m) {
    try {
      manifest = parseManifest(JSON.parse(m));
    } catch {
      manifest = null;
    }
  }
  return { manifestUrl: MANIFEST_URL, manifest, latest: pointer(latest), beta: pointer(beta) };
}

export type VersionLookup =
  | { kind: "available"; entry: ManifestVersion | null }
  | { kind: "lost"; reason: string }
  | { kind: "missing" }
  /** 清单拉不到：不判断，交给 install.sh */
  | { kind: "unknown" };

export function lookupVersion(index: ReleaseIndex, version: string): VersionLookup {
  if (!index.manifest) return { kind: "unknown" };
  const entry = index.manifest.versions.find((v) => v.version === version);
  if (entry) return { kind: "available", entry };
  // 清单可能比指针旧（清单发布失败只 warn 不阻断发布）：指针指着的版本一定可装
  if (version === index.latest || version === index.beta) return { kind: "available", entry: null };
  const lost = index.manifest.lost.find((l) => l.version === version);
  if (lost) return { kind: "lost", reason: lost.reason };
  return { kind: "missing" };
}

/** `sid-code update --list` 的输出行（不含颜色，便于测试与管道） */
export function formatVersionList(index: ReleaseIndex, current: string | null): string[] {
  const manifest = index.manifest;
  if (!manifest) return [];

  const rows = new Map<string, ManifestVersion | null>();
  for (const v of manifest.versions) rows.set(v.version, v);
  // 指针指向但清单未收录（清单过期）：也列出来，并如实标注
  for (const p of [index.latest, index.beta]) {
    if (p && !rows.has(p)) rows.set(p, null);
  }
  const ordered = [...rows.keys()].sort((a, b) => compareVersions(b, a));
  const width = Math.max(...ordered.map((v) => v.length), 7);

  const lines: string[] = [`可安装的版本（共 ${ordered.length} 个）：`, ""];
  for (const v of ordered) {
    const entry = rows.get(v) ?? null;
    const tags: string[] = [];
    const channels = [v === index.latest ? "stable" : "", v === index.beta ? "beta" : ""].filter(
      Boolean,
    );
    if (channels.length) tags.push(channels.join(" · "));
    if (entry?.provenance === "rebuilt") tags.push("(重建)");
    if (!entry) tags.push("(清单未收录)");
    for (const issue of entry?.known_issues ?? []) tags.push(`⚠ ${issue}`);
    if (v === current) tags.push("← 当前");
    lines.push(`  ${v.padEnd(width)}  ${tags.join("  ")}`.trimEnd());
  }

  if (manifest.lost.length) {
    const lost = [...manifest.lost].sort((a, b) => compareVersions(a.version, b.version));
    const first = lost[0]!.version;
    const last = lost[lost.length - 1]!.version;
    const span = first === last ? first : `${first}–${last}`;
    lines.push(
      "",
      `另有 ${lost.length} 个版本已丢失、无法安装：${span}${lost[0]!.reason ? `（${lost[0]!.reason}）` : ""}`,
    );
  }

  const issues = new Set(manifest.versions.flatMap((v) => v.known_issues ?? []));
  for (const id of issues) lines.push(`⚠ ${id}：${describeKnownIssue(id)}`);

  lines.push(
    "",
    "安装指定版本：sid-code update --version <版本号>",
    '停留在旧版本：设置 "autoUpdate": "off"（或 SID_CODE_AUTO_UPDATE=off），否则下次启动会被自动更新升回',
  );
  return lines;
}
