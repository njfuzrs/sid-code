/**
 * 「始终允许」按子命令前缀记的规则生成测试（B9 / PR-5）。
 *
 * 断言锁的是**用户可感知的放行范围**，不是实现细节：
 * ① 复合命令换参数后必须命中（否则「始终允许」等于没点）；
 * ② 解释器类不得生成前缀规则（`python3 *` = 放行任意脚本）；
 * ③ 危险确认只记整条精确（一次人工确认 ≠ 以后这类都放行）；
 * ④ 超过 5 条退回整条精确（对齐 CC）；
 * ⑤ 规则语法表达不了的命令退回会话记忆（不生成会静默失效或过宽的规则）。
 *
 * 端到端那条（用例「生成的规则能被复合命令命中」）走真实 PermissionChecker：
 * 纯函数断言只能证明「生成对了」，证明不了「生成的东西真的会生效」。
 */

import { describe, test, expect } from "bun:test";
import {
  buildBashAllowRules,
  MAX_BASH_ALLOW_RULES,
} from "@sid-code/core/permission/bash-allow-rules.ts";
import { PermissionChecker } from "@sid-code/core/permission/checker.ts";
import { defaultConfig } from "@sid-code/core/config/config.ts";
import { matchShellRulePattern } from "@sid-code/core/permission/shell-rule-matching.ts";

describe("buildBashAllowRules — 复合命令按子命令拆", () => {
  test("cd + 管道 + 重导向：只记需要批准的那一段，生成前缀规则", () => {
    const plan = buildBashAllowRules("cd /ws && bun test a.test.ts 2>&1 | tail -30");
    expect(plan.rules).toEqual(["Bash(bun test *)"]);
    expect(plan.fallback).toBeUndefined();
    // 免确认段不进规则（cd / 管道过滤器本来就不需要批准）
    expect(plan.skipped).toContain("cd /ws");
    expect(plan.skipped).toContain("tail -30");
  });

  test("多个待批准子命令：每段一条规则，保持出现顺序", () => {
    const plan = buildBashAllowRules("git push origin main && npm test");
    expect(plan.rules).toEqual(["Bash(git push *)", "Bash(npm test *)"]);
  });

  test("同一程序重复出现只留一条（去重）", () => {
    const plan = buildBashAllowRules("bun test a.ts && bun test b.ts");
    expect(plan.rules).toEqual(["Bash(bun test *)"]);
  });

  test("名单外的程序只取「程序名 + *」", () => {
    expect(buildBashAllowRules("rsync -av a/ b/").rules).toEqual(["Bash(rsync *)"]);
    expect(buildBashAllowRules("curl -s https://x.test/a").rules).toEqual(["Bash(curl *)"]);
  });

  test(`超过 ${MAX_BASH_ALLOW_RULES} 条退回整条精确规则`, () => {
    // 六段都要「需要批准」——混进只读段会被跳过，规则数就不是 6 了
    const command = "rsync a b && curl x && wget y && docker ps && npm test && cargo build";
    const plan = buildBashAllowRules(command);
    expect(plan.fallback).toBe("too-many");
    expect(plan.rules).toEqual([`Bash(${command})`]);
  });

  test("上限可调（给未来的「更保守」留口子）", () => {
    const plan = buildBashAllowRules("npm test && npm run build", { maxRules: 1 });
    expect(plan.fallback).toBe("too-many");
    expect(plan.rules).toEqual(["Bash(npm test && npm run build)"]);
  });
});

describe("buildBashAllowRules — 解释器只给精确规则", () => {
  test("python3 x.py 精确记，不会放行 python3 y.py", () => {
    const plan = buildBashAllowRules("python3 x.py");
    expect(plan.rules).toEqual(["Bash(python3 x.py)"]);
    expect(matchShellRulePattern("python3 x.py", "python3 y.py")).toBe(false);
  });

  test("带版本号的解释器（python3.12）同样只精确", () => {
    expect(buildBashAllowRules("python3.12 x.py").rules).toEqual(["Bash(python3.12 x.py)"]);
  });

  test.each(["node app.js", "bash deploy.sh", "sh run.sh", "ruby x.rb", "perl x.pl"])(
    "%s 只精确",
    (cmd) => {
      expect(buildBashAllowRules(cmd).rules).toEqual([`Bash(${cmd})`]);
    },
  );

  test("包装器（xargs / env / sudo / timeout）只精确", () => {
    for (const cmd of ["xargs rm", "env FOO=1 node x.js", "sudo rm x", "timeout 5 curl x"]) {
      expect(buildBashAllowRules(cmd).rules).toEqual([`Bash(${cmd})`]);
    }
  });

  test("bun -e / bun run <文件> 只精确（bun 在这两种形态下是解释器）", () => {
    // 用不含括号的表达式：含 `(` 的命令会先命中 unrepresentable，测不到这里的分支
    expect(buildBashAllowRules("bun -e 1+1").rules).toEqual(["Bash(bun -e 1+1)"]);
    expect(buildBashAllowRules("bun run scripts/x.ts").rules).toEqual([
      "Bash(bun run scripts/x.ts)",
    ]);
  });

  test("find -exec 只精确（命令位置在选项后面，前缀规则说不清）", () => {
    const cmd = "find . -name x.tmp -exec rm {} +";
    expect(buildBashAllowRules(cmd).rules).toEqual([`Bash(${cmd})`]);
  });

  test("前导变量赋值只精确（值任意没法用前缀表达）", () => {
    const cmd = "FOO=1 curl -s https://x.test";
    expect(buildBashAllowRules(cmd).rules).toEqual([`Bash(${cmd})`]);
  });

  test("第一个位置参数是路径时只精确（git -C /repo log 不猜动作）", () => {
    const cmd = "git -C /repo log --oneline";
    expect(buildBashAllowRules(cmd).rules).toEqual([`Bash(${cmd})`]);
  });
});

