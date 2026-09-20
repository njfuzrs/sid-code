/**
 * 证据层归档的共享类型与纯函数（PR-A）。
 *
 * 字节落公开 HF dataset `njfuzrs/sid-code-eval-runs`，清单落 git。
 * 差集闸的分子按**五类**派生，⛔ 不用单一 `job.json`/`config.json`（那会把
 * swe-bench 滤掉且恒绿），⛔ 也不把 55/72 写死（那是 2026-09-16 快照）。
 *
 * 新来源接入 checklist（漏第 2 条 = 闸恒绿，且不报错）：
 *   1. 打包：确认 allowlist 差集为空
 *   2. 🔴 差集闸：在本文件的分子里加一类，并做一次删行变异自证（必须点名新来源）
 *   3. 清单：dataset_id / dataset_version / model / n_planned 能派生；派生不了就手写
 *   4. 题面：只登记指针（digest / registry 三要素），⛔ 不搬原文
 */

import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";

export const HF_DATASET = "njfuzrs/sid-code-eval-runs";
export const HF_REPO_TYPE = "dataset" as const;

/** 与 A4 五类对应的 HF 路径前缀。 */
export const SOURCE_PREFIX = {
  harbor: "evidence/harbor",
  "harbor-manual": "evidence/harbor",
  "harbor-sidecars": "evidence/harbor-sidecars",
  "swe-bench": "evidence/swe-bench",
  "swe-bench-logs": "evidence/swe-bench-logs",
} as const;

export type EvidenceSource = keyof typeof SOURCE_PREFIX;

export const HARBOR_JOB_FILES = [
  "config.json",
  "lock.json",
  "result.json",
  "analysis.md",
  "job.log",
  ".w3-taskset-fingerprint",
  "README.md",
] as const;

export const HARBOR_TRIAL_ALLOWLIST = [
  "config.json",
  "lock.json",
  "result.json",
  "analysis.md",
  "agent",
  "verifier",
  "artifacts",
  "trial.log",
  "exception.txt",
] as const;

export const MANIFEST_COLUMNS = [
  "job_id",
  "source",
  "archive_name",
  "hf_path",
  "sha256",
  "src_bytes",
  "archive_bytes",
  "n_planned",
  "n_scored",
  "dataset_id",
  "dataset_version",
  "dataset_ref",
  "model",
  "results_ref",
  "allowlist_diff",
  "task_digests",
  "archived_at",
] as const;

export type ManifestColumn = (typeof MANIFEST_COLUMNS)[number];

export interface ManifestRow {
  job_id: string;
  source: EvidenceSource;
  archive_name: string;
  hf_path: string;
  sha256: string;
  src_bytes: string;
  archive_bytes: string;
  n_planned: string;
  n_scored: string;
  dataset_id: string;
  dataset_version: string;
  dataset_ref: string;
  model: string;
  results_ref: string;
  allowlist_diff: string;
  task_digests: string;
  archived_at: string;
}

export interface DiskUnit {
  /** 清单行的 job_id（闸用它点名）。 */
  job_id: string;
  source: EvidenceSource;
  /** 打包后的本地文件名（不含目录）。 */
  archive_name: string;
  /** 源目录或 sidecar 根。 */
  absPath: string;
}

export interface HarborLockFields {
  n_planned: number;
  dataset_id: string;
  dataset_version: string;
  dataset_ref: string;
  model: string;
  task_digests: string[];
}

export interface DueReport {
  disk: DiskUnit[];
  manifest: ManifestRow[];
  missing: DiskUnit[];
  extra: ManifestRow[];
  /** 清单有行但 sha256 为空 / 非法。 */
  unsigned: ManifestRow[];
}

export function repoRootFrom(importMetaDir: string): string {
  return resolve(importMetaDir, "..", "..");
}

export function harborRunsDir(root: string): string {
  return join(root, "evals/external-benchmarks/harbor/runs");
}

