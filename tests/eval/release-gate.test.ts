/**
 * L2 发版闸（方案 T20）：纯判定函数 + 编排器端到端（假发布目录 / 假 docker / 假 pmset /
 * 假尺子仓 / 假 harbor）。**不调任何模型、不碰网络、不写真实 `~/.sid-code/`**。
 *
 * T20 验收是「本地 dry-run（mock harbor）能走通全部 INVALID 分支」，所以端到端部分
 * 按「每一道闸各自红一次」来铺，并断言**红在哪一道**（看 `release_gate.blocks` 的内容，
 * 不只看退出码 3 —— 恒 INVALID 的闸照样退出 3）。另有两类必须单独断言：
 *
 * - **零模型调用**：跑前闸红时假 harbor 一次都没被调（它的调用日志为空）
 * - **账本**：预算熔断时账本逐字节不变；全量开跑过才记账
 *
 * 尺子桥自己的行为在 `test-l2-ruler.py`，这里跑它一次，保证 `.py` 进了 bun test（evals/CLAUDE.md §4.1）。
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  artifactUrls,
  judgeArtifactSha,
  judgeBinaryIdentities,
  judgeDockerMemory,
  manifestSha,
  parseBridgeOutput,
  parseByteSize,
  parseShaSidecar,
  shouldSkipExisting,
  sleepEventsInWindow,
} from "../../scripts/eval/lib/release-gate.ts";

const REPO = join(import.meta.dir, "../..");
const GATE_TS = join(REPO, "scripts/eval/release-gate.ts");
const GATE_SH = join(REPO, "scripts/eval/release-gate.sh");
const BRIDGE_TEST = join(REPO, "evals/external-benchmarks/harbor/test-l2-ruler.py");
const SHA_A = "a".repeat(64);
const SHA_B = "b".repeat(64);

// ─────────────────────────────────────────────────────────── 纯函数

describe("纯判定函数", () => {
  test("artifactUrls 与 release.sh 的 TARBALL_NAME 同形", () => {
    const u = artifactUrls("https://x/releases/sid-code/", "0.1.614");
    expect(u.tarball).toBe(
      "https://x/releases/sid-code/0.1.614/sid-code-0.1.614-linux-arm64.tar.gz",
    );
    expect(u.sha256).toBe(`${u.tarball}.sha256`);
    expect(u.manifest).toBe("https://x/releases/sid-code/versions.json");
  });

  test("parseShaSidecar：文件名必须是这个 tarball", () => {
    expect(parseShaSidecar(`${SHA_A}  f.tar.gz\n`, "f.tar.gz")).toBe(SHA_A);
    expect(parseShaSidecar(`${SHA_A}  other.tar.gz\n`, "f.tar.gz")).toBeNull();
    expect(parseShaSidecar("<html>404</html>", "f.tar.gz")).toBeNull();
  });

  test("manifestSha 取 linux-arm64，缺席返回 null 不编值", () => {
    const m = { versions: [{ version: "1.0.0", platforms: { "linux-arm64": { sha256: SHA_A } } }] };
    expect(manifestSha(m, "1.0.0")).toBe(SHA_A);
    expect(manifestSha(m, "1.0.1")).toBeNull();
    expect(
      manifestSha(
        { versions: [{ version: "1.0.0", platforms: { "darwin-arm64": { sha256: SHA_A } } }] },
        "1.0.0",
      ),
    ).toBeNull();
  });

  test("judgeArtifactSha：.sha256 必需；清单缺席只提示、在场不一致就红", () => {
    expect(judgeArtifactSha({ actual: SHA_A, sidecar: SHA_A, manifest: SHA_A }).red).toEqual([]);
    const noMan = judgeArtifactSha({ actual: SHA_A, sidecar: SHA_A, manifest: null });
    expect(noMan.red).toEqual([]);
    expect(noMan.notes.length).toBe(1);
    expect(judgeArtifactSha({ actual: SHA_A, sidecar: null, manifest: SHA_A }).red.length).toBe(1);
    expect(judgeArtifactSha({ actual: SHA_A, sidecar: SHA_B, manifest: SHA_A }).red[0]).toContain(
      ".sha256",
    );
    expect(judgeArtifactSha({ actual: SHA_A, sidecar: SHA_A, manifest: SHA_B }).red[0]).toContain(
      "versions.json",
    );
  });

  test("parseByteSize", () => {
    expect(parseByteSize("1.5GiB")).toBe(1.5 * 1024 ** 3);
    expect(parseByteSize("512MiB ")).toBe(512 * 1024 ** 2);
    expect(parseByteSize("0B")).toBe(0);
    expect(parseByteSize("--")).toBeNull();
  });

  test("judgeDockerMemory：减掉在跑容器；读不懂就红", () => {
    const G = 1024 ** 3;
    expect(judgeDockerMemory({ memTotalText: String(16 * G), statsText: "" }).red).toEqual([]);
    expect(
      judgeDockerMemory({ memTotalText: String(16 * G), statsText: "8GiB / 16GiB\n" }).red.length,
    ).toBe(1);
    expect(judgeDockerMemory({ memTotalText: String(8 * G), statsText: "" }).red.length).toBe(1);
    expect(judgeDockerMemory({ memTotalText: "", statsText: "" }).red[0]).toContain("MemTotal");
    expect(
      judgeDockerMemory({ memTotalText: String(16 * G), statsText: "-- / --" }).red[0],
    ).toContain("读不懂");
  });

  test("sleepEventsInWindow：只认事件列，详情里的 Sleep 不算；窗口外不算", () => {
    const log = [
      "2026-11-07 21:00:00 +0800 Sleep               \tEntering Sleep state due to 'Idle Sleep'",
      "2026-11-07 21:10:00 +0800 Maintenance Sleep   \tEntering Sleep state",
      "2026-11-07 21:20:00 +0800 Kernel Client Acks  \tDelays to Sleep notifications",
      "2026-11-07 21:25:59 +0800 Wake                \tDarkWake to FullWake",
      "2026-11-07 23:00:00 +0800 Sleep               \tlater",
    ].join("\n");
    const s = Date.parse("2026-11-07T20:59:00+08:00");
    const e = Date.parse("2026-11-07T22:00:00+08:00");
    expect(sleepEventsInWindow(log, s, e).map((x) => x.event)).toEqual([
      "Sleep",
      "Maintenance Sleep",
    ]);
    expect(sleepEventsInWindow(log, Date.parse("2026-11-07T21:15:00+08:00"), e)).toEqual([]);
  });

  test("judgeBinaryIdentities：恰好一个且等于下载那份", () => {
    expect(judgeBinaryIdentities([[SHA_A, "c"]], SHA_A)).toEqual([]);
    expect(judgeBinaryIdentities([], SHA_A).length).toBe(1);
    expect(
      judgeBinaryIdentities(
        [
          [SHA_A, "c"],
          [SHA_B, "c"],
        ],
        SHA_A,
      ).length,
    ).toBe(1);
    expect(judgeBinaryIdentities([[SHA_B, "c"]], SHA_A)[0]).toContain("跑错了二进制");
  });

  test("parseBridgeOutput：没有结论行 / 退出码非 0 / ok≠true 都是红", () => {
    expect(parseBridgeOutput("log\n", 0, "x").ok).toBe(false);
    expect(parseBridgeOutput('L2RULER_JSON {"ok":true,"red":[]}\n', 2, "x").ok).toBe(false);
    expect(parseBridgeOutput('L2RULER_JSON {"ok":false,"red":["a"]}\n', 0, "x").red).toEqual([
      "x：a",
    ]);
    expect(parseBridgeOutput('L2RULER_JSON {"ok":true,"red":[],"k":1}\n', 0, "x")).toMatchObject({
      ok: true,
      k: 1,
    });
  });

  test("shouldSkipExisting：INVALID 要重跑，终局结论不重跑", () => {
    expect(shouldSkipExisting({ verdict: "PASS" })).toBe(true);
    expect(shouldSkipExisting({ verdict: "REGRESSION" })).toBe(true);
    expect(shouldSkipExisting({ verdict: "INVALID" })).toBe(false);
    expect(shouldSkipExisting(null)).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────── 端到端

const VERSION = "9.9.9";
const COMMIT = "c".repeat(40);
const G = 1024 ** 3;

let root = "";
let fx: { repo: string; head: string; bindir: string };
let releaseBase = "";
let tarSha = "";
let binSha = "";

function identityLine(origin: string): string {
  return `SIDCODE_BUILD_V1|commit=${COMMIT}|branch=main|describe=v${VERSION}|dirty=false|built_at=2026-11-07T00:00:00Z|builder=t|origin=${origin}`;
}

/** 造发布目录 `<base>/<ver>/{tarball,.sha256}` + `<base>/versions.json`。 */
function makeRelease(
  dir: string,
  opts: { origin?: string; sidecarSha?: string; manifestSha?: string | null } = {},
) {
  const stage = join(dir, "_stage", "sid-code");
  mkdirSync(stage, { recursive: true });
  // 第一行给假尺子的 elf_arch 读，后面是 G2 嗅探的身份行
  writeFileSync(join(stage, "sid-code"), `arm64\n${identityLine(opts.origin ?? "release")}\n`);
  const vdir = join(dir, VERSION);
  mkdirSync(vdir, { recursive: true });
  const name = `sid-code-${VERSION}-linux-arm64.tar.gz`;
  const tar = Bun.spawnSync({
    cmd: ["tar", "-czf", join(vdir, name), "-C", join(dir, "_stage"), "sid-code"],
  });
  if (tar.exitCode !== 0) throw new Error("tar 失败");
  const h = new Bun.CryptoHasher("sha256");
  h.update(readFileSync(join(vdir, name)));
  const sha = h.digest("hex");
  const bh = new Bun.CryptoHasher("sha256");
  bh.update(readFileSync(join(stage, "sid-code")));
  writeFileSync(join(vdir, `${name}.sha256`), `${opts.sidecarSha ?? sha}  ${name}\n`);
  const man =
    opts.manifestSha === null
      ? []
      : [{ version: VERSION, platforms: { "linux-arm64": { sha256: opts.manifestSha ?? sha } } }];
  writeFileSync(join(dir, "versions.json"), JSON.stringify({ schema: 1, versions: man }));
  return { sha, binSha: bh.digest("hex") };
}

