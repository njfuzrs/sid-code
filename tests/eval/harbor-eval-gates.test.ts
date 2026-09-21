/**
 * PR-E2 两道闸的静态接线门禁：控制变量跨臂一致 + 题集指纹覆盖 4/4。
 *
 * Python 侧的行为断言在
 * `evals/external-benchmarks/harbor/test-check-controlled-vars.py`（改值 / 删键两条变异）
 * 与 `test-taskset-fp.py`（指纹含 digest）。本文件只锁「脚本被四条 runner 真的 source 了」
 * —— CI 不跑那些 .py，接线断了会绿着失效。
 *
 * 断言只读代码行，不读注释（本仓踩过：注释里写了关键词、真正的注入行被摘掉，门禁照绿）。
 */
import { describe, test, expect } from "bun:test";
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const HARBOR = join(import.meta.dir, "../../evals/external-benchmarks/harbor");

const RUNNERS = [
  "w3-run.sh",
  "run-claude-code-contrast.sh",
  "run-model-switch.sh",
  "run-permission-switch.sh",
] as const;

const codeOf = (p: string) =>
  readFileSync(p, "utf8")
    .split("\n")
    .filter((l) => !/^\s*#/.test(l))
    .join("\n");

describe("题集指纹闸覆盖 4/4 跑法脚本", () => {
  test("taskset_fp.py 与 taskset-fp.sh 存在", () => {
    expect(existsSync(join(HARBOR, "taskset_fp.py"))).toBe(true);
    expect(existsSync(join(HARBOR, "taskset-fp.sh"))).toBe(true);
  });

  test("算法哈希的是 task.digest，不只是题名", () => {
    const src = readFileSync(join(HARBOR, "taskset_fp.py"), "utf8");
    // 读源码原文字面量：digest 必须进指纹，nolock 是没有 lock 时的诚实第三段。
    expect(src).toContain('task.get("digest")');
    expect(src).toContain(":nolock");
  });

  for (const name of RUNNERS) {
    test(`${name} source 了 taskset-fp.sh 且调用 gate`, () => {
      const code = codeOf(join(HARBOR, name));
      expect(code).toMatch(/source\s+\.\/taskset-fp\.sh/);
      expect(code).toContain("taskset_fp_gate");
    });
  }

  test("⛔ 别用 run*.sh glob 数覆盖面（它不含 w3-run.sh）", () => {
    // 清单写死：逐个列名。run*.sh 匹配不到 w3-run.sh，数出来会是 3 当 4。
    const names = readdirSync(HARBOR).filter((n) => n.endsWith(".sh"));
    expect(names.filter((n) => n.startsWith("run")).sort()).toEqual([
      "run-claude-code-contrast.sh",
      "run-model-switch.sh",
      "run-permission-switch.sh",
    ]);
    expect(names).toContain("w3-run.sh");
  });
});

describe("控制变量闸：先键存在再取值相等", () => {
  test("check-controlled-vars.py 扫 W3 三臂（含 A3）", () => {
    const src = readFileSync(join(HARBOR, "check-controlled-vars.py"), "utf8");
    expect(src).toContain("w3-cc-sonnet-54");
    expect(src).toContain("agent_timeout_multiplier");
    expect(src).toContain("键缺失");
  });

  test("五个 multiplier 全在 MULTIPLIER_KEYS 里", () => {
    const src = readFileSync(join(HARBOR, "check-controlled-vars.py"), "utf8");
    for (const k of [
      "timeout_multiplier",
      "agent_timeout_multiplier",
      "verifier_timeout_multiplier",
      "agent_setup_timeout_multiplier",
      "environment_build_timeout_multiplier",
    ]) {
      expect(src).toContain(`"${k}"`);
    }
  });
});

describe("Python 闸的行为测试本机可跑（CI 上也跑，不 skip）", () => {
  // 这些测试只用 stdlib，不 import harbor。CI 上 python3 在。
  // 「探测失败就 skip」= 门禁不存在。
  for (const script of [
    "test-taskset-fp.py",
    "test-check-controlled-vars.py",
    "test-w3-summary.py",
  ]) {
    test(`${script} 退出 0`, () => {
      const r = spawnSync("python3", [join(HARBOR, script)], {
        encoding: "utf8",
        cwd: HARBOR,
        timeout: 60_000,
      });
      if (r.status !== 0) {
        throw new Error(`${script} rc=${r.status}\nstdout:\n${r.stdout}\nstderr:\n${r.stderr}`);
      }
      expect(r.status).toBe(0);
    });
  }
});
