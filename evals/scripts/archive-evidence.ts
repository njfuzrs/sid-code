#!/usr/bin/env bun
/**
 * archive-evidence.ts —— 证据层 per-job 打包 + 单落点 HF 上传 + 写清单（11a PR-A）
 *
 * 幂等：清单里已有该 job 且本地归档 sha256 相符 ⇒ 跳过不重打、不重传。
 * 上传逐份 `hf upload`，⛔ 不用 upload_folder（会把本地缺失的远端路径当要删）。
 *
 * 用法：
 *   bun run evals/scripts/archive-evidence.ts --dry-run
 *   bun run evals/scripts/archive-evidence.ts --pack-only --out /tmp/evidence
 *   bun run evals/scripts/archive-evidence.ts --out /tmp/evidence --upload
 *   bun run evals/scripts/archive-evidence.ts --out /tmp/evidence --upload --only w3-cc-sonnet-54
 *
 * ⛔ 本脚本只读 runs/ + 写 /tmp 归档与 evals/_reports/external/evidence/ 清单。
 * ⛔ 不删 trial、不 docker prune、不对真实 runs/ 跑 classify --apply。
 */

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  type DiskUnit,
  type ManifestRow,
  HARBOR_JOB_FILES,
  countHarborTrials,
  deriveFromLock,
  dirSizeBytes,
  emptyRow,
  evidenceReportDir,
  fileSize,
  formatSha256sums,
  hfPathFor,
  isDir,
  isFile,
  listDiskUnits,
  loadManifest,
  lookupResultsRef,
  manifestPath,
  nowIso,
  parseSweBenchMeta,
  readJsonIfExists,
  sha256File,
  sha256sumsPath,
  trialAllowlistDiff,
  writeManifest,
} from "../../scripts/eval/lib/evidence-archive.ts";

const DEFAULT_ROOT = resolve(import.meta.dir, "../..");

export interface CliArgs {
  root: string;
  out: string;
  dryRun: boolean;
  packOnly: boolean;
  upload: boolean;
  only: string[];
  hfRepo: string;
}

export function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = {
    root: DEFAULT_ROOT,
    out: join(tmpdir(), "sid-code-evidence"),
    dryRun: false,
    packOnly: false,
    upload: false,
    only: [],
    hfRepo: "njfuzrs/sid-code-eval-runs",
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--root") args.root = resolve(argv[++i] ?? "");
    else if (a === "--out") args.out = resolve(argv[++i] ?? args.out);
    else if (a === "--dry-run") args.dryRun = true;
    else if (a === "--pack-only") args.packOnly = true;
    else if (a === "--upload") args.upload = true;
    else if (a === "--only") args.only.push(argv[++i] ?? "");
    else if (a === "--hf-repo") args.hfRepo = argv[++i] ?? args.hfRepo;
  }
  return args;
}

function mustBin(name: string): string {
  const r = spawnSync("which", [name], { encoding: "utf8" });
  const p = (r.stdout ?? "").trim();
  if (r.status !== 0 || !p) {
    throw new Error(`找不到 ${name}（打包需要 tar + zstd；上传需要 hf）`);
  }
  return p;
}

function run(cmd: string, args: string[], opts?: { cwd?: string; stdin?: string }): void {
  const r = spawnSync(cmd, args, {
    encoding: "utf8",
    cwd: opts?.cwd,
    input: opts?.stdin,
    maxBuffer: 64 * 1024 * 1024,
  });
  if (r.status !== 0) {
    throw new Error(`${cmd} ${args.join(" ")} 失败 (rc=${r.status}): ${r.stderr || r.stdout}`);
  }
}