export function sweBenchRunsDir(root: string): string {
  return join(root, "evals/external-benchmarks/swe-bench/runs");
}

export function sweBenchLogsDir(root: string): string {
  return join(root, "evals/external-benchmarks/swe-bench/logs");
}

export function resultsDir(root: string): string {
  return join(root, "evals/external-benchmarks/harbor/results");
}

export function evidenceReportDir(root: string): string {
  // ⚠️ 必须带 `evals/`。check-external-anchor-due.ts 少了这一段，
  // 会静默写到仓库根 `_reports/external/`（不入 git）。
  return join(root, "evals/_reports/external/evidence");
}

export function manifestPath(root: string): string {
  return join(evidenceReportDir(root), "MANIFEST.tsv");
}

export function sha256sumsPath(root: string): string {
  return join(evidenceReportDir(root), "SHA256SUMS");
}

export function isDir(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

export function isFile(p: string): boolean {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
}

export function listDirNames(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).sort();
}

export function harborHasMeta(jobDir: string): boolean {
  return isFile(join(jobDir, "job.json")) || isFile(join(jobDir, "config.json"));
}

/**
 * 分子：磁盘上的证据单元。五类各自派生，数字随磁盘变。
 * 不存在的来源目录 → 该类空数组（本机闸仍可跑；CI 上整盘空 ⇒ 差集恒空，所以闸不许挂 CI）。
 */
export function listDiskUnits(root: string): DiskUnit[] {
  const units: DiskUnit[] = [];
  const harbor = harborRunsDir(root);
  if (existsSync(harbor)) {
    for (const name of listDirNames(harbor)) {
      const abs = join(harbor, name);
      if (!isDir(abs)) continue;
      if (harborHasMeta(abs)) {
        units.push({
          job_id: name,
          source: "harbor",
          archive_name: `job-${name}.tar.zst`,
          absPath: abs,
        });
      } else {
        units.push({
          job_id: name,
          source: "harbor-manual",
          archive_name: `job-${name}.tar.zst`,
          absPath: abs,
        });
      }
    }
    const sidecars = listDirNames(harbor).filter((n) => isFile(join(harbor, n)));
    if (sidecars.length > 0) {
      units.push({
        job_id: "harbor-sidecars",
        source: "harbor-sidecars",
        archive_name: "harbor-sidecars.tar.zst",
        absPath: harbor,
      });
    }
  }

  const sweb = sweBenchRunsDir(root);
  if (existsSync(sweb)) {
    for (const name of listDirNames(sweb)) {
      const abs = join(sweb, name);
      if (!isDir(abs)) continue;
      units.push({
        job_id: name,
        source: "swe-bench",
        archive_name: `sweb-${name}.tar.zst`,
        absPath: abs,
      });
    }
  }

  const logs = sweBenchLogsDir(root);
  if (existsSync(logs) && isDir(logs)) {
    units.push({
      job_id: "swe-bench-logs",
      source: "swe-bench-logs",
      archive_name: "sweb-logs.tar.zst",
      absPath: logs,
    });
  }

  return units;
}

export function diskUnitKey(u: { source: string; job_id: string }): string {
  return `${u.source}\t${u.job_id}`;
}

export function hfPathFor(source: EvidenceSource, archiveName: string): string {
  return `${SOURCE_PREFIX[source]}/${archiveName}`;
}

export function countHarborTrials(jobDir: string): number {
  if (!isDir(jobDir)) return 0;
  return readdirSync(jobDir).filter((n) => {
    if (n === "_digests") return false;
    return isDir(join(jobDir, n));
  }).length;
}

export function trialAllowlistDiff(jobDir: string): string[] {
  const extra: string[] = [];
  const allow = new Set<string>(HARBOR_TRIAL_ALLOWLIST);
  if (!isDir(jobDir)) return extra;
  for (const name of readdirSync(jobDir)) {
    if (name === "_digests") continue;
    const trial = join(jobDir, name);
    if (!isDir(trial)) continue;
    for (const entry of readdirSync(trial)) {
      if (!allow.has(entry)) extra.push(`${name}/${entry}`);
    }
  }
  return extra.sort();
}