describe("buildBashAllowRules — 危险确认只记整条精确", () => {
  test("dangerous=true 时不生成前缀规则，且标记 dangerous", () => {
    const plan = buildBashAllowRules("cd /ws && rm -rf build | tail -5", { dangerous: true });
    expect(plan.fallback).toBe("dangerous");
    expect(plan.rules).toEqual(["Bash(cd /ws && rm -rf build | tail -5)"]);
  });

  test("dangerous=true 时不做子命令拆分（整条作为一条精确规则）", () => {
    const plan = buildBashAllowRules("git push --force origin main", { dangerous: true });
    expect(plan.rules).toHaveLength(1);
    expect(plan.rules[0]).toBe("Bash(git push --force origin main)");
  });
});

describe("buildBashAllowRules — 规则语法表达不了时退回会话记忆", () => {
  test("含 `(` / `)` 的命令不生成规则（Bash() 里会让解析提前截断，规则静默失效）", () => {
    expect(buildBashAllowRules("echo $(date)").fallback).toBe("unrepresentable");
    expect(buildBashAllowRules("echo $(date)").rules).toEqual([]);
  });

  test("含 `*` 的命令不生成规则（精确规则里的 * 会被当通配，比批准范围宽）", () => {
    expect(buildBashAllowRules("rsync src/*.ts dest/").fallback).toBe("unrepresentable");
  });

  test("危险确认 + 无法表达：同样退回（宁可只记会话记忆）", () => {
    const plan = buildBashAllowRules("rm -rf $(cat list.txt)", { dangerous: true });
    expect(plan.fallback).toBe("unrepresentable");
    expect(plan.rules).toEqual([]);
  });
});

describe("buildBashAllowRules — 无需规则的命令", () => {
  test("空命令", () => {
    expect(buildBashAllowRules("   ")).toEqual({
      rules: [],
      fallback: "nothing-to-ask",
      skipped: [],
    });
  });

  test("全只读命令不产生规则（它们本来就走免确认路径）", () => {
    const plan = buildBashAllowRules("ls && cat package.json | head");
    expect(plan.fallback).toBe("nothing-to-ask");
    expect(plan.rules).toEqual([]);
    expect(plan.skipped).toEqual(["ls", "cat package.json", "head"]);
  });

  test("只读 + 待批准混合：只给待批准那段生成规则", () => {
    const plan = buildBashAllowRules("git status && npm test");
    expect(plan.rules).toEqual(["Bash(npm test *)"]);
    expect(plan.skipped).toContain("git status");
  });
});

describe("端到端：生成的规则真的命中（验收 §6.1）", () => {
  /** 用真实 checker + 会话规则验证「命中 / 不命中」，而不是只断言纯函数输出 */
  function checkerWithRules(rules: string[]): PermissionChecker {
    const checker = new PermissionChecker(defaultConfig());
    const loader = checker.getRuleLoader();
    for (const rule of rules) loader.addSessionRule("allow", rule);
    checker.refreshRulesFromLoader();
    return checker;
  }

  test("Bash(bun test *) 能被「cd <ws> && bun test b.test.ts | head」命中", async () => {
    const ws = process.cwd();
    // 规则来自用户批准的另一条命令
    const { rules } = buildBashAllowRules(`cd ${ws} && bun test a.test.ts 2>&1 | tail -30`);
    expect(rules).toEqual(["Bash(bun test *)"]);

    const checker = checkerWithRules(rules);
    const r = await checker.check({
      toolName: "bash",
      input: { command: `cd ${ws} && bun test b.test.ts | head` },
    });
    expect(r.allowed).toBe(true);
  });

  test("python3 精确规则不会放行另一个脚本", async () => {
    const { rules } = buildBashAllowRules("python3 x.py");
    const checker = checkerWithRules(rules);
    const r = await checker.check({ toolName: "bash", input: { command: "python3 y.py" } });
    expect(r.allowed).toBe(false);
    expect(r.needsConfirmation).toBe(true);
  });

  test("危险确认生成的精确规则不覆盖同程序的其它命令", async () => {
    const { rules } = buildBashAllowRules("git push --force origin main", { dangerous: true });
    const checker = checkerWithRules(rules);
    const other = await checker.check({
      toolName: "bash",
      input: { command: "git push origin main" },
    });
    expect(other.allowed).toBe(false);
  });
});
