/**
 * 路 B 对照侧适配器（`mini-adapt.ts`）与驱动脚本（`run-mini.sh`）的单测。
 *
 * 事实源：`docs-research/.../01-coding-agent评测集全景与sid-code接入方案.md`
 * A7.12.4（路 B 定义）/ A7.14.4（一题实测）/ A7.14.8（预算裁决）
 *
 * ## 这份测试专防什么
 *
 * 一句话：**防「mini 缺一个机制」被读成「mini 在这个机制上表现更好」。**
 *
 * 路 B 的产出是一个**差值**。差值最危险的失效模式不是算错，而是
 * 拿两个不同口径的数去相减 —— 而相减本身永远成功，结果永远是个数。
 * 所以断言集中在三处：
 *
 *   1. **结构性缺失落 null，不落 0**（permission_denials）。
 *      与 A7.13.2 同型：0 会把「这个 harness 没有权限层」伪装成「一次没被拦」。
 *   2. **必控变量不对齐必须被点破**（step_limit / cost_limit）。
 *      不点破的形态是"比了一轮谁预算多"，而报告上看起来是能力差。
 *   3. **exit_status 的未知取值一律当故障**，不猜它等价于"没解出来"。
 *
 * ## ⚠️ 每组断言都配变异自证
 *
 * CLAUDE.md：新增门禁必做变异自证。这里的变异**对着真实实现做**
 * （A7.17.7 ③ 的教训：对着测试替身做变异会得到一组"通过了但什么都没防住"的绿灯）。
 * 变异记录在文件末尾那个 describe 里，用「把判据换成错写法、断言结论随之改变」
 * 的形式表达 —— 这样它跟着代码走，不是一份会过期的手工记录。
 */

import { describe, expect, test } from "bun:test";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  mapMiniExitStatus,
  parseDiffPaths,
  buildMiniRecord,
  buildMiniRunMeta,
  findTraj,
  EXPECTED_STEP_LIMIT,
} from "../../evals/external-benchmarks/swe-bench/mini-adapt.ts";

const SWE_DIR = join(import.meta.dir, "../../evals/external-benchmarks/swe-bench");

/** A7.14.4 实测那条 patch 的形状（504B，打在 astropy/modeling/separable.py）。 */
const REAL_PATCH = `diff --git a/astropy/modeling/separable.py b/astropy/modeling/separable.py
--- a/astropy/modeling/separable.py
+++ b/astropy/modeling/separable.py
@@ -242,7 +242,7 @@ def _cstack(left, right):
         cright = _coord_matrix(right, 'right', noutp)
     else:
         cright = np.zeros((noutp, right.shape[1]))
-        cright[-right.shape[0]:, -right.shape[1]:] = 1
+        cright[-right.shape[0]:, -right.shape[1]:] = right

     return np.hstack([cleft, cright])
`;