function uniqueNonEmpty(xs: Array<string | undefined | null>): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const x of xs) {
    if (!x) continue;
    if (seen.has(x)) continue;
    seen.add(x);
    out.push(x);
  }
  return out;
}

/**
 * 从 lock.json 派生清单字段。lock 缺失（baton12）返回空字段，⛔ 不许 throw。
 * n_planned = len(trials)；digest / model / dataset 从 trials[] 聚合。
 */
export function deriveFromLock(lock: unknown): HarborLockFields {
  const empty: HarborLockFields = {
    n_planned: 0,
    dataset_id: "",
    dataset_version: "",
    dataset_ref: "",
    model: "",
    task_digests: [],
  };
  if (!lock || typeof lock !== "object") return empty;
  const trials = (lock as { trials?: unknown }).trials;
  if (!Array.isArray(trials)) return empty;

  const sources: string[] = [];
  const gitUrls: string[] = [];
  const commits: string[] = [];
  const models: string[] = [];
  const digests: string[] = [];

  for (const t of trials) {
    if (!t || typeof t !== "object") continue;
    const task = (t as { task?: Record<string, unknown> }).task ?? {};
    const agent = (t as { agent?: Record<string, unknown> }).agent ?? {};
    if (typeof task.source === "string") sources.push(task.source);
    if (typeof task.git_url === "string") gitUrls.push(task.git_url);
    if (typeof task.git_commit_id === "string") commits.push(task.git_commit_id);
    if (typeof task.digest === "string") digests.push(task.digest);
    if (typeof agent.model_name === "string") models.push(agent.model_name);
  }

  const source = uniqueNonEmpty(sources);
  const url = uniqueNonEmpty(gitUrls);
  const commit = uniqueNonEmpty(commits);
  const model = uniqueNonEmpty(models);
  const dataset_ref =
    url.length === 1 && commit.length === 1
      ? `${url[0]}@${commit[0]}`
      : uniqueNonEmpty([...url, ...commit]).join(";");

  return {
    n_planned: trials.length,
    dataset_id: source.join(";") || "",
    dataset_version: commit.map((c) => c.slice(0, 12)).join(";") || "",
    dataset_ref,
    model: model.join(";"),
    task_digests: uniqueNonEmpty(digests).sort(),
  };
}

export function readJsonIfExists(p: string): unknown {
  if (!isFile(p)) return null;
  try {
    return JSON.parse(readFileSync(p, "utf8"));
  } catch {
    return null;
  }
}

export function lookupResultsRef(root: string, jobId: string): string {
  const p = join(resultsDir(root), `${jobId}.json`);
  return isFile(p) ? relative(root, p) : "none";
}

export function emptyRow(
  partial: Partial<ManifestRow> & Pick<ManifestRow, "job_id" | "source">,
): ManifestRow {
  const archive_name = partial.archive_name ?? defaultArchiveName(partial.source, partial.job_id);
  return {
    job_id: partial.job_id,
    source: partial.source,
    archive_name,
    hf_path: partial.hf_path ?? hfPathFor(partial.source, archive_name),
    sha256: partial.sha256 ?? "",
    src_bytes: partial.src_bytes ?? "0",
    archive_bytes: partial.archive_bytes ?? "0",
    n_planned: partial.n_planned ?? "0",
    n_scored: partial.n_scored ?? "0",
    dataset_id: partial.dataset_id ?? "",
    dataset_version: partial.dataset_version ?? "",
    dataset_ref: partial.dataset_ref ?? "",
    model: partial.model ?? "",
    results_ref: partial.results_ref ?? "none",
    allowlist_diff: partial.allowlist_diff ?? "",
    task_digests: partial.task_digests ?? "",
    archived_at: partial.archived_at ?? "",
  };
}