function writeExe(path: string, body: string) {
  writeFileSync(path, body);
  chmodSync(path, 0o755);
}

interface RunOut {
  code: number;
  stderr: string;
  verdict: Record<string, any> | null;
  harborCalls: string[];
  home: string;
}

function runGate(
  opts: {
    env?: Record<string, string>;
    args?: string[];
    base?: string;
    home?: string;
    useSh?: boolean;
  } = {},
): RunOut {
  const home = opts.home ?? mkdtempSync(join(root, "home-"));
  const hlog = join(home, "harbor-calls.jsonl");
  const env: Record<string, string> = {
    ...(process.env as Record<string, string>),
    PATH: `${join(root, "fakebin")}:${fx.bindir}:${process.env.PATH}`,
    SID_CONFIG_DIR: home,
    SID_L2_HARBOR_PYTHON: "python3",
    SID_L2_CAFFEINATED: "1",
    FAKE_DOCKER_MEMTOTAL: String(16 * G),
    FAKE_DOCKER_STATS: "",
    FAKE_HARBOR_LOG: hlog,
    FAKE_HARBOR_SHA: binSha,
    ...opts.env,
  };
  const cmd = opts.useSh
    ? [
        "bash",
        GATE_SH,
        VERSION,
        "--ruler",
        fx.repo,
        "--baseline",
        join(root, "baseline.json"),
        "--base",
        opts.base ?? releaseBase,
        ...(opts.args ?? []),
      ]
    : [
        "bun",
        "run",
        GATE_TS,
        VERSION,
        "--ruler",
        fx.repo,
        "--baseline",
        join(root, "baseline.json"),
        "--base",
        opts.base ?? releaseBase,
        ...(opts.args ?? []),
      ];
  const p = Bun.spawnSync({ cmd, env, stdout: "pipe", stderr: "pipe" });
  const vp = join(home, "eval-gate", `${VERSION}.verdict.json`);
  return {
    code: p.exitCode ?? -1,
    stderr: (p.stderr?.toString() ?? "") + (p.stdout?.toString() ?? ""),
    verdict: existsSync(vp) ? JSON.parse(readFileSync(vp, "utf8")) : null,
    harborCalls: existsSync(hlog) ? readFileSync(hlog, "utf8").split("\n").filter(Boolean) : [],
    home,
  };
}