function traj(overrides: Record<string, unknown> = {}) {
  return {
    info: {
      exit_status: "Submitted",
      submission: REAL_PATCH,
      mini_version: "1.14.0",
      model_stats: { instance_cost: 0.1751302, api_calls: 23 },
      config: {
        agent: { step_limit: EXPECTED_STEP_LIMIT, cost_limit: 0, wall_time_limit_seconds: 0 },
        agent_type: "minisweagent.agents.default.DefaultAgent",
      },
      ...(overrides.info as object | undefined),
    },
    messages: [],
    trajectory_format: "mini-swe-agent-1.1",
    ...overrides,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// ① 结构性缺失必须落 null —— 这是本文件最重要的一组
// ─────────────────────────────────────────────────────────────────────────────

describe("结构性缺失落 null 而不是 0", () => {
  test("permission_denials 是 null，不是 0", () => {
    const rec = buildMiniRecord({
      instanceId: "astropy__astropy-12907",
      patch: REAL_PATCH,
      traj: traj(),
      wallMs: 0,
    });
    // 🔴 这一条就是全文件的核心。写成 0 会让 grade.ts 把 mini 算进
    // 「量到了、确实没被拒」那一桶 —— 而 mini 压根没有权限层。
    expect(rec.permission_denials).toBeNull();
    // 而且必须**说出来**：一个不解释的 null 半年后会被读成"这轮没量到"。
    expect(rec.unaccounted).toContain("permission_denials=null");
    expect(rec.unaccounted).toContain("结构性缺");
  });

  test("host_slept_ms 是 null（没量），不是 0（量了没睡）", () => {
    const rec = buildMiniRecord({
      instanceId: "x",
      patch: REAL_PATCH,
      traj: traj(),
      wallMs: 0,
    });
    // 与 A7.15 同一口径：0 是**有效值**（量到了、确实没睡），
    // 所以"没量"只能用 null 表示。落 0 会把 mini 那轮伪装成"已验证没休眠"。
    expect(rec.host_slept_ms).toBeNull();
  });

  test("setup_ms / extract_ms 省略而不是落 0，以免破坏三段不变量", () => {
    const rec = buildMiniRecord({ instanceId: "x", patch: REAL_PATCH, traj: traj(), wallMs: 0 });
    // grade.ts 对缺字段的处理是「跳过分解、不做假汇总」，正是想要的行为。
    expect(rec.setup_ms).toBeUndefined();
    expect(rec.extract_ms).toBeUndefined();
  });

  test("缺失机制的清单里逐项点破，不留白", () => {
    const rec = buildMiniRecord({ instanceId: "x", patch: REAL_PATCH, traj: traj(), wallMs: 0 });
    // 三类都要在正文里出现，否则读报告的人只看到一串 null/0。
    expect(rec.unaccounted).toContain("权限层");
    expect(rec.unaccounted).toContain("编辑落点");
    expect(rec.unaccounted).toMatch(/不表示.*表现更好/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// ② 必控变量不对齐必须被点破（路 B 成立与否的判据）
// ─────────────────────────────────────────────────────────────────────────────

describe("必控变量对账", () => {
  test("step_limit 对齐时不报警", () => {
    const rec = buildMiniRecord({ instanceId: "x", patch: REAL_PATCH, traj: traj(), wallMs: 0 });
    expect(rec.unaccounted).not.toContain("必控变量不对齐");
  });

  test("step_limit=250（mini 默认）被点破为不可并排", () => {
    const t = traj({
      info: {
        exit_status: "Submitted",
        config: { agent: { step_limit: 250, cost_limit: 0 } },
      },
    });
    const rec = buildMiniRecord({ instanceId: "x", patch: REAL_PATCH, traj: t, wallMs: 0 });
    expect(rec.unaccounted).toContain("必控变量不对齐");
    expect(rec.unaccounted).toContain("250");
    // 必须说清后果，不能只说"不一致" —— A7.14.3 的原话是「比的是谁预算多」。
    expect(rec.unaccounted).toContain("不可与 sid-code 侧并排");
  });

  test("cost_limit=3.0（mini 默认，会硬停）被点破", () => {
    const t = traj({
      info: {
        exit_status: "Submitted",
        config: { agent: { step_limit: EXPECTED_STEP_LIMIT, cost_limit: 3.0 } },
      },
    });
    const rec = buildMiniRecord({ instanceId: "x", patch: REAL_PATCH, traj: t, wallMs: 0 });
    expect(rec.unaccounted).toContain("cost_limit=3");
    // 「硬停」这个后果必须出现：被停掉的题看起来像"没解出来"。
    expect(rec.unaccounted).toContain("硬停");
  });

  test("适配器不许悄悄修正必控变量 —— 只报告，不改值", () => {
    const t = traj({
      info: { exit_status: "Submitted", config: { agent: { step_limit: 250, cost_limit: 3.0 } } },
    });
    const meta = buildMiniRunMeta([t], [{ model_name_or_path: "anthropic/claude-sonnet-5" }]);
    // run-meta 里落的是**实际值 250**，不是裁决值 80。
    // 适配器把它"修正"成 80，等于让一轮不可比的数据长得可比。
    expect(meta.step_limit).toBe(250);
    expect(meta.cost_limit).toBe(3.0);
    expect(meta.comparability_notes.join(" ")).toContain("≠ 裁决值");
  });

  test("同一轮内配置不一致 → 整轮不可比", () => {
    const a = traj({ info: { config: { agent: { step_limit: 80, cost_limit: 0 } } } });
    const b = traj({ info: { config: { agent: { step_limit: 40, cost_limit: 0 } } } });
    const meta = buildMiniRunMeta([a, b], [{}, {}]);
    expect(meta.comparability_notes.join(" ")).toContain("整轮不可比");
  });

  test("多个模型名 → 第一必控变量破了，整轮作废", () => {
    const meta = buildMiniRunMeta(
      [traj(), traj()],
      [{ model_name_or_path: "anthropic/claude-sonnet-5" }, { model_name_or_path: "gpt-5.4" }],
    );
    expect(meta.comparability_notes.join(" ")).toContain("整轮作废");
  });

  test("没有任何 traj 带 config → 必控变量全 null 且明说无法证明对齐", () => {
    const meta = buildMiniRunMeta([null, null], [{}, {}]);
    expect(meta.step_limit).toBeNull();
    expect(meta.cost_limit).toBeNull();
    // 🔴 这里落 null 而不是裁决值。落裁决值 = 声称"已对齐"而其实没证据。
    expect(meta.comparability_notes.join(" ")).toContain("无法证明两边预算对齐");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// ③ exit_status 映射：未知一律当故障，不猜
// ─────────────────────────────────────────────────────────────────────────────

describe("mapMiniExitStatus", () => {
  test("Submitted + 有 patch → patch_produced（过程结论，不是 solved）", () => {
    const r = mapMiniExitStatus("Submitted", 504);
    expect(r.outcome).toBe("patch_produced");
    expect(r.agentExit).toBe(0);
  });

  test("Submitted 但 patch 为空 → no_patch，不许混进有产出那桶", () => {
    const r = mapMiniExitStatus("Submitted", 0);
    expect(r.outcome).toBe("no_patch");
    expect(r.note).toContain("交了个空的");
  });

  test("LimitsExceeded → 预算用尽，非 harness 故障", () => {
    const r = mapMiniExitStatus("LimitsExceeded", 504);
    expect(r.outcome).toBe("patch_produced");
    expect(r.note).toContain("预算用尽");
  });

  test("未知状态 → agent_error，不猜它等价于'没解出来'", () => {
    // 🔴 这条防的是"一个没见过的 exit_status 被当成正常提交"，
    // 那会让链路故障伪装成低分（与 grade.ts 里 ungraded 不折叠同型）。
    const r = mapMiniExitStatus("RuntimeError", 0);
    expect(r.outcome).toBe("agent_error");
    expect(r.agentExit).toBe(1);
    expect(r.note).toContain("不猜");
  });

  test("exit_status 缺失 → agent_exit 落 -1（未知），不落 0", () => {
    const r = mapMiniExitStatus(undefined, 504);
    // 落 0 = 声称"正常退出"，而我们其实不知道。
    expect(r.agentExit).toBe(-1);
    expect(r.note).toContain("不猜 0");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// ④ patch 解析：与我方同口径，否则字段不可比
// ─────────────────────────────────────────────────────────────────────────────

describe("parseDiffPaths", () => {
  test("取 diff --git 的 b 侧路径", () => {
    expect(parseDiffPaths(REAL_PATCH)).toEqual(["astropy/modeling/separable.py"]);
  });

  test("纯删除文件也能取到路径（+++ 是 /dev/null 的场合）", () => {
    // 🔴 这正是不用 `+++ b/X` 做判据的理由：删除 hunk 的 +++ 端是 /dev/null，
    // 用 +++ 会**漏掉**这个文件，于是 patch_touches_tests 可能假阴性。
    const del = `diff --git a/tests/test_foo.py b/tests/test_foo.py
deleted file mode 100644
--- a/tests/test_foo.py
+++ /dev/null
@@ -1,2 +0,0 @@
-import x
-assert x
`;
    expect(parseDiffPaths(del)).toEqual(["tests/test_foo.py"]);
  });

  test("触及测试文件的判据复用 isTestPath（两侧口径一致）", () => {
    const p = `diff --git a/tests/test_sep.py b/tests/test_sep.py
--- a/tests/test_sep.py
+++ b/tests/test_sep.py
@@ -1 +1 @@
-x
+y
`;
    const rec = buildMiniRecord({ instanceId: "x", patch: p, traj: traj(), wallMs: 0 });
    expect(rec.patch_touches_tests).toBe(true);
    expect(rec.test_files_touched).toEqual(["tests/test_sep.py"]);
  });

  test("patch_only_adds_files 能算出来（判据只需 patch 文本）", () => {
    const onlyNew = `diff --git a/repro.py b/repro.py
new file mode 100644
--- /dev/null
+++ b/repro.py
@@ -0,0 +1 @@
+print("x")
`;
    const rec = buildMiniRecord({ instanceId: "x", patch: onlyNew, traj: traj(), wallMs: 0 });
    // 这个字段与 harness 有没有编辑追踪无关，所以**必须**算而不是落 false ——
    // 落 false 会让「卡在复现阶段」这个形态在 mini 侧永久隐身。
    expect(rec.patch_only_adds_files).toBe(true);
    expect(rec.unaccounted).toContain("卡在复现阶段");
  });

  test("normalizePatch 已应用：patch_bytes 与我方同口径", () => {
    // 末尾多个换行 → 塌陷成一个（GNU patch 那条）。两侧同函数，字节数才可比。
    const rec = buildMiniRecord({
      instanceId: "x",
      patch: REAL_PATCH + "\n\n\n",
      traj: traj(),
      wallMs: 0,
    });
    expect(rec.patch_bytes).toBe(REAL_PATCH.length);
  });

  test("空 patch → patch_bytes 0 且 outcome=no_patch", () => {
    const rec = buildMiniRecord({ instanceId: "x", patch: "   \n  ", traj: traj(), wallMs: 0 });
    expect(rec.patch_bytes).toBe(0);
    expect(rec.outcome).toBe("no_patch");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// ⑤ traj 缺失/变形：让"解析失败"与"真没量"能被区分
// ─────────────────────────────────────────────────────────────────────────────

describe("traj 缺失与变形", () => {
  test("traj 为 null → 点破过程字段不可用，但 patch 仍有效", () => {
    const rec = buildMiniRecord({ instanceId: "x", patch: REAL_PATCH, traj: null, wallMs: 0 });
    expect(rec.unaccounted).toContain("traj.json 未找到");
    expect(rec.unaccounted).toContain("判分不受影响");
    // patch 来自 preds.json，不受 traj 影响。
    expect(rec.patch_bytes).toBeGreaterThan(0);
  });

  test("trajectory_format 变了要报警（否则字段全 undefined 看起来像'这轮没量'）", () => {
    const t = traj({ trajectory_format: "mini-swe-agent-2.0" });
    const rec = buildMiniRecord({ instanceId: "x", patch: REAL_PATCH, traj: t, wallMs: 0 });
    expect(rec.unaccounted).toContain("mini-swe-agent-2.0");
    expect(rec.unaccounted).toContain("解析失败而非真的没量");
  });

  test("findTraj 对坏 JSON 返回 null 而不抛", () => {
    const dir = join(tmpdir(), `mini-adapt-test-${process.pid}`);
    const iid = "a__b-1";
    mkdirSync(join(dir, iid), { recursive: true });
    writeFileSync(join(dir, iid, `${iid}.traj.json`), "{ 坏 JSON");
    // 一条坏 traj 不该让整轮转换失败 —— 但它会走到上面那条 "traj.json 未找到" 分支。
    expect(findTraj(dir, iid)).toBeNull();
    expect(findTraj(dir, "不存在的题")).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// ⑥ 口径差异必须点破（耗时与成本）
// ─────────────────────────────────────────────────────────────────────────────

describe("口径差异点破", () => {
  test("wallMs > 0 时点破耗时不同源", () => {
    const rec = buildMiniRecord({
      instanceId: "x",
      patch: REAL_PATCH,
      traj: traj(),
      wallMs: 12345,
    });
    expect(rec.unaccounted).toContain("耗时口径不同源");
    // 必须说明**偏向哪一边**：不说方向的话读者不知道该往哪折价。
    expect(rec.unaccounted).toContain("高估我方优势");
  });

  test("wallMs = 0（没量）时不编造耗时对比警告", () => {
    const rec = buildMiniRecord({ instanceId: "x", patch: REAL_PATCH, traj: traj(), wallMs: 0 });
    expect(rec.unaccounted).not.toContain("耗时口径不同源");
    expect(rec.agent_ms).toBe(0);
  });

  test("meter_note 点破成本不同源，不可逐分比较", () => {
    const rec = buildMiniRecord({ instanceId: "x", patch: REAL_PATCH, traj: traj(), wallMs: 0 });
    expect(rec.meter).toBeNull();
    expect(rec.meter_note).toContain("不同源");
    expect(rec.meter_note).toContain("litellm");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// ⑦ 驱动脚本的四个陷阱：机械断言，防有人"顺手简化"
// ─────────────────────────────────────────────────────────────────────────────

describe("run-mini.sh 的必控变量固化", () => {
  const sh = readFileSync(join(SWE_DIR, "run-mini.sh"), "utf8");

  test("显式传 -c <默认 config>（陷阱 1：漏了则默认 config 整份失效）", () => {
    // 上游 --help 用红字警告这条。漏掉的形态是 agent 拿到空模板照样跑。
    expect(sh).toContain('-c "${DEFAULT_CFG}"');
    expect(sh).toMatch(/swebench\.yaml/);
  });

  test("step_limit 固定为裁决值，且与 mini-adapt.ts 同步", () => {
    expect(sh).toMatch(/^STEP_LIMIT=80$/m);
    // 两处必须一致 —— 不一致时转换会报"必控变量不对齐"，但那是跑完之后才知道。
    expect(EXPECTED_STEP_LIMIT).toBe(80);
  });

  test("cost_limit 固定为 0（不限），压掉 mini 默认 3.0", () => {
    expect(sh).toMatch(/^COST_LIMIT=0$/m);
    expect(sh).toContain('-c "agent.cost_limit=${COST_LIMIT}"');
  });

  test("HF 离线两个变量都在（本网络 HF 不可达）", () => {
    expect(sh).toContain("HF_HUB_OFFLINE=1");
    expect(sh).toContain("HF_DATASETS_OFFLINE=1");
  });

  test("挂了 caffeinate（A7.15：宿主休眠污染耗时并给超时闸门续命）", () => {
    expect(sh).toContain("caffeinate -dimsu");
  });

  test("不打印 API key 的值", () => {
    // CLAUDE.md：不回显密钥值。dry-run 里只打印长度。
    expect(sh).toContain("KEY_LEN");
    expect(sh).toMatch(/<%d 字符>/);
  });

  test("subset 从 yaml 现取，不硬编码 id 列表", () => {
    expect(sh).toContain("verified-subset.yaml");
    // 硬编码的形态：subset 重新生成后两边跑的题目悄悄不同了，两份报告都正常。
    expect(sh).not.toMatch(/astropy__astropy-12907.*astropy__astropy-8872/s);
  });

  test("点破不许与 harbor / 自建链路并行（共用同一个 daemon）", () => {
    expect(sh).toMatch(/不要与.*并行|共用同一个.*daemon/);
  });

  test("点破 Submitted ≠ solved", () => {
    // A7.14.4 的教训写进脚本输出，否则跑完的人会直接把 Submitted 数当分数。
    expect(sh).toMatch(/Submitted.*不等于.*solved/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// ⑧ 变异自证 —— 对着真实实现做，不对着替身
// ─────────────────────────────────────────────────────────────────────────────

describe("变异自证：错写法必须被上面的断言抓住", () => {
  test("变异 A：permission_denials 落 0 → ①组第一条会红", () => {
    const rec = buildMiniRecord({ instanceId: "x", patch: REAL_PATCH, traj: traj(), wallMs: 0 });
    // 这里模拟「有人把 null 改成 0」之后的记录，并验证判据确实能区分两者。
    const mutated = { ...rec, permission_denials: 0 };
    // 真实实现：null。变异版：0。判据 toBeNull 对后者失败 —— 即断言有效。
    expect(rec.permission_denials).toBeNull();
    expect(mutated.permission_denials).not.toBeNull();
    // 🔴 关键：证明这两个值在**下游汇总**里不等价。grade.ts 的
    // aggregatePermissionDenials 把 null 归 notMeasured、0 归"量到了是 0"。
    // 若下游把两者同等对待，那本条断言就只是在测一个无关紧要的字段。
    expect(rec.permission_denials === 0).toBe(false);
  });

  test("变异 B：exit_status 未知当成 Submitted → ③组会红", () => {
    const good = mapMiniExitStatus("RuntimeError", 504);
    const naive = mapMiniExitStatus("Submitted", 504);
    // 两者必须给出不同 outcome，否则「未知一律当故障」这条判据是空的。
    expect(good.outcome).not.toBe(naive.outcome);
    expect(good.outcome).toBe("agent_error");
  });

  test("变异 C：适配器把 step_limit 修正成裁决值 → ②组第四条会红", () => {
    const t = traj({ info: { config: { agent: { step_limit: 250, cost_limit: 0 } } } });
    const meta = buildMiniRunMeta([t], [{}]);
    // 若实现改成 `step_limit: EXPECTED_STEP_LIMIT`，这条会红。
    expect(meta.step_limit).not.toBe(EXPECTED_STEP_LIMIT);
    expect(meta.step_limit).toBe(250);
  });

  test("变异 D：用 +++ 解析路径 → ④组「纯删除」那条会红", () => {
    const del = `diff --git a/tests/test_foo.py b/tests/test_foo.py
deleted file mode 100644
--- a/tests/test_foo.py
+++ /dev/null
@@ -1 +0,0 @@
-x
`;
    // 错写法（只认 +++ 且跳过 /dev/null）会得到空数组。
    const wrong = del
      .split("\n")
      .filter((l) => l.startsWith("+++ ") && !l.includes("/dev/null"))
      .map((l) => l.slice(4).replace(/^b\//, ""));
    expect(wrong).toEqual([]);
    // 真实实现拿到了路径 —— 差异证明这条断言在防真东西。
    expect(parseDiffPaths(del)).toEqual(["tests/test_foo.py"]);
  });
});
