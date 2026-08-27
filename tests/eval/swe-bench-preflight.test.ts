/**
 * SWE-bench 阶段 A preflight 单测
 *
 * 被测：`evals/external-benchmarks/swe-bench/preflight.ts`
 *
 * ## 这份测试自己的判据
 *
 * 本仓的教训是「新增门禁必做变异自证」—— 一个恒绿的门禁比没有门禁更坏，因为它看起来
 * 是在保护你。所以下面每组断言都配一条**反向用例**：把被测条件人为改坏，判定必须翻转。
 * 只断言 happy path 的测试，无法区分「逻辑对」与「函数恒返 ok」。
 *
 * 最要紧的一条是 `classifyVerdict` 的三档：skip 必须落到 INCOMPLETE 而不是 PASS。
 * 那正是本仓 scorer 恒返 0 那类「假结论」的同型 —— 换了位置，没消失。
 */

import { describe, test, expect } from "bun:test";
import {
  parseArgs,
  classifyVerdict,
  judgeNetworkInternal,
  judgeNetworkSeparation,
  judgeEgressSeparation,
  judgeNoFixCommit,
  assessFlagProbe,
  runPreflight,
  renderReport,
  probeDockerUp,
  probeDaemonCapacity,
  judgeBuildOutcome,
  REQUIRED_FLAGS,
  KNOWN_UNUSABLE_FLAGS,
  PROBE_CANARY_FLAG,
  type CheckResult,
  type Runner,
} from "../../evals/external-benchmarks/swe-bench/preflight.ts";

// ─────────────────────────────────────────────────────────────────────────────
// 测试替身
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 按「命令前缀 → 结果」表驱动的假 Runner。
 * 未匹配的命令返回 127（命令不存在），与生产 Runner 对「命令不存在」的处理一致。
 */
function fakeRunner(
  table: Array<{ match: (cmd: string[]) => boolean; code: number; out?: string }>,
  clock: { t: number } = { t: 0 },
): Runner & { calls: string[][] } {
  const calls: string[][] = [];
  return {
    calls,
    run(cmd) {
      calls.push(cmd);
      const hit = table.find((e) => e.match(cmd));
      if (!hit) return { code: 127, out: "command not found" };
      return { code: hit.code, out: hit.out ?? "" };
    },
    now() {
      clock.t += 1000;
      return clock.t;
    },
  };
}

const r = (id: CheckResult["id"], status: CheckResult["status"]): CheckResult => ({
  id,
  name: `check-${id}`,
  status,
});

// ─────────────────────────────────────────────────────────────────────────────
// 总判定三档 —— 这一组是整个文件的核心
// ─────────────────────────────────────────────────────────────────────────────

