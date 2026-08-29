/**
 * `evals/CLAUDE.md` 引用出处门禁
 *
 * ## 这份测试为什么必须存在
 *
 * `evals/CLAUDE.md` 的每条规则都带 `file:line` 出处，而它自己在文件顶部写着：
 * 「出处失效的规则要么更新出处，要么删掉」。**没有门禁的话这句话就是一句空话** ——
 * 行号会随任何一次重构静默漂移，而漂移**不会让任何测试变红**：
 * 规则还在、读起来照样正当，只是**追不到源头了**。
 *
 * 那正是本仓最贵的那类失效（`evals/CLAUDE.md` §1.3 / §4.4）：
 * 一条追不到出处的规则，和一条编出来的规则，对下一个读者是同一个东西。
 *
 * ## 判据形态：只查「文件存在 + 行号在范围内 + 该行/邻近有锚点关键词」
 *
 * ⛔ **刻意不做逐字比对**：那会让任何一次无害的措辞调整都变红，
 * 门禁很快会被加豁免、被跳过，最后变成死功能（本仓 `伪配置/死功能` 同型）。
 * 所以判据是**锚点关键词命中**，容忍行号 ±@{TOLERANCE} 行的自然漂移。
 *
 * ⚠️ 本文件只校验**指向本仓内的**出处；指向 `docs-research/`（独立仓库）的一条
 * 不校验，因为那个路径在 CI 上不存在 —— 而「CI 上永远 skip」正是 §4.2 那条坑。
 * 故那条出处在下面被显式登记为豁免，而不是让整条断言静默让路。
 */

import { describe, test, expect } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const REPO_ROOT = join(import.meta.dir, "..", "..");
const CLAUDE_MD = join(REPO_ROOT, "evals", "CLAUDE.md");

/** 行号允许的自然漂移。给措辞/缩进调整留空间，但不足以指到另一段逻辑。 */
const TOLERANCE = 12;

/**
 * 每条被校验的出处：文件 + 期望行号 + 该处必须出现的锚点关键词。
 *
 * 锚点选的是**该处代码/注释里最稳定的那个 token**（变量名、字面量、
 * 已定案的术语），不是整句话 —— 见文件头的「判据形态」。
 */
const CITATIONS: { file: string; line: number; anchor: string; what: string }[] = [
  // ── §2.1 跨链路对齐：权限档与超时 ──
  {
    file: "evals/external-benchmarks/swe-bench/exec-swebench.sh",
    line: 150,
    anchor: "--dangerously-skip-permissions",
    what: "swe-bench 权限档（正确做法）",
  },
  {
    file: "evals/external-benchmarks/swe-bench/exec-swebench.sh",
    line: 99,
    anchor: "SWE_MAX_TURNS",
    what: "swe-bench max_turns 默认 40",
  },
  {
    file: "evals/external-benchmarks/swe-bench/exec-swebench.sh",
    line: 100,
    anchor: "SWE_TIMEOUT",
    what: "swe-bench 超时 1800s",
  },
  {
    file: "evals/external-benchmarks/swe-bench/exec-swebench.sh",
    line: 103,
    anchor: "costLimit=100",
    what: "§3.9 团队默认模板静默结束整轮",
  },
  {
    file: "evals/external-benchmarks/swe-bench/exec-swebench.sh",
    line: 1257,
    anchor: "113 次权限拒绝",
    what: "§0/§3.5 那份被两边引用的实测",
  },
  // ── Harbor 侧 ──
  {
    file: "evals/external-benchmarks/harbor/sid_code_agent.py",
    line: 170,
    anchor: "default=40",
    what: "harbor max_turns 默认 40",
  },
  {
    file: "evals/external-benchmarks/harbor/sid_code_agent.py",
    line: 180,
    anchor: 'default="acceptEdits"',
    what: "⛔ harbor 权限档（现存缺陷）",
  },
  {
    file: "evals/external-benchmarks/harbor/sid_code_agent.py",
    line: 256,
    anchor: "_ELF_MACHINE",
    what: "§3.3 按 ELF e_machine 判架构",
  },
  {
    file: "evals/external-benchmarks/harbor/sid_code_agent.py",
    line: 441,
    anchor: "artifact-bytes",
    what: "§3.1/§3.2 产物身份与 commit_source",
  },
  {
    file: "evals/external-benchmarks/harbor/sid_code_agent.py",
    line: 645,
    anchor: "_derive_is_error",
    what: "§3.7 判成败用 subtype 不用 is_error",
  },
  {
    file: "evals/external-benchmarks/harbor/sid_code_agent.py",
    line: 505,
    anchor: "stream-json",
    what: "§3.8 输出格式",
  },
  {
    file: "evals/external-benchmarks/harbor/sid_code_agent.py",
    line: 761,
    anchor: "total_cumulative_prompt_tokens",
    what: "§1.6 stock vs flow",
  },
  {
    file: "evals/external-benchmarks/harbor/sid_code_agent.py",
    line: 486,
    anchor: "提示模板**静默失效**",
    what: "§2.3 提示模板静默失效",
  },
  {
    file: "evals/external-benchmarks/harbor/README.md",
    line: 253,
    anchor: "verifier 坏掉的比例",
    what: "§3.4 -n 并发与 verifier",
  },
  // ── 横评 provider 不对称（⛔ 现存缺陷）──
  {
    file: "evals/providers/claude-code.ts",
    line: 27,
    anchor: "skipPermissions = true",
    what: "§2.1 对照 agent 默认不戴手铐",
  },
  {
    file: "evals/providers/claude-code.ts",
    line: 25,
    anchor: "360_000",
    what: "§2.1 claude-code 超时",
  },
  {
    file: "evals/providers/sid-code-live.ts",
    line: 28,
    anchor: "480_000",
    what: "§2.1 sid-code-live 超时（与上一条不对称）",
  },
  {
    file: "evals/providers/sid-code-live.ts",
    line: 30,
    anchor: "permissionMode",
    what: "§2.1 我们这侧无 skipPermissions 选项",
  },
  // ── 门禁自身 ──
  {
    file: "tests/eval/harbor-agent-contract.test.ts",
    line: 7,
    anchor: "一道都不认",
    what: "§4.1 五道门禁不认 .py",
  },
  {
    file: "tests/eval/harbor-agent-contract.test.ts",
    line: 259,
    anchor: "不出现 dangerously-skip-permissions",
    what: "§1.3/§4.4 判据错了的那道门禁本体",
  },
  {
    file: "evals/external-benchmarks/harbor/sid_code_agent.py",
    line: 706,
    anchor: "**flow**",
    what: "§1.6 stock/flow 口径表",
  },
];