function tarZstd(list: string[], cwd: string, dest: string): void {
  // bsdtar 3.5.3 不认 `tar -I zstd`。先落 tar 再 zstd，⛔ 不要把 stdout
  // 收进 Node maxBuffer（W3 单 job 解压后几百 MB，管道会把进程撑爆）。
  const tarList = list.filter((p) => p.length > 0);
  if (tarList.length === 0) {
    throw new Error(`打包列表为空（cwd=${cwd} dest=${dest}）`);
  }
  const listFile = `${dest}.list`;
  const tarFile = `${dest}.tmp.tar`;
  writeFileSync(listFile, tarList.join("\n") + "\n");
  try {
    run("tar", ["-cf", tarFile, "-C", cwd, "-T", listFile]);
    run("zstd", ["-19", "-T0", "-f", "-o", dest, tarFile]);
  } finally {
    try {
      unlinkSync(listFile);
    } catch {
      /* ignore */
    }
    try {
      unlinkSync(tarFile);
    } catch {
      /* ignore */
    }
  }
}

function listHarborArchiveMembers(jobDir: string, jobId: string): string[] {
  const members: string[] = [];
  for (const e of HARBOR_JOB_FILES) {
    if (existsSync(join(jobDir, e))) members.push(`${jobId}/${e}`);
  }
  const digests = join(jobDir, "_digests");
  if (isDir(digests)) members.push(`${jobId}/_digests`);
  for (const name of readdirSync(jobDir).sort()) {
    if (name === "_digests") continue;
    if (isDir(join(jobDir, name))) members.push(`${jobId}/${name}`);
  }
  return members;
}

function listWholeDirMembers(_abs: string, prefix: string): string[] {
  // 整目录带走：tar 条目以 prefix/ 起，解开后保留这一层。
  return [`${prefix}`];
}

function sidecarMembers(harborRuns: string): string[] {
  return readdirSync(harborRuns)
    .filter((n) => isFile(join(harborRuns, n)))
    .sort()
    .map((n) => n);
}

export function packUnit(unit: DiskUnit, dest: string): void {
  mkdirSync(join(dest, ".."), { recursive: true });
  if (unit.source === "harbor") {
    const parent = resolve(unit.absPath, "..");
    const members = listHarborArchiveMembers(unit.absPath, unit.job_id);
    tarZstd(members, parent, dest);
    return;
  }
  if (unit.source === "harbor-manual") {
    const parent = resolve(unit.absPath, "..");
    tarZstd(listWholeDirMembers(unit.absPath, unit.job_id), parent, dest);
    return;
  }
  if (unit.source === "harbor-sidecars") {
    tarZstd(sidecarMembers(unit.absPath), unit.absPath, dest);
    return;
  }
  if (unit.source === "swe-bench") {
    const parent = resolve(unit.absPath, "..");
    tarZstd(listWholeDirMembers(unit.absPath, unit.job_id), parent, dest);
    return;
  }
  // swe-bench-logs：logs/ 下全部，解开后是 sweb-logs/ 这一层
  const parent = resolve(unit.absPath, "..");
  tarZstd(["logs"], parent, dest);
}

export function countTarTrials(archive: string): number {
  const t = spawnSync("sh", ["-c", 'zstd -dc "$1" | tar -tf -', "sh", archive], {
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
  });
  if (t.status !== 0) {
    throw new Error(`zstd|tar -tf 失败: ${archive}: ${t.stderr || t.stdout}`);
  }
  const lines = (t.stdout ?? "").split("\n").filter(Boolean);
  return lines.filter((l) => /\/[^/]*__[^/]*\/$/.test(l)).length;
}