const blocksOf = (r: RunOut): string[] => (r.verdict?.release_gate?.blocks as string[]) ?? [];
const agentsCalled = (r: RunOut): string[] =>
  r.harborCalls.map((l) => {
    const a = JSON.parse(l).argv as string[];
    return a[a.indexOf("-a") + 1]!;
  });

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "release-gate-test-"));
  const mk = Bun.spawnSync({
    cmd: ["python3", BRIDGE_TEST, "--make-fixture", join(root, "fx")],
    stdout: "pipe",
    stderr: "pipe",
  });
  if (mk.exitCode !== 0) throw new Error(`造假尺子失败：${mk.stderr?.toString()}`);
  fx = JSON.parse(mk.stdout!.toString().trim());
  // 基线：真实基线的结构，但 traj_bench_commit 指向假尺子 HEAD
  const real = JSON.parse(
    readFileSync(
      join(REPO, "evals/external-benchmarks/harbor/baselines/traj-bench-v0.2.1.json"),
      "utf8",
    ),
  );
  for (const f of real.fingerprints) f.declared.traj_bench_commit = fx.head;
  writeFileSync(join(root, "baseline.json"), JSON.stringify(real));

  const fakebin = join(root, "fakebin");
  mkdirSync(fakebin);
  writeExe(
    join(fakebin, "docker"),
    `#!/bin/sh\ncase "$1" in info) printf '%s\\n' "$FAKE_DOCKER_MEMTOTAL";; stats) printf '%s' "$FAKE_DOCKER_STATS";; esac\n`,
  );
  // pmset：FAKE_PMSET_SLEEP=1 时打一条「此刻」的 Sleep
  writeExe(
    join(fakebin, "pmset"),
    `#!/bin/sh\nif [ "$FAKE_PMSET_SLEEP" = 1 ]; then printf '%s Sleep               \\tEntering Sleep state\\n' "$(date '+%Y-%m-%d %H:%M:%S %z')"; fi\n`,
  );
  const rel = join(root, "release");
  const r = makeRelease(rel);
  tarSha = r.sha;
  binSha = r.binSha;
  releaseBase = `file://${rel}`;
});