/** 指向仓库外的出处：显式登记豁免，而不是让断言静默让路（§4.2）。 */
const EXTERNAL_REFS = ["docs-research/"];

describe("evals/CLAUDE.md 的出处必须都能追到（防规则与源码静默漂移）", () => {
  const md = readFileSync(CLAUDE_MD, "utf-8");

  test.each(CITATIONS)("$what → $file:$line", ({ file, line, anchor }) => {
    const abs = join(REPO_ROOT, file);
    expect(existsSync(abs)).toBe(true);

    const lines = readFileSync(abs, "utf-8").split("\n");
    expect(lines.length).toBeGreaterThanOrEqual(line);

    // 锚点须出现在 [line-TOLERANCE, line+TOLERANCE] 窗口内。
    const from = Math.max(0, line - 1 - TOLERANCE);
    const window = lines.slice(from, line - 1 + TOLERANCE + 1).join("\n");
    expect(window).toContain(anchor);
  });

  test("CLAUDE.md 里出现的每个仓内 file:line 出处都在上面登记了", () => {
    // 防的是「加了新规则、带了新出处，但没进这份门禁」——
    // 那条新出处就又回到「无人校验、可以静默漂移」的状态。
    const cited = new Set<string>();
    // 形如 `path/to/file.ext:123` 或 `:123-456`（反引号内，允许前缀路径省略）
    for (const m of md.matchAll(/`([A-Za-z0-9_./-]+\.(?:ts|py|sh|md)):(\d+)/g)) {
      cited.add(`${m[1]!}:${m[2]!}`);
    }
    expect(cited.size).toBeGreaterThan(10); // 抠空了的话下面是空转（§4.3 第三类变异）

    const registered = new Set(CITATIONS.map((c) => `${c.file.split("/").pop()!}:${c.line}`));
    const unregistered = [...cited].filter((c) => {
      const [f, l] = c.split(":") as [string, string];
      const base = f.split("/").pop()!;
      if (EXTERNAL_REFS.some((e) => md.includes(e) && f.includes(e.replace("/", "")))) return false;
      // 允许 ±TOLERANCE：文中同一处可能写成范围起点，登记的是另一端
      for (const r of registered) {
        const [rf, rl] = r.split(":") as [string, string];
        if (rf === base && Math.abs(Number(rl) - Number(l)) <= TOLERANCE) return false;
      }
      return true;
    });
    expect(unregistered).toEqual([]);
  });

  test("⛔ 现存缺陷标记必须还指着真的缺陷（修好了要来改这里）", () => {
    // 这三处在文中标了 ⛔「现存缺陷」。它们一旦被修，本条会红 ——
    // 提醒来人把 CLAUDE.md 从「现存缺陷」改成「已修 + 出处」。
    // 一份把已修缺陷写成现存的文档，会让下一个人重新"修"一遍。
    const harborPy = readFileSync(
      join(REPO_ROOT, "evals/external-benchmarks/harbor/sid_code_agent.py"),
      "utf-8",
    );
    expect(harborPy).toContain('default="acceptEdits"');

    const sidLive = readFileSync(join(REPO_ROOT, "evals/providers/sid-code-live.ts"), "utf-8");
    expect(sidLive).not.toContain("skipPermissions");
    expect(sidLive).toContain("480_000");

    const ccLive = readFileSync(join(REPO_ROOT, "evals/providers/claude-code.ts"), "utf-8");
    expect(ccLive).toContain("skipPermissions = true");
    expect(ccLive).toContain("360_000");
  });
});