describe("classifyVerdict：skip 绝不能冒充 pass", () => {
  test("五项全 pass → PASS / 0", () => {
    const v = classifyVerdict([
      r("1", "pass"),
      r("2", "pass"),
      r("3", "pass"),
      r("4", "pass"),
      r("5", "pass"),
    ]);
    expect(v.verdict).toBe("PASS");
    expect(v.exitCode).toBe(0);
  });

  test("任一 fail → FAIL / 2（失败即停）", () => {
    const v = classifyVerdict([
      r("1", "pass"),
      r("2", "fail"),
      r("3", "pass"),
      r("4", "skip"),
      r("5", "pass"),
    ]);
    expect(v.verdict).toBe("FAIL");
    expect(v.exitCode).toBe(2);
  });

  test("⭐ 无 fail 但有 skip → INCOMPLETE / 3，不是 PASS / 0", () => {
    const v = classifyVerdict([
      r("1", "pass"),
      r("2", "pass"),
      r("3", "skip"),
      r("4", "skip"),
      r("5", "pass"),
    ]);
    expect(v.verdict).toBe("INCOMPLETE");
    // 这条是本 PR 的核心不变量：退出码非 0，调用方不会把「没检查」当成「检查通过」
    expect(v.exitCode).not.toBe(0);
    expect(v.exitCode).toBe(3);
  });

  test("fail 优先于 skip（同时存在时报 FAIL，别让 skip 盖住真失败）", () => {
    expect(classifyVerdict([r("1", "skip"), r("2", "fail")]).verdict).toBe("FAIL");
  });

  test("渲染里 INCOMPLETE 必须显式说明「不是通过」", () => {
    const text = renderReport([r("1", "pass"), r("2", "skip")]);
    expect(text).toContain("INCOMPLETE");
    expect(text).toContain("不是通过");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// ① 网络隔离：判据是 Internal=true，不是「network 存在」
// ─────────────────────────────────────────────────────────────────────────────

describe("judgeNetworkInternal", () => {
  test("Internal=true → ok", () => {
    expect(judgeNetworkInternal({ code: 0, out: "true\n" }).ok).toBe(true);
  });

  test("⭐ 变异自证：network 存在但 Internal=false → 不 ok（用「存在」当判据等于没查）", () => {
    const j = judgeNetworkInternal({ code: 0, out: "false\n" });
    expect(j.ok).toBe(false);
    expect(j.reason).toContain("Internal=false");
  });

  test("inspect 本身失败（network 不存在）→ 不 ok", () => {
    expect(judgeNetworkInternal({ code: 1, out: "Error: No such network" }).ok).toBe(false);
  });

  test("输出为空 → 不 ok（不把空当 true）", () => {
    expect(judgeNetworkInternal({ code: 0, out: "\n" }).ok).toBe(false);
  });
});

describe("check ①：缺参数是 fail 而不是 skip", () => {
  test("缺 --proxy → fail（配置错误不该被环境限制掩盖成 skip）", () => {
    const res = runPreflight(
      { bin: "/nonexistent-bin", json: false, runNetwork: "run-net" },
      fakeRunner([]),
    );
    const c1 = res.find((c) => c.id === "1")!;
    expect(c1.status).toBe("fail");
  });

  test("参数齐全但 docker 不可达 → skip（这才是环境限制）", () => {
    const res = runPreflight(
      {
        bin: "/nonexistent-bin",
        json: false,
        runNetwork: "run-net",
        buildNetwork: "build-net",
        proxy: "http://p",
      },
      fakeRunner([]), // docker info 未命中 → 127
    );
    expect(res.find((c) => c.id === "1")!.status).toBe("skip");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// ② 构建期/运行期分离
// ─────────────────────────────────────────────────────────────────────────────

describe("judgeNetworkSeparation（名字层，不需要 docker）", () => {
  test("两个不同名 → ok", () => {
    expect(judgeNetworkSeparation("run-net", "build-net").ok).toBe(true);
  });

  test("⭐ 变异自证：同名 → 不 ok（一套 network 承担不了两个相反要求）", () => {
    const j = judgeNetworkSeparation("same", "same");
    expect(j.ok).toBe(false);
    expect(j.reason).toContain("同一个 network");
  });

  test("只给一个 → 不 ok", () => {
    expect(judgeNetworkSeparation("run-net", undefined).ok).toBe(false);
    expect(judgeNetworkSeparation(undefined, "build-net").ok).toBe(false);
  });
});

describe("judgeEgressSeparation（两个方向都要查）", () => {
  const internal = { code: 0, out: "true" };
  const open = { code: 0, out: "false" };

  test("运行期 internal + 构建期开放 → ok", () => {
    expect(judgeEgressSeparation(internal, open).ok).toBe(true);
  });

  test("⭐ 运行期开放 → 不 ok（防作弊失效）", () => {
    expect(judgeEgressSeparation(open, open).ok).toBe(false);
  });

  test("⭐ 构建期也 internal → 不 ok（本地重建装不上依赖）", () => {
    const j = judgeEgressSeparation(internal, internal);
    expect(j.ok).toBe(false);
    expect(j.reason).toContain("构建期");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// ③ 镜像内无 fix commit
// ─────────────────────────────────────────────────────────────────────────────

describe("judgeNoFixCommit", () => {
  const SHA = "a".repeat(40);

  test("HEAD == base_commit 且工作树干净 → ok", () => {
    expect(judgeNoFixCommit({ headSha: SHA, baseCommit: SHA, treeDirty: false }).ok).toBe(true);
  });

  test("短 sha 与全长 sha 互比算同一提交", () => {
    expect(
      judgeNoFixCommit({ headSha: SHA, baseCommit: SHA.slice(0, 12), treeDirty: false }).ok,
    ).toBe(true);
  });

  test("⭐ HEAD 与 base_commit 不同 → 不 ok（答案可能在镜像里）", () => {
    const j = judgeNoFixCommit({ headSha: SHA, baseCommit: "b".repeat(40), treeDirty: false });
    expect(j.ok).toBe(false);
    expect(j.reason).toContain("base_commit");
  });

  test("⭐ 变异自证：HEAD 对但工作树脏 → 不 ok（只查 HEAD 查不出补丁已 apply 的形态）", () => {
    const j = judgeNoFixCommit({ headSha: SHA, baseCommit: SHA, treeDirty: true });
    expect(j.ok).toBe(false);
    expect(j.reason).toContain("工作树");
  });

  test("取不到 HEAD → 不 ok（空字符串不当成「匹配」）", () => {
    expect(judgeNoFixCommit({ headSha: "", baseCommit: SHA, treeDirty: false }).ok).toBe(false);
  });

  test("过短的 sha 前缀不算匹配（避免 'a' 匹配任何以 a 开头的 sha）", () => {
    expect(judgeNoFixCommit({ headSha: SHA, baseCommit: "a", treeDirty: false }).ok).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// ④ 镜像可构建性 + 计时
// ─────────────────────────────────────────────────────────────────────────────

describe("check ④：默认 skip，开启后必须落下耗时", () => {
  const args = {
    bin: "/nonexistent-bin",
    json: false,
    runNetwork: "run-net",
    buildNetwork: "build-net",
    proxy: "http://p",
  };

  test("不给 --build-instance → skip（它会真构建镜像，须显式开启）", () => {
    const c4 = runPreflight(args, fakeRunner([]))!.find((c) => c.id === "4")!;
    expect(c4.status).toBe("skip");
  });

  test("给了但 docker 不可达 → skip", () => {
    const c4 = runPreflight({ ...args, buildInstance: "sympy__sympy-13647" }, fakeRunner([]))!.find(
      (c) => c.id === "4",
    )!;
    expect(c4.status).toBe("skip");
    expect(c4.reason).toContain("docker");
  });

  test("docker 起了但没装 swebench → skip（而不是 fail：那是环境未装，不是断言不通过）", () => {
    const runner = fakeRunner([
      { match: (c) => c[0] === "docker" && c[1] === "info", code: 0, out: "27.0" },
    ]);
    const c4 = runPreflight({ ...args, buildInstance: "x" }, runner).find((c) => c.id === "4")!;
    expect(c4.status).toBe("skip");
    expect(c4.reason).toContain("swebench");
  });

  test("⭐ 容量量的是 daemon 侧而不是宿主机（宿主盘 602GB 不等于 VM 有 602GB）", () => {
    const runner = fakeRunner([
      // 注意断言的是它问了 NCPU/MemTotal 这种 daemon 字段，而不是去读宿主 df
      { match: (c) => c[0] === "docker" && c[1] === "info", code: 0, out: "4|8308097024" },
    ]);
    const cap = probeDaemonCapacity(runner);
    expect(cap.daemon_cpus).toBe("4");
    expect(cap.daemon_mem_gib).toBe("7.7");
    expect(String(cap.official_min)).toContain("120GB");
    // 探针必须真的问了 daemon
    expect(runner.calls.some((c) => c.join(" ").includes("{{.MemTotal}}"))).toBe(true);
  });

  test("docker info 取不到容量时不编数字", () => {
    expect(probeDaemonCapacity(fakeRunner([])).capacity).toContain("取不到");
  });

  // 摘要用真实格式（下面几例的 out 都抄自 swebench 5.0.2 的实际输出）
  const SUMMARY_OK = [
    "All instances run.",
    "Total instances: 1",
    "Instances submitted: 1",
    "Instances completed: 1",
    "Instances resolved: 1",
    "Instances with errors: 0",
  ].join("\n");

  test("⭐ 构建成功 → pass，且 elapsed_ms 必须是正数（这一项的产出主要是那个数字）", () => {
    const runner = fakeRunner([
      { match: (c) => c[0] === "docker" && c[1] === "info", code: 0, out: "27.0" },
      { match: (c) => c[0] === "swebench" && c[1] === "--help", code: 0 },
      { match: (c) => c[0] === "swebench" && c[1] === "eval", code: 0, out: SUMMARY_OK },
    ]);
    const c4 = runPreflight({ ...args, buildInstance: "sympy__sympy-13647" }, runner).find(
      (c) => c.id === "4",
    )!;
    expect(c4.status).toBe("pass");
    expect(c4.detail?.elapsed_ms as number).toBeGreaterThan(0);
  });

  test("⭐ 变异自证：构建失败 → fail，且 reason 要指向「借 x86_64 机器」而不是上云", () => {
    const runner = fakeRunner([
      { match: (c) => c[0] === "docker" && c[1] === "info", code: 0, out: "27.0" },
      { match: (c) => c[0] === "swebench" && c[1] === "--help", code: 0 },
      {
        match: (c) => c[0] === "swebench" && c[1] === "eval",
        // 实测形态：**exit 0**，但摘要里 errors=1（见 judgeBuildOutcome 的注释）
        code: 0,
        out:
          "Error in evaluation for pytest-dev__pytest-7982: 404 Client Error ... " +
          "no matching manifest for linux/arm64/v8 ...\nInstances completed: 0\nInstances with errors: 1",
      },
    ]);
    const c4 = runPreflight({ ...args, buildInstance: "x" }, runner).find((c) => c.id === "4")!;
    expect(c4.status).toBe("fail");
    expect(c4.reason).toContain("x86_64");
    expect(c4.reason).toContain("不上云");
  });

  test("⭐⭐ 构建命令**不得**带 --namespace（5.0.2 已删除该选项，传了直接 exit 2）", () => {
    const runner = fakeRunner([
      { match: (c) => c[0] === "docker" && c[1] === "info", code: 0, out: "27.0" },
      { match: (c) => c[0] === "swebench" && c[1] === "--help", code: 0 },
      { match: (c) => c[0] === "swebench" && c[1] === "eval", code: 0, out: SUMMARY_OK },
    ]);
    runPreflight({ ...args, buildInstance: "x" }, runner);
    const evalCall = runner.calls.find((c) => c[0] === "swebench" && c[1] === "eval")!;
    // 这条断言是**反向**的：上一版断言「必须带 --namespace ''」，而那个选项在真 CLI 上
    // 根本不存在 —— 假 Runner 照样让它通过，只有真跑才暴露。
    expect(evalCall).not.toContain("--namespace");
  });

  test("给了 --task-repo 才带上它（5.0.2 用它替代 --namespace）", () => {
    const mk = () =>
      fakeRunner([
        { match: (c) => c[0] === "docker" && c[1] === "info", code: 0, out: "27.0" },
        { match: (c) => c[0] === "swebench" && c[1] === "--help", code: 0 },
        { match: (c) => c[0] === "swebench" && c[1] === "eval", code: 0, out: SUMMARY_OK },
      ]);
    const without = mk();
    runPreflight({ ...args, buildInstance: "x" }, without);
    expect(without.calls.find((c) => c[1] === "eval")!).not.toContain("--task-repo");

    const withRepo = mk();
    runPreflight({ ...args, buildInstance: "x", taskRepo: "/tmp/tasks" }, withRepo);
    const call = withRepo.calls.find((c) => c[1] === "eval")!;
    expect(call[call.indexOf("--task-repo") + 1]).toBe("/tmp/tasks");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// judgeBuildOutcome —— 退出码不可信，判据是报告计数
// ─────────────────────────────────────────────────────────────────────────────

describe("judgeBuildOutcome：exit 0 也可能是失败", () => {
  test("⭐⭐ exit 0 但 errors=1 → 不 ok（实测形态，只看退出码会误判为通过）", () => {
    const j = judgeBuildOutcome({
      code: 0,
      out:
        "Error in evaluation for pytest-dev__pytest-7982: 404 ... no matching manifest for linux/arm64/v8\n" +
        "Instances completed: 0\nInstances resolved: 0\nInstances with errors: 1",
    });
    expect(j.ok).toBe(false);
    expect(j.reason).toContain("退出码不可信");
  });

  test("completed=1 / errors=0 → ok", () => {
    expect(
      judgeBuildOutcome({ code: 0, out: "Instances completed: 1\nInstances with errors: 0" }).ok,
    ).toBe(true);
  });

  test("⭐ completed=0 且 errors=0 → 不 ok（一个都没完成，不能算通过）", () => {
    const j = judgeBuildOutcome({
      code: 0,
      out: "Instances completed: 0\nInstances with errors: 0",
    });
    expect(j.ok).toBe(false);
    expect(j.reason).toContain("completed=0");
  });

  test("⭐ 连摘要都没有 → 不 ok（命令层失败，如选项不存在）", () => {
    const j = judgeBuildOutcome({ code: 2, out: "No such option: --namespace" });
    expect(j.ok).toBe(false);
    expect(j.reason).toContain("没产出摘要");
  });

  test("gold 跑「解出 0 条」不等于失败：completed>0 就算跑通（判分归官方 harness）", () => {
    // 这一项测的是「链路通不通」，不是「解出几条」——后者由官方 report.json 说话
    expect(
      judgeBuildOutcome({
        code: 0,
        out: "Instances completed: 1\nInstances resolved: 0\nInstances with errors: 0",
      }).ok,
    ).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// ⑤ flag 真的被接受（含探针自证）
// ─────────────────────────────────────────────────────────────────────────────

describe("assessFlagProbe", () => {
  const okRequired = REQUIRED_FLAGS.map((f) => ({ flag: f.join(" "), code: 0, out: "" }));

  test("版本能起 + 必需 flag 全接受 + canary 被拒 → ok", () => {
    const j = assessFlagProbe({
      version: { code: 0, out: "0.1.601" },
      required: okRequired,
      canary: { code: 1, out: "未知选项" },
    });
    expect(j.ok).toBe(true);
  });

  test("二进制起不来 → 不 ok", () => {
    const j = assessFlagProbe({
      version: { code: 127, out: "not found" },
      required: okRequired,
      canary: { code: 1, out: "" },
    });
    expect(j.ok).toBe(false);
    expect(j.reason).toContain("起不来");
  });

  test("⭐ 某个必需 flag 被拒 → 不 ok，且 reason 点出「被接受」才是判据", () => {
    const j = assessFlagProbe({
      version: { code: 0, out: "0.1.601" },
      required: [...okRequired.slice(1), { flag: "--max-turns 1", code: 1, out: "未知选项" }],
      canary: { code: 1, out: "" },
    });
    expect(j.ok).toBe(false);
    expect(j.reason).toContain("--max-turns 1");
    expect(j.reason).toContain("真的被接受");
  });

  test("⭐⭐ 探针自证：canary 也被接受（exit 0）→ 不 ok，即使必需 flag 全过", () => {
    const j = assessFlagProbe({
      version: { code: 0, out: "0.1.601" },
      required: okRequired, // 全过
      canary: { code: 0, out: "" }, // 但探针本身失效
    });
    expect(j.ok).toBe(false);
    expect(j.reason).toContain("探针失效");
  });
});

describe("check ⑤ 的接线", () => {
  test("二进制不存在 → skip（而不是 fail：没构建过不等于 flag 有问题）", () => {
    const c5 = runPreflight({ bin: "/definitely/not/here", json: false }, fakeRunner([])).find(
      (c) => c.id === "5",
    )!;
    expect(c5.status).toBe("skip");
    expect(c5.reason).toContain("make build");
  });

  test("探测命令必须带上被测 flag 与 --help 一起传（单独 --help 会命中 bootstrap 快速路径）", () => {
    // 用仓库里必然存在的文件冒充二进制路径，只为过 existsSync
    const bin = new URL("../../package.json", import.meta.url).pathname;
    const runner = fakeRunner([{ match: () => true, code: 1, out: "未知选项" }]);
    runPreflight({ bin, json: false }, runner);
    const helpCalls = runner.calls.filter((c) => c[0] === bin && c.includes("--help"));
    expect(helpCalls.length).toBeGreaterThan(0);
    // 每次探测都不是「只有 --help」
    for (const c of helpCalls) expect(c.length).toBeGreaterThan(2);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 契约：登记表与文档的一致性
// ─────────────────────────────────────────────────────────────────────────────

describe("契约", () => {
  test("REQUIRED_FLAGS 必须含 runner 命令行真正用到的三样：-p / --max-turns / --settings", () => {
    const flat = REQUIRED_FLAGS.map((f) => f[0]);
    expect(flat).toContain("-p");
    expect(flat).toContain("--max-turns");
    // 接入计划.md §4.5：不写 settings.json 起不来
    expect(flat).toContain("--settings");
  });

  test("已实测不可用的 flag 必须登记，且不参与「必须被拒绝」的断言", () => {
    // 登记表存在，且不与必需表交集（否则自相矛盾）
    expect(KNOWN_UNUSABLE_FLAGS).toContain("--no-session-persistence");
    const required = new Set(REQUIRED_FLAGS.map((f) => f[0]));
    for (const f of KNOWN_UNUSABLE_FLAGS) expect(required.has(f)).toBe(false);
  });

  test("canary flag 必须是不可能被声明的形态（否则哪天真加了这个 flag，探针自证就失效）", () => {
    expect(PROBE_CANARY_FLAG).toContain("nonexistent");
    expect(PROBE_CANARY_FLAG.startsWith("--")).toBe(true);
  });

  test("六项断言编号 1-6 齐全且不重复（1-5 对应 接入计划.md §4.1，⑥ 由构建溯源方案加）", () => {
    // ⑥（产物身份）不在原 §4.1 里。它与 ⑤ 的分工：⑤ 问「这个二进制能不能起、
    // flag 收不收」（能力），⑥ 问「它是**哪份代码**编的」（身份）——
    // 一个 5 天前编的产物在 ⑤ 上是满分，而它一行本轮修复都不含。
    const ids = runPreflight({ bin: "/nope", json: false }, fakeRunner([])).map((c) => c.id);
    expect(ids).toEqual(["1", "2", "3", "4", "5", "6"]);
  });

  test("probeDockerUp：docker info 非 0 → false（不把「问不到」当「起着」）", () => {
    expect(probeDockerUp(fakeRunner([]))).toBe(false);
    expect(
      probeDockerUp(fakeRunner([{ match: (c) => c[1] === "info", code: 0, out: "27.0" }])),
    ).toBe(true);
  });
});

describe("parseArgs", () => {
  test("默认 bin 指向仓库根产物，json 默认关", () => {
    const a = parseArgs([]);
    expect(a.bin.endsWith("/sid-code")).toBe(true);
    expect(a.json).toBe(false);
  });

  test("全参数解析", () => {
    const a = parseArgs([
      "--run-network",
      "rn",
      "--build-network",
      "bn",
      "--proxy",
      "http://p",
      "--instance-id",
      "iid",
      "--base-commit",
      "sha",
      "--image",
      "img",
      "--build-instance",
      "bi",
      "--bin",
      "/b",
      "--json",
    ]);
    expect(a).toEqual({
      runNetwork: "rn",
      buildNetwork: "bn",
      proxy: "http://p",
      instanceId: "iid",
      baseCommit: "sha",
      image: "img",
      buildInstance: "bi",
      bin: "/b",
      json: true,
    });
  });
});