export function defaultArchiveName(source: EvidenceSource, jobId: string): string {
  if (source === "harbor" || source === "harbor-manual") return `job-${jobId}.tar.zst`;
  if (source === "harbor-sidecars") return "harbor-sidecars.tar.zst";
  if (source === "swe-bench") return `sweb-${jobId}.tar.zst`;
  return "sweb-logs.tar.zst";
}

export function parseManifestTsv(text: string): ManifestRow[] {
  const lines = text.split(/\r?\n/).filter((l) => l.length > 0 && !l.startsWith("#"));
  if (lines.length === 0) return [];
  const header = lines[0].split("\t");
  if (header[0] !== "job_id") {
    throw new Error(`MANIFEST.tsv 首行必须是表头，以 job_id 起，实际: ${header[0]}`);
  }
  const rows: ManifestRow[] = [];
  for (const line of lines.slice(1)) {
    const cols = line.split("\t");
    const rec: Record<string, string> = {};
    for (let i = 0; i < header.length; i++) rec[header[i]] = cols[i] ?? "";
    if (!rec.job_id) continue;
    rows.push(
      emptyRow({
        job_id: rec.job_id,
        source: rec.source as EvidenceSource,
        archive_name: rec.archive_name,
        hf_path: rec.hf_path,
        sha256: rec.sha256,
        src_bytes: rec.src_bytes,
        archive_bytes: rec.archive_bytes,
        n_planned: rec.n_planned,
        n_scored: rec.n_scored,
        dataset_id: rec.dataset_id,
        dataset_version: rec.dataset_version,
        dataset_ref: rec.dataset_ref,
        model: rec.model,
        results_ref: rec.results_ref,
        allowlist_diff: rec.allowlist_diff,
        task_digests: rec.task_digests,
        archived_at: rec.archived_at,
      }),
    );
  }
  return rows;
}

export function loadManifest(path: string): ManifestRow[] {
  if (!existsSync(path)) return [];
  return parseManifestTsv(readFileSync(path, "utf8"));
}

export function formatManifestTsv(rows: ManifestRow[]): string {
  const header = MANIFEST_COLUMNS.join("\t");
  const body = rows.map((r) => MANIFEST_COLUMNS.map((c) => sanitizeTsvCell(r[c])).join("\t"));
  return [header, ...body, ""].join("\n");
}

function sanitizeTsvCell(v: string): string {
  return v.replace(/[\t\n\r]/g, " ").trim();
}

export function writeManifest(path: string, rows: ManifestRow[]): void {
  writeFileSync(path, formatManifestTsv(rows), "utf8");
}

export function formatSha256sums(rows: ManifestRow[]): string {
  // GNU 风格：`<hash>  <archive_name>`，核的是归档文件本身。
  return (
    rows
      .filter((r) => r.sha256 && r.archive_name)
      .map((r) => `${r.sha256}  ${r.archive_name}`)
      .join("\n") + (rows.length ? "\n" : "")
  );
}

const SHA256_RE = /^[a-f0-9]{64}$/;

export function isSha256(s: string): boolean {
  return SHA256_RE.test(s);
}

/**
 * 差集：磁盘单元 −（清单有行 ∧ sha256 形态合法）。
 * 闸不在这里访问 HF —— 「远端能取回」是 A7-5 的独立判据，避免本机闸在无网时假红。
 */
export function diffDue(disk: DiskUnit[], manifest: ManifestRow[]): DueReport {
  const byKey = new Map<string, ManifestRow>();
  for (const r of manifest) byKey.set(diskUnitKey(r), r);

  const missing: DiskUnit[] = [];
  const unsigned: ManifestRow[] = [];
  for (const u of disk) {
    const row = byKey.get(diskUnitKey(u));
    if (!row) {
      missing.push(u);
      continue;
    }
    if (!isSha256(row.sha256)) unsigned.push(row);
  }

  const diskKeys = new Set(disk.map(diskUnitKey));
  const extra = manifest.filter((r) => !diskKeys.has(diskUnitKey(r)));

  return { disk, manifest, missing, extra, unsigned };
}