function deriveRow(
  root: string,
  unit: DiskUnit,
  archiveAbs: string,
  archivedAt: string,
): ManifestRow {
  const archive_name = unit.archive_name;
  const sha256 = sha256File(archiveAbs);
  const archive_bytes = String(fileSize(archiveAbs));
  const src_bytes =
    unit.source === "harbor-sidecars"
      ? String(
          sidecarMembers(unit.absPath).reduce(
            (n, name) => n + fileSize(join(unit.absPath, name)),
            0,
          ),
        )
      : String(dirSizeBytes(unit.absPath));

  if (unit.source === "harbor") {
    const lock = deriveFromLock(readJsonIfExists(join(unit.absPath, "lock.json")));
    const extra = trialAllowlistDiff(unit.absPath);
    return emptyRow({
      job_id: unit.job_id,
      source: unit.source,
      archive_name,
      hf_path: hfPathFor(unit.source, archive_name),
      sha256,
      src_bytes,
      archive_bytes,
      n_planned: String(lock.n_planned),
      n_scored: String(countHarborTrials(unit.absPath)),
      dataset_id: lock.dataset_id,
      dataset_version: lock.dataset_version,
      dataset_ref: lock.dataset_ref,
      model: lock.model,
      results_ref: lookupResultsRef(root, unit.job_id),
      allowlist_diff: extra.join(","),
      task_digests: lock.task_digests.join(","),
      archived_at: archivedAt,
    });
  }

  if (unit.source === "harbor-manual") {
    return emptyRow({
      job_id: unit.job_id,
      source: unit.source,
      archive_name,
      hf_path: hfPathFor(unit.source, archive_name),
      sha256,
      src_bytes,
      archive_bytes,
      n_planned: "0",
      n_scored: String(countHarborTrials(unit.absPath)),
      dataset_id: "手工A/B",
      dataset_version: "",
      dataset_ref: "none",
      model: "",
      results_ref: "none",
      allowlist_diff: "",
      task_digests: "",
      archived_at: archivedAt,
    });
  }

  if (unit.source === "harbor-sidecars") {
    const n = sidecarMembers(unit.absPath).length;
    return emptyRow({
      job_id: unit.job_id,
      source: unit.source,
      archive_name,
      hf_path: hfPathFor(unit.source, archive_name),
      sha256,
      src_bytes,
      archive_bytes,
      n_planned: String(n),
      n_scored: String(n),
      dataset_id: "harbor-sidecars",
      dataset_version: "",
      dataset_ref: "none",
      model: "",
      results_ref: "none",
      allowlist_diff: "",
      task_digests: "",
      archived_at: archivedAt,
    });
  }

  if (unit.source === "swe-bench") {
    const meta = parseSweBenchMeta(readJsonIfExists(join(unit.absPath, "run-meta.json")));
    const gold = unit.job_id === "gold";
    return emptyRow({
      job_id: unit.job_id,
      source: unit.source,
      archive_name,
      hf_path: hfPathFor(unit.source, archive_name),
      sha256,
      src_bytes,
      archive_bytes,
      n_planned: gold ? "10" : "0",
      n_scored: "0",
      dataset_id: gold ? "SWE-bench/SWE-bench_Verified" : meta.dataset_id,
      dataset_version: gold ? "gold" : meta.dataset_version,
      dataset_ref: gold ? "SWE-bench/SWE-bench_Verified#gold" : meta.dataset_ref,
      model: gold ? "gold" : meta.model,
      results_ref: "none",
      allowlist_diff: "",
      task_digests: "",
      archived_at: archivedAt,
    });
  }

  return emptyRow({
    job_id: unit.job_id,
    source: unit.source,
    archive_name,
    hf_path: hfPathFor(unit.source, archive_name),
    sha256,
    src_bytes,
    archive_bytes,
    n_planned: "1",
    n_scored: "1",
    dataset_id: "SWE-bench/SWE-bench_Verified",
    dataset_version: "logs",
    dataset_ref: "SWE-bench/SWE-bench_Verified#logs",
    model: "",
    results_ref: "none",
    allowlist_diff: "",
    task_digests: "",
    archived_at: archivedAt,
  });
}

function upsertRow(rows: ManifestRow[], next: ManifestRow): ManifestRow[] {
  const i = rows.findIndex((r) => r.source === next.source && r.job_id === next.job_id);
  if (i === -1) return [...rows, next];
  const copy = rows.slice();
  copy[i] = next;
  return copy;
}