afterAll(() => {
  if (root) rmSync(root, { recursive: true, force: true });
});

describe("端到端：每道闸各自红一次（mock harbor，零模型调用）", () => {
  test("dry-run 跑前闸全绿 → 退出 0，不调 harbor", () => {
    const r = runGate({ args: ["--dry-run"] });
    expect(r.stderr).toContain("跑前闸全绿");
    expect(r.code).toBe(0);
    expect(r.harborCalls).toEqual([]);
  }, 60_000);

  test("版本不存在（下载 404）→ INVALID，零 harbor 调用", () => {
    const r = runGate({ base: `file://${join(root, "nope")}` });
    expect(r.code).toBe(3);
    expect(r.verdict?.verdict).toBe("INVALID");
    expect(blocksOf(r).some((b) => b.includes("下载失败"))).toBe(true);
    expect(r.harborCalls).toEqual([]);
  }, 60_000);

  test(".sha256 与产物不一致 → INVALID", () => {
    const d = join(root, "rel-badsha");
    makeRelease(d, { sidecarSha: SHA_B });
    const r = runGate({ base: `file://${d}` });
    expect(r.code).toBe(3);
    expect(blocksOf(r).some((b) => b.includes(".sha256 记录"))).toBe(true);
    expect(r.harborCalls).toEqual([]);
  }, 60_000);

  test("versions.json 与产物不一致 → INVALID；清单缺席只提示", () => {
    const d = join(root, "rel-badman");
    makeRelease(d, { manifestSha: SHA_B });
    const r = runGate({ base: `file://${d}` });
    expect(blocksOf(r).some((b) => b.includes("versions.json 记录"))).toBe(true);
    const d2 = join(root, "rel-noman");
    makeRelease(d2, { manifestSha: null });
    const r2 = runGate({ base: `file://${d2}`, args: ["--dry-run"] });
    expect(r2.code).toBe(0);
    expect(r2.stderr).toContain("清单发布可能滞后");
  }, 60_000);

  test("G2：origin=local 的产物 → INVALID", () => {
    const d = join(root, "rel-local");
    makeRelease(d, { origin: "local" });
    const r = runGate({ base: `file://${d}` });
    expect(r.code).toBe(3);
    expect(blocksOf(r).some((b) => b.startsWith("G2：") && b.includes("origin=local"))).toBe(true);
  }, 60_000);

  test("未经 caffeinate 包住 → INVALID", () => {
    const r = runGate({ env: { SID_L2_CAFFEINATED: "" } });
    expect(r.code).toBe(3);
    expect(blocksOf(r).some((b) => b.includes("caffeinate"))).toBe(true);
    expect(r.harborCalls).toEqual([]);
  }, 60_000);

  test("docker 可用内存不足（总量够、被残留容器占掉）→ INVALID", () => {
    const r = runGate({ env: { FAKE_DOCKER_STATS: "10GiB / 16GiB\n" } });
    expect(r.code).toBe(3);
    expect(blocksOf(r).some((b) => b.includes("docker 可用内存"))).toBe(true);
    expect(r.harborCalls).toEqual([]);
  }, 60_000);

  test("预算熔断：账本已花 $149 → INVALID，零 harbor 调用，账本逐字节不变", () => {
    const home = mkdtempSync(join(root, "home-"));
    mkdirSync(join(home, "eval-gate"), { recursive: true });
    const ledger = join(home, "eval-gate", "ledger.jsonl");
    const now = new Date();
    const off = -now.getTimezoneOffset();
    const pad = (n: number) => String(Math.abs(n)).padStart(2, "0");
    const ts = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-01T00:00:00.000${off >= 0 ? "+" : "-"}${pad(Math.trunc(off / 60))}:${pad(off % 60)}`;
    const line =
      JSON.stringify({
        schema_version: 1,
        ts,
        pool: "routine",
        layer: "L2",
        version: "0.0.1",
        planned_cap_usd: 149,
        actual_usd: 149,
        null_cost_tasks: 0,
      }) + "\n";
    writeFileSync(ledger, line);
    const r = runGate({ home });
    expect(r.code).toBe(3);
    expect(blocksOf(r).some((b) => b.startsWith("预算账本") && b.includes("$149.00"))).toBe(true);
    expect(r.harborCalls).toEqual([]);
    expect(readFileSync(ledger, "utf8")).toBe(line);
  }, 60_000);

  test("尺子 HEAD ≠ 基线 commit → INVALID", () => {
    const bad = JSON.parse(readFileSync(join(root, "baseline.json"), "utf8"));
    for (const f of bad.fingerprints) f.declared.traj_bench_commit = "0".repeat(40);
    const p = join(root, "baseline-badcommit.json");
    writeFileSync(p, JSON.stringify(bad));
    const r = runGate({ args: ["--baseline", p] });
    expect(r.code).toBe(3);
    expect(blocksOf(r).some((b) => b.includes("traj_bench_commit"))).toBe(true);
    expect(r.harborCalls).toEqual([]);
  }, 60_000);

  test("oracle 预检一题不对 → INVALID，不跑 nop 与全量", () => {
    const r = runGate({ env: { FAKE_HARBOR_MODE: "one_bad" } });
    expect(r.code).toBe(3);
    expect(blocksOf(r).some((b) => b.startsWith("oracle 预检"))).toBe(true);
    expect(agentsCalled(r)).toEqual(["oracle"]);
  }, 60_000);

  test("全量跑完、运行区间宿主睡过 → INVALID；全量花费入账", () => {
    const r = runGate({ env: { FAKE_PMSET_SLEEP: "1" } });
    expect(r.code).toBe(3);
    expect(blocksOf(r).some((b) => b.includes("宿主睡眠"))).toBe(true);
    // oracle、nop、两档全量
    expect(agentsCalled(r)).toEqual([
      "oracle",
      "nop",
      "sid_code_agent:SidCodeAgent",
      "sid_code_agent:SidCodeAgent",
    ]);
    const ledger = readFileSync(join(r.home, "eval-gate", "ledger.jsonl"), "utf8")
      .trim()
      .split("\n");
    expect(ledger.length).toBe(1);
    const e = JSON.parse(ledger[0]!);
    // 假 harbor 每档首题 cost=null（按 $1.8 记），其余 $0.25：t1800 2 题 + t2700 1 题
    expect(e).toMatchObject({ layer: "L2", version: VERSION, null_cost_tasks: 2 });
    expect(e.actual_usd).toBeCloseTo(1.8 * 2 + 0.25, 6);
    expect(r.verdict?.release_gate?.tarball_sha256).toBe(tarSha);
  }, 60_000);

  test("容器内二进制不是下载的那份 → INVALID", () => {
    const r = runGate({ env: { FAKE_HARBOR_SHA: SHA_B } });
    expect(r.code).toBe(3);
    expect(blocksOf(r).some((b) => b.includes("跑错了二进制"))).toBe(true);
  }, 60_000);

  test("已有终局裁决不重跑；INVALID 次日会重跑", () => {
    const home = mkdtempSync(join(root, "home-"));
    mkdirSync(join(home, "eval-gate"), { recursive: true });
    const vp = join(home, "eval-gate", `${VERSION}.verdict.json`);
    writeFileSync(vp, JSON.stringify({ verdict: "WARN" }));
    const r = runGate({ home });
    expect(r.code).toBe(0);
    expect(r.harborCalls).toEqual([]);
    expect(JSON.parse(readFileSync(vp, "utf8"))).toEqual({ verdict: "WARN" });
    writeFileSync(vp, JSON.stringify({ verdict: "INVALID" }));
    const r2 = runGate({ home, args: ["--dry-run"] });
    expect(r2.stderr).toContain("dry-run");
  }, 60_000);

  test("release-gate.sh 入口：有 caffeinate 就套上（dry-run 全绿）", () => {
    if (!Bun.which("caffeinate")) {
      // 非 macOS：入口不包，TS 侧必须判红
      const r = runGate({ useSh: true, env: { SID_L2_CAFFEINATED: "" }, args: ["--dry-run"] });
      expect(r.code).toBe(3);
      return;
    }
    const r = runGate({ useSh: true, env: { SID_L2_CAFFEINATED: "" }, args: ["--dry-run"] });
    expect(r.code).toBe(0);
  }, 60_000);
});

describe("尺子桥行为单测（test-l2-ruler.py）", () => {
  test("全部通过", () => {
    const p = Bun.spawnSync({ cmd: ["python3", BRIDGE_TEST], stdout: "pipe", stderr: "pipe" });
    const out = p.stdout?.toString() ?? "";
    expect(out).toMatch(/\d+ 通过 \/ 0 失败/);
    expect(p.exitCode).toBe(0);
  }, 60_000);
});