export function dueExitCode(rep: DueReport): number {
  return rep.missing.length === 0 && rep.unsigned.length === 0 ? 0 : 1;
}

export function renderDueReport(rep: DueReport): string {
  const lines: string[] = [];
  lines.push(`[evidence-due] 磁盘单元 ${rep.disk.length}  清单 ${rep.manifest.length}`);
  const bySource = new Map<string, number>();
  for (const u of rep.disk) bySource.set(u.source, (bySource.get(u.source) ?? 0) + 1);
  for (const [s, n] of [...bySource.entries()].sort()) {
    lines.push(`  ${s}: ${n}`);
  }
  if (rep.missing.length === 0 && rep.unsigned.length === 0) {
    lines.push("差集为空。");
  } else {
    if (rep.missing.length) {
      lines.push(`未归档 ${rep.missing.length}：`);
      for (const u of rep.missing) {
        lines.push(`  MISSING  ${u.source}  ${u.job_id}  → ${u.archive_name}`);
      }
    }
    if (rep.unsigned.length) {
      lines.push(`清单无合法 sha256 ${rep.unsigned.length}：`);
      for (const r of rep.unsigned) {
        lines.push(`  UNSIGNED ${r.source}  ${r.job_id}`);
      }
    }
  }
  if (rep.extra.length) {
    lines.push(`清单多出（磁盘已无） ${rep.extra.length}：`);
    for (const r of rep.extra) lines.push(`  EXTRA    ${r.source}  ${r.job_id}`);
  }
  return lines.join("\n");
}

export function sha256File(abs: string): string {
  const h = createHash("sha256");
  h.update(readFileSync(abs));
  return h.digest("hex");
}

export function fileSize(abs: string): number {
  return statSync(abs).size;
}

/** 目录树字节（follow 不跟随 symlink 之外的，用 lstat 语义：statSync 默认 follow）。 */
export function dirSizeBytes(abs: string): number {
  if (isFile(abs)) return fileSize(abs);
  if (!isDir(abs)) return 0;
  let n = 0;
  for (const name of readdirSync(abs)) {
    const p = join(abs, name);
    try {
      const st = statSync(p);
      if (st.isDirectory()) n += dirSizeBytes(p);
      else n += st.size;
    } catch {
      // 跳过不可读条目，打包时 tar 也会跳
    }
  }
  return n;
}

export function nowIso(): string {
  return new Date().toISOString();
}

export function parseSweBenchMeta(meta: unknown): {
  model: string;
  dataset_id: string;
  dataset_version: string;
  dataset_ref: string;
} {
  if (!meta || typeof meta !== "object") {
    return {
      model: "",
      dataset_id: "SWE-bench/SWE-bench_Verified",
      dataset_version: "",
      dataset_ref: "SWE-bench/SWE-bench_Verified",
    };
  }
  const m = meta as Record<string, unknown>;
  const model =
    typeof m.model === "string" ? m.model : typeof m.model_id === "string" ? m.model_id : "";
  const split = typeof m.split === "string" ? m.split : "";
  const dataset =
    typeof m.dataset === "string"
      ? m.dataset
      : typeof m.dataset_id === "string"
        ? m.dataset_id
        : "SWE-bench/SWE-bench_Verified";
  const version =
    typeof m.sid_code_version === "string"
      ? m.sid_code_version
      : typeof m.artifact_commit === "string"
        ? String(m.artifact_commit).slice(0, 12)
        : "";
  const ref = split ? `${dataset}#${split}` : dataset;
  return { model, dataset_id: dataset, dataset_version: version, dataset_ref: ref };
}

export { relative, join };