function shouldSkip(existing: ManifestRow | undefined, archiveAbs: string): boolean {
  if (!existing) return false;
  if (!existsSync(archiveAbs)) return false;
  try {
    return sha256File(archiveAbs) === existing.sha256 && existing.sha256.length === 64;
  } catch {
    return false;
  }
}

function hfUpload(local: string, repoPath: string, repo: string): void {
  run("hf", ["upload", repo, local, repoPath, "--repo-type=dataset"]);
}

export function filterUnits(units: DiskUnit[], only: string[]): DiskUnit[] {
  if (only.length === 0) return units;
  const set = new Set(only);
  return units.filter((u) => set.has(u.job_id) || set.has(u.archive_name) || set.has(u.source));
}

export function main(argv: string[]): number {
  const args = parseArgs(argv.slice(2));
  mustBin("tar");
  mustBin("zstd");
  if (args.upload && !args.dryRun) mustBin("hf");

  const units = filterUnits(listDiskUnits(args.root), args.only);
  if (units.length === 0) {
    console.error("[archive-evidence] 没有要打包的单元（--only 滤空？磁盘路径不对？）");
    return 2;
  }

  console.log(`[archive-evidence] ${units.length} 个单元  out=${args.out}`);
  if (args.dryRun) {
    for (const u of units) {
      console.log(`  ${u.source}\t${u.job_id}\t${u.archive_name}`);
    }
    return 0;
  }

  mkdirSync(args.out, { recursive: true });
  mkdirSync(evidenceReportDir(args.root), { recursive: true });
  let rows = loadManifest(manifestPath(args.root));
  const archivedAt = nowIso();

  for (const u of units) {
    const dest = join(args.out, u.archive_name);
    const existing = rows.find((r) => r.source === u.source && r.job_id === u.job_id);
    let row = existing;
    if (shouldSkip(existing, dest)) {
      console.log(`  skip-pack  ${u.job_id}  sha256 相符`);
    } else {
      console.log(`  pack  ${u.source}  ${u.job_id}`);
      packUnit(u, dest);
      row = deriveRow(args.root, u, dest, archivedAt);
      if (u.source === "harbor") {
        const tarTrials = countTarTrials(dest);
        const diskTrials = countHarborTrials(u.absPath);
        if (tarTrials !== diskTrials) {
          throw new Error(
            `${u.job_id}: tar 内 trial=${tarTrials} ≠ 磁盘 trial=${diskTrials}（旧 glob 会打出 job 在、trial 空的包）`,
          );
        }
      }
      rows = upsertRow(rows, row);
    }
    if (!row) {
      throw new Error(`${u.job_id}: 打包后仍无清单行`);
    }
    if (args.upload) {
      console.log(`  upload ${row.hf_path}`);
      hfUpload(dest, row.hf_path, args.hfRepo);
    }
  }

  writeManifest(manifestPath(args.root), rows);
  writeFileSync(sha256sumsPath(args.root), formatSha256sums(rows), "utf8");
  writeFileSync(join(args.out, "SHA256SUMS"), formatSha256sums(rows), "utf8");

  if (args.upload) {
    hfUpload(sha256sumsPath(args.root), "evidence/SHA256SUMS", args.hfRepo);
    const card = join(evidenceReportDir(args.root), "HF_DATASET_CARD.md");
    if (isFile(card)) hfUpload(card, "README.md", args.hfRepo);
  }

  console.log(`[archive-evidence] 清单 ${rows.length} 行 → ${manifestPath(args.root)}`);
  return 0;
}

if (import.meta.main) {
  try {
    process.exit(main(process.argv));
  } catch (e) {
    console.error(`[archive-evidence] ${e instanceof Error ? e.message : e}`);
    process.exit(1);
  }
}

// 给单测用：打包列表构造（不打真实 tar）
export const _test = {
  listHarborArchiveMembers,
  sidecarMembers,
  listWholeDirMembers,
};
