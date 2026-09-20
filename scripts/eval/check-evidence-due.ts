#!/usr/bin/env bun
/**
 * check-evidence-due.ts —— 证据层差集闸（11a PR-A / A4）
 *
 * 判据是集合差，⛔ 不是时间戳：
 *
 *   {磁盘上的证据单元} − {清单有行 ∧ sha256 形态合法} = ∅
 *
 * 分子按五类派生（harbor job / harbor 手工 / harbor sidecar / swe-bench run /
 * swe-bench logs），⛔ 不用单一 job.json/config.json（那会把 swe-bench 滤掉且恒绿）。
 *
 * ⛔ 不许挂进 CI：CI runner 上没有 harbor/runs/ ⇒ 差集恒为空、恒绿。
 * 它是本机 / pre-push 级的闸。
 *
 * 用法：
 *   bun run scripts/eval/check-evidence-due.ts
 *   bun run scripts/eval/check-evidence-due.ts --root <repo>
 *   bun run scripts/eval/check-evidence-due.ts --manifest <tsv>
 *   bun run scripts/eval/check-evidence-due.ts --json
 *
 * 退出码：0 = 差集空；1 = 有未归档单元；2 = 用法 / 清单损坏
 */

import { resolve } from "node:path";
import {
  diffDue,
  dueExitCode,
  listDiskUnits,
  loadManifest,
  type ManifestRow,
  manifestPath,
  renderDueReport,
  repoRootFrom,
} from "./lib/evidence-archive.ts";

const DEFAULT_ROOT = repoRootFrom(import.meta.dir);

export interface CliArgs {
  root: string;
  manifest?: string;
  json: boolean;
}

export function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = { root: DEFAULT_ROOT, json: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--root") args.root = resolve(argv[++i] ?? "");
    else if (a === "--manifest") args.manifest = resolve(argv[++i] ?? "");
    else if (a === "--json") args.json = true;
  }
  return args;
}

export function main(argv: string[]): number {
  const args = parseArgs(argv.slice(2));
  if (!args.root) {
    console.error("[evidence-due] --root 不能为空");
    return 2;
  }
  let manifest: ManifestRow[];
  try {
    manifest = loadManifest(args.manifest ?? manifestPath(args.root));
  } catch (e) {
    console.error(`[evidence-due] 清单损坏: ${e instanceof Error ? e.message : e}`);
    return 2;
  }
  const disk = listDiskUnits(args.root);
  const rep = diffDue(disk, manifest);
  if (args.json) {
    console.log(
      JSON.stringify(
        {
          disk: disk.length,
          manifest: manifest.length,
          missing: rep.missing.map((u) => ({ source: u.source, job_id: u.job_id })),
          unsigned: rep.unsigned.map((r) => ({ source: r.source, job_id: r.job_id })),
          extra: rep.extra.map((r) => ({ source: r.source, job_id: r.job_id })),
        },
        null,
        2,
      ),
    );
  } else {
    console.log(renderDueReport(rep));
  }
  return dueExitCode(rep);
}

if (import.meta.main) {
  process.exit(main(process.argv));
}
