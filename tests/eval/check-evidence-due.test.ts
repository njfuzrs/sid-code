/**
 * 证据层差集闸（PR-A / A4）
 *
 * 判据是集合差。变异自证三条缺一不可（11a 漂移 ① + ⑪）：
 *   1. 删一行 harbor job（抽样必须能点名 w3-cc-sonnet-54）→ 红的是那一行
 *   2. 删一行 swe-bench run → 红且点名
 *   3. 删 harbor-sidecars 那一行 → 红且点名
 *
 * 只做前者不足以证明 swe-bench / sidecar 被覆盖 —— 那正是闸恒绿的成因。
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  diffDue,
  dueExitCode,
  emptyRow,
  evidenceReportDir,
  formatManifestTsv,
  listDiskUnits,
  parseManifestTsv,
  renderDueReport,
  type ManifestRow,
} from "../../scripts/eval/lib/evidence-archive.ts";
import { main as dueMain, parseArgs } from "../../scripts/eval/check-evidence-due.ts";

let tmpRoot: string;

function touch(p: string, body = "{}\n"): void {
  mkdirSync(join(p, ".."), { recursive: true });
  writeFileSync(p, body);
}

function signed(job_id: string, source: ManifestRow["source"]): ManifestRow {
  return emptyRow({
    job_id,
    source,
    sha256: "a".repeat(64),
    archived_at: "2026-09-20T00:00:00Z",
  });
}

beforeAll(() => {
  tmpRoot = join(tmpdir(), `sid-evidence-due-${Date.now()}`);
  const harbor = join(tmpRoot, "evals/external-benchmarks/harbor/runs");
  const sweb = join(tmpRoot, "evals/external-benchmarks/swe-bench/runs");
  const logs = join(tmpRoot, "evals/external-benchmarks/swe-bench/logs");
  mkdirSync(harbor, { recursive: true });
  mkdirSync(sweb, { recursive: true });
  mkdirSync(logs, { recursive: true });

  // 两个 harbor job，其中一个必须是 A3 对照支点
  mkdirSync(join(harbor, "w3-cc-sonnet-54"), { recursive: true });
  touch(join(harbor, "w3-cc-sonnet-54", "config.json"));
  mkdirSync(join(harbor, "w3-sid-sonnet-66"), { recursive: true });
  touch(join(harbor, "w3-sid-sonnet-66", "config.json"));

  // 无元数据手工目录
  mkdirSync(join(harbor, "baton12-local-ab"), { recursive: true });
  touch(join(harbor, "baton12-local-ab", "README.md"), "# ab\n");

  // sidecar（顶层非目录）—— 漏了 = 闸对它们恒绿
  touch(join(harbor, "w3-cc-sonnet-54.nohup"), "log\n");
  touch(join(harbor, "ccrun-n6.mem.log"), "mem\n");

  // swe-bench：含 gold/（无 run-meta）
  mkdirSync(join(sweb, "gold"), { recursive: true });
  touch(join(sweb, "gold", "gold.validate-gold-x.json"), "{}\n");
  mkdirSync(join(sweb, "smoke-1"), { recursive: true });
  touch(join(sweb, "smoke-1", "run-meta.json"), '{"model":"x"}\n');

  mkdirSync(join(logs, "run_evaluation"), { recursive: true });
  touch(join(logs, "grade-routeb-mini.log"), "ok\n");
});

afterAll(() => {
  try {
    rmSync(tmpRoot, { recursive: true, force: true });
  } catch {
    // ignore
  }
});

describe("listDiskUnits — 五类派生，不写死 55/72", () => {
  test("fixture 合计 7 = 2 harbor + 1 手工 + 1 sidecar + 2 swe-bench + 1 logs", () => {
    const units = listDiskUnits(tmpRoot);
    const by = (s: string) =>
      units
        .filter((u) => u.source === s)
        .map((u) => u.job_id)
        .sort();
    expect(by("harbor")).toEqual(["w3-cc-sonnet-54", "w3-sid-sonnet-66"]);
    expect(by("harbor-manual")).toEqual(["baton12-local-ab"]);
    expect(by("harbor-sidecars")).toEqual(["harbor-sidecars"]);
    expect(by("swe-bench")).toEqual(["gold", "smoke-1"]);
    expect(by("swe-bench-logs")).toEqual(["swe-bench-logs"]);
    expect(units).toHaveLength(7);
  });

  test("来源目录不存在 → 该类空，不 throw（CI 形态）", () => {
    const empty = join(tmpRoot, "empty-root");
    mkdirSync(empty, { recursive: true });
    expect(listDiskUnits(empty)).toEqual([]);
  });
});

function fullManifest(): ManifestRow[] {
  const disk = listDiskUnits(tmpRoot);
  return disk.map((u) => signed(u.job_id, u.source));
}

describe("差集闸 — happy path 与三条变异自证", () => {
  test("清单覆盖全部磁盘单元且 sha256 合法 → 差集空、exit 0", () => {
    const disk = listDiskUnits(tmpRoot);
    const rep = diffDue(disk, fullManifest());
    expect(rep.missing).toEqual([]);
    expect(rep.unsigned).toEqual([]);
    expect(dueExitCode(rep)).toBe(0);
  });

  test("删一行 harbor job（w3-cc-sonnet-54）→ 红，且红的是这一行", () => {
    const disk = listDiskUnits(tmpRoot);
    const manifest = fullManifest().filter((r) => r.job_id !== "w3-cc-sonnet-54");
    const rep = diffDue(disk, manifest);
    expect(dueExitCode(rep)).toBe(1);
    expect(rep.missing.map((u) => u.job_id)).toEqual(["w3-cc-sonnet-54"]);
    expect(rep.missing[0].source).toBe("harbor");
    expect(renderDueReport(rep)).toContain("w3-cc-sonnet-54");
  });

  test("删一行 swe-bench run（gold）→ 红且点名", () => {
    const disk = listDiskUnits(tmpRoot);
    const manifest = fullManifest().filter((r) => r.job_id !== "gold");
    const rep = diffDue(disk, manifest);
    expect(dueExitCode(rep)).toBe(1);
    expect(rep.missing.map((u) => `${u.source}:${u.job_id}`)).toEqual(["swe-bench:gold"]);
    expect(renderDueReport(rep)).toMatch(/MISSING\s+swe-bench\s+gold/);
  });

  test("删 harbor-sidecars 那一行 → 红且点名", () => {
    const disk = listDiskUnits(tmpRoot);
    const manifest = fullManifest().filter((r) => r.job_id !== "harbor-sidecars");
    const rep = diffDue(disk, manifest);
    expect(dueExitCode(rep)).toBe(1);
    expect(rep.missing.map((u) => u.job_id)).toEqual(["harbor-sidecars"]);
    expect(rep.missing[0].source).toBe("harbor-sidecars");
    expect(renderDueReport(rep)).toContain("harbor-sidecars");
  });

  test("清单有行但 sha256 非法 → unsigned，不当成已归档", () => {
    const disk = listDiskUnits(tmpRoot);
    const manifest = fullManifest().map((r) =>
      r.job_id === "smoke-1" ? { ...r, sha256: "not-a-hash" } : r,
    );
    const rep = diffDue(disk, manifest);
    expect(rep.missing).toEqual([]);
    expect(rep.unsigned.map((r) => r.job_id)).toEqual(["smoke-1"]);
    expect(dueExitCode(rep)).toBe(1);
  });
});

describe("MANIFEST.tsv round-trip", () => {
  test("format → parse 字段不丢", () => {
    const rows = fullManifest();
    const text = formatManifestTsv(rows);
    expect(text.startsWith("job_id\t")).toBe(true);
    const back = parseManifestTsv(text);
    expect(back.map((r) => r.job_id).sort()).toEqual(rows.map((r) => r.job_id).sort());
  });
});

describe("CLI", () => {
  test("parseArgs --root / --json", () => {
    const a = parseArgs(["--root", tmpRoot, "--json"]);
    expect(a.root).toBe(tmpRoot);
    expect(a.json).toBe(true);
  });

  test("main：无清单 → missing 含 w3-cc-sonnet-54，exit 1", () => {
    const rc = dueMain(["bun", "check-evidence-due.ts", "--root", tmpRoot]);
    expect(rc).toBe(1);
  });
});

describe("落点带 evals/ —— 抄 check-external-anchor-due 会少一段", () => {
  test("evidenceReportDir 是 evals/_reports/external/evidence", () => {
    expect(evidenceReportDir("/repo")).toBe("/repo/evals/_reports/external/evidence");
    expect(evidenceReportDir("/repo")).not.toBe("/repo/_reports/external/evidence");
  });
});

describe("接线：本机 pre-push 才跑，CI 路径被目录存在性挡住", () => {
  test("pre-push.sh 调 check-evidence-due.ts，且先判断 harbor/runs 存在", () => {
    const sh = readFileSync(
      join(import.meta.dir, "../..", "scripts/git-hooks/pre-push.sh"),
      "utf8",
    );
    expect(sh).toContain("scripts/eval/check-evidence-due.ts");
    expect(sh).toContain("evals/external-benchmarks/harbor/runs");
    // ⛔ 没有 runs/ 时不得跑闸（CI 恒绿）
    expect(sh).toMatch(/if \[ -d "evals\/external-benchmarks\/harbor\/runs" \]/);
  });

  test("CI workflow 不引用 check-evidence-due", () => {
    const yml = readFileSync(join(import.meta.dir, "../..", ".github/workflows/ci.yml"), "utf8");
    expect(yml).not.toContain("check-evidence-due");
  });
});
