/**
 * archive-evidence 打包列表 + lock 派生 + 幂等跳过。
 *
 * 打包 glob 写错 cwd 会打出「job 在、trial 空」的包（11a 漂移 ⑪）：
 * 列表必须从 $j 自己 readdir，⛔ 不许 existsSync(join(j, '*__*'))。
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  countHarborTrials,
  deriveFromLock,
  parseSweBenchMeta,
  trialAllowlistDiff,
} from "../../scripts/eval/lib/evidence-archive.ts";
import { _test, filterUnits, parseArgs } from "../../evals/scripts/archive-evidence.ts";
import { listDiskUnits } from "../../scripts/eval/lib/evidence-archive.ts";

let tmpRoot: string;

beforeAll(() => {
  tmpRoot = join(tmpdir(), `sid-archive-ev-${Date.now()}`);
  const job = join(tmpRoot, "w3-cc-sonnet-54");
  mkdirSync(join(job, "dna-insert__n7xtPrn", "agent"), { recursive: true });
  mkdirSync(join(job, "_digests"), { recursive: true });
  writeFileSync(join(job, "config.json"), "{}");
  writeFileSync(join(job, "lock.json"), "{}");
  writeFileSync(join(job, "result.json"), "{}");
  writeFileSync(join(job, "job.log"), "log");
  writeFileSync(join(job, ".w3-taskset-fingerprint"), "fp");
  writeFileSync(join(job, "dna-insert__n7xtPrn", "result.json"), "{}");
  writeFileSync(join(job, "dna-insert__n7xtPrn", "trial.log"), "t");
  writeFileSync(join(job, "_digests", "dna-insert.txt"), "d");
});

afterAll(() => {
  try {
    rmSync(tmpRoot, { recursive: true, force: true });
  } catch {
    // ignore
  }
});

describe("harbor 打包列表 — 从 $j readdir，不含 *__* glob", () => {
  test("含 job 文件、_digests、trial 目录；不含 sidecar 文件名 glob", () => {
    const job = join(tmpRoot, "w3-cc-sonnet-54");
    const members = _test.listHarborArchiveMembers(job, "w3-cc-sonnet-54");
    expect(members).toContain("w3-cc-sonnet-54/config.json");
    expect(members).toContain("w3-cc-sonnet-54/lock.json");
    expect(members).toContain("w3-cc-sonnet-54/_digests");
    expect(members).toContain("w3-cc-sonnet-54/dna-insert__n7xtPrn");
    expect(members.some((m) => m.includes("*"))).toBe(false);
  });

  test("n_scored 排 _digests", () => {
    expect(countHarborTrials(join(tmpRoot, "w3-cc-sonnet-54"))).toBe(1);
  });

  test("allowlist 差集：夹具条目全在列 → 空", () => {
    expect(trialAllowlistDiff(join(tmpRoot, "w3-cc-sonnet-54"))).toEqual([]);
  });
});

describe("deriveFromLock — 容忍缺失，不 KeyError", () => {
  test("null / 非对象 → n_planned=0，不 throw", () => {
    expect(deriveFromLock(null).n_planned).toBe(0);
    expect(deriveFromLock("x").n_planned).toBe(0);
    expect(deriveFromLock({}).n_planned).toBe(0);
  });

  test("从 trials[] 聚合 model / digest / git_url@commit", () => {
    const lock = {
      trials: [
        {
          task: {
            source: "terminal-bench-w3-54",
            digest: "sha256:aaa",
            git_url: "https://github.com/laude-institute/terminal-bench-2.git",
            git_commit_id: "69671fbaac6d67a7ef0dfec016cc38a64ef7a77c",
          },
          agent: { model_name: "anthropic/claude-sonnet-5" },
        },
        {
          task: {
            source: "terminal-bench-w3-54",
            digest: "sha256:bbb",
            git_url: "https://github.com/laude-institute/terminal-bench-2.git",
            git_commit_id: "69671fbaac6d67a7ef0dfec016cc38a64ef7a77c",
          },
          agent: { model_name: "anthropic/claude-sonnet-5" },
        },
      ],
    };
    const d = deriveFromLock(lock);
    expect(d.n_planned).toBe(2);
    expect(d.model).toBe("anthropic/claude-sonnet-5");
    expect(d.dataset_id).toBe("terminal-bench-w3-54");
    expect(d.dataset_ref).toContain("69671fbaac6d67a7ef0dfec016cc38a64ef7a77c");
    expect(d.task_digests).toEqual(["sha256:aaa", "sha256:bbb"]);
  });

  test("nop / oracle 无 model_name → model 空串，不崩", () => {
    const d = deriveFromLock({
      trials: [{ task: { digest: "sha256:x" }, agent: { name: "nop" } }],
    });
    expect(d.n_planned).toBe(1);
    expect(d.model).toBe("");
    expect(d.task_digests).toEqual(["sha256:x"]);
  });
});

describe("parseSweBenchMeta", () => {
  test("gold / 空 → 手写 SWE-bench_Verified，不 throw", () => {
    const d = parseSweBenchMeta(null);
    expect(d.dataset_id).toBe("SWE-bench/SWE-bench_Verified");
  });

  test("sid 侧 30 键：读 model + artifact_commit", () => {
    const d = parseSweBenchMeta({
      model: "claude-sonnet-5-ppchat",
      artifact_commit: "abb8233e9cd89f8e37c40b13db6c03b635f2d57d",
      sid_code_version: "0.1.601",
    });
    expect(d.model).toBe("claude-sonnet-5-ppchat");
    expect(d.dataset_version).toBe("0.1.601");
  });
});

describe("CLI 过滤", () => {
  test("--only 按 job_id", () => {
    const harbor = join(tmpRoot, "runs-root", "evals/external-benchmarks/harbor/runs");
    mkdirSync(join(harbor, "w3-cc-sonnet-54"), { recursive: true });
    writeFileSync(join(harbor, "w3-cc-sonnet-54", "config.json"), "{}");
    mkdirSync(join(harbor, "other"), { recursive: true });
    writeFileSync(join(harbor, "other", "config.json"), "{}");
    const units = listDiskUnits(join(tmpRoot, "runs-root"));
    const filtered = filterUnits(units, ["w3-cc-sonnet-54"]);
    expect(filtered.map((u) => u.job_id)).toEqual(["w3-cc-sonnet-54"]);
  });

  test("parseArgs", () => {
    const a = parseArgs(["--pack-only", "--out", "/tmp/e", "--only", "gold"]);
    expect(a.packOnly).toBe(true);
    expect(a.out).toBe("/tmp/e");
    expect(a.only).toEqual(["gold"]);
  });
});
