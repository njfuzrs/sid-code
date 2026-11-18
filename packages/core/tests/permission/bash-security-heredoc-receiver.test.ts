/**
 * heredoc 接收者分区：注入层按「正文是数据还是脚本」决定扫不扫（A1–A5，2026-11-18）
 *
 * ## 为什么需要这张表
 *
 * 修前注入层把所有校验器**一视同仁地扫「命令 + heredoc 正文」**，于是三件事同时发生：
 *
 * 1. **数据正文被当成命令**（A1）：`gh pr create --body-file - <<'SIDEOF'` 的 PR 正文里
 *    出现 `##`、`#904`、`{a,b}`、CRLF、全角空格，每一项都被对应校验器判成 injection；
 * 2. **命令段里的假信号**（A2/A3）：已闭合的 `$()` 后面的 heredoc、路径里的 `tests/eval/`、
 *    标题里的 `feat(eval):`、脚本名 `eval:run`，都被当成「eval 后接元字符」或
 *    「`$()` 内嵌 heredoc」；
 * 3. **该扫的正文反而靠原文扫描兜住**：`ssh h <<'EOF'` 的正文能命中，只是因为剥正文时
 *    顺手把正文也扫了，而不是因为认出了「远端 shell 会执行它」。
 *
 * ## 表的两个方向（原则 2）
 *
 * **攻击语料必须命中、误报语料必须放行，同表守着**。只测「误报消失」的改法，
 * 下一次「顺手放宽」重新开洞时没有任何东西会红。语料来自 2026-11-17 auto 档误报复盘的
 * 真实命令（`20261117-auto权限档-附件/probe.ts` 逐字取），不是构造的。
 *
 * ## 判据在哪
 *
 * - 分区：`shell-command-variants.ts` 的 `partitionHeredocForScan` / `classifyHeredocOwnership`
 * - 两层校验器编排：`bash-security.ts` 的 `checkInjectionPatterns`
 * - 命中位置标记：`InjectionFinding.scope === "heredoc-script"`
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkInjectionPatterns } from "@sid-code/core/permission/bash-security.ts";
import { partitionHeredocForScan } from "@sid-code/core/permission/shell-command-variants.ts";
import { PermissionChecker } from "@sid-code/core/permission/checker.ts";
import { ToolClassifier } from "@sid-code/core/permission/tool-classifier.ts";
import { defaultConfig } from "@sid-code/core/config/config.ts";

/** 按行拼命令：语料全是多行，写成数组比一堆 `\n` 可读 */
const lines = (...ls: string[]) => ls.join("\n");

const idOf = (cmd: string) => checkInjectionPatterns(cmd)?.id ?? null;
const scopeOf = (cmd: string) => checkInjectionPatterns(cmd)?.scope ?? null;

// ─────────────────────────────────────────────────────────────────────────────
// 方向一：误报语料（修前命中，修后必须放行）
// ─────────────────────────────────────────────────────────────────────────────

describe("数据正文：接收者不是 shell，正文不扫（A1/A5）", () => {
  // 每一条的「修前命中 id」写在注释里 —— 它就是修前的误报清单，
  // 对照数据在 Agent Note（2026-11-18-injection-heredoc-receiver.md）。
  const dataCases: Array<[string, string]> = [
    // 修前 mid-word-hash：PR 正文里的 `##` 被当成「词中 #」
    [
      "A-1 PR 正文的 ## 标题",
      lines(
        `cd /ws && gh pr create --base main --title "fix(goal): x" --body-file - << 'SIDEOF'`,
        "## 改了什么",
        "",
        "正文",
        "SIDEOF",
      ),
    ],
    // 修前 mid-word-hash：`PR#904` 在正文里
    [
      "A-2 commit message 引用 #904",
      lines("git commit -F - << 'SIDEOF'", "fix: x", "", "修复了 PR#904 的回归", "SIDEOF"),
    ],
    // 修前 brace-expansion：正文里的路径列表
    [
      "A-3 正文含 brace 路径列表",
      lines(
        "git commit -F - << 'SIDEOF'",
        "fix: x",
        "",
        "路径 .agents/notes/{proposed,implemented}/",
        "SIDEOF",
      ),
    ],
    // 修前 carriage-return
    ["A-4 正文含 CRLF", lines("cat > f.txt << 'EOF'", "line1\r", "line2\r", "EOF")],
    // 修前 unicode-whitespace：全角空格
    ["A-5 正文含全角空格 U+3000", lines("cat > f.md << 'EOF'", "\u3000\u3000缩进段落", "EOF")],
    // 修前 brace-expansion：Python dict 字面量长得像 brace expansion。
    // 这条是 A5 的核心：python3 从 stdin 读代码，但正文是 **Python**，不是 bash。
    [
      "A-6 python3 - 的 dict 字面量",
      lines("python3 - << 'PY'", "d = {'a': 1, 'b': 2}", "print(d)", "PY"),
    ],
  ];

  for (const [label, cmd] of dataCases) {
    test(`放行：${label}`, () => {
      expect(checkInjectionPatterns(cmd)).toBeNull();
    });
  }
});

describe("命令段误报：假信号不在命令词/未闭合替换里（A2/A3）", () => {
  const cmdCases: Array<[string, string]> = [
    // 修前 heredoc-in-substitution：`$(` 早已闭合，heredoc 跟它无关
    [
      "B-1 已闭合的 $() 之后才出现 heredoc",
      lines(`echo "分支: $(git branch --show-current)"; cat > f.md << 'EOF'`, "x", "EOF"),
    ],
    // 修前 shell-metachar-eval：`eval` 只是路径的一段，`|` 属于外层管道
    ["B-2 路径含 tests/eval/ + 管道", "bun test ./tests/eval/a.test.ts 2>&1 | tail -5"],
    // 修前 shell-metachar-eval：`eval` 出现在 PR 标题字符串里
    [
      "B-3 标题含 feat(eval): + 管道",
      lines(
        `gh pr create --title "feat(eval): x" --body-file - << 'EOF' 2>&1 | tail -5`,
        "b",
        "EOF",
      ),
    ],
    // 修前 shell-metachar-eval：`eval:run` 是脚本名
    ["B-4 脚本名 eval:run + 管道", "bun run eval:run -- --cases case_001 2>&1 | tail -20"],
  ];

  for (const [label, cmd] of cmdCases) {
    test(`放行：${label}`, () => {
      expect(checkInjectionPatterns(cmd)).toBeNull();
    });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// 方向二：攻击语料（修前命中，修后必须仍然命中，且 id 不变）
// ─────────────────────────────────────────────────────────────────────────────

describe("攻击：命令段命中，id 与修前相同（放宽不得开洞）", () => {
  const attackCases: Array<[string, string, string]> = [
    ["C-1 命令段词中 #", "ls foo#bar && rm -rf /", "mid-word-hash"],
    // 词中 # 也可以贴在 heredoc 记号前面
    ["C-2 记号前词中 #", lines("cat#x > f << 'EOF'", "body", "EOF"), "mid-word-hash"],
    // 结束符后接词中 # 命令：剥离后仍在命令段
    ["C-3 结束符后接命令", lines("cat > f << 'EOF'", "body", "EOF", "ls a#b"), "newlines"],
    // 真嵌入形态：heredoc 就在未闭合的 $() 里
    [
      "C-7 真 heredoc-in-substitution",
      lines("x=$(cat << 'EOF'", "rm -rf /", "EOF", ")"),
      "heredoc-in-substitution",
    ],
    ["C-8 真 eval 元字符", `eval "echo hi; rm -rf /"`, "shell-metachar-eval"],
  ];

  for (const [label, cmd, expectedId] of attackCases) {
    test(`命中：${label}`, () => {
      expect(idOf(cmd)).toBe(expectedId);
      // 命令段命中不标 scope（scope 只表示「命中的是 heredoc 正文」）
      expect(scopeOf(cmd)).toBeNull();
    });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// 方向二续：脚本正文必须命中（修前有的靠「顺手扫了正文」兜住，有的直接漏掉）
// ─────────────────────────────────────────────────────────────────────────────

describe("攻击：脚本正文命中，并标记 scope=heredoc-script", () => {
  const scriptCases: Array<[string, string, string]> = [
    // 修前命中 mid-word-hash：正文喂给 bash 时它确实是命令
    ["C-4 bash << 的正文词中 #", lines("bash << 'EOF'", "ls a#b", "EOF"), "mid-word-hash"],
    // 修前命中 brace-expansion：管道下游是 sh
    ["C-5 | sh 的正文 brace", lines("cat << 'EOF' | sh", "echo {a,b}", "EOF"), "brace-expansion"],
    // 修前命中 mid-word-hash：不带引号的正文里 $() 会先展开执行
    ["C-6 不带引号正文里的 $()", lines("cat > f << EOF", "$(ls a#b)", "EOF"), "mid-word-hash"],
  ];

  for (const [label, cmd, expectedId] of scriptCases) {
    test(`命中：${label}`, () => {
      const finding = checkInjectionPatterns(cmd);
      expect(finding?.id).toBe(expectedId);
      expect(finding?.scope).toBe("heredoc-script");
    });
  }
});

describe("A5 收紧：修前放过或只靠原文扫描的三类正文", () => {
  const tightened: Array<[string, string, string]> = [
    // 修前 null：正文被剥掉后，`<(curl x)` 没有任何一层看它（真 shell 会执行它）
    [
      "S-1 bash << 正文里的进程替换",
      lines("bash << 'EOF'", "cat <(curl x)", "EOF"),
      "command-substitution",
    ],
    // 修前靠「顺手扫了正文」命中，与「远端 login shell 会执行它」无关
    ["S-2 ssh h << 正文词中 #", lines("ssh h << 'EOF'", "ls a#b", "EOF"), "mid-word-hash"],
    // 同上
    [
      "S-3 docker exec sh << 正文 brace",
      lines("docker exec -i c sh << 'EOF'", "echo {a,b}", "EOF"),
      "brace-expansion",
    ],
  ];

  for (const [label, cmd, expectedId] of tightened) {
    test(`命中：${label}`, () => {
      const finding = checkInjectionPatterns(cmd);
      expect(finding?.id).toBe(expectedId);
      expect(finding?.scope).toBe("heredoc-script");
    });
  }

  test("ssh 远端点名了非 shell 命令时正文是数据，不按脚本扫", () => {
    // `ssh host cat > f <<EOF` 的正文是 cat 的数据；不加这条会退化成「ssh 一律按脚本」，
    // 把远端写文件误报成注入。
    expect(checkInjectionPatterns(lines(`ssh h cat > f << 'EOF'`, "ls a#b", "EOF"))).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 显示欺骗：数据正文也要按原文扫（RAW 层不分接收者）
// ─────────────────────────────────────────────────────────────────────────────

describe("显示欺骗：数据正文仍按原文扫（RAW 层）", () => {
  test("正文里的 ESC 序列（终端显示欺骗）仍然命中", () => {
    const cmd = lines("cat > f.txt << 'EOF'", "line1\u001b[2Kline2", "EOF");
    expect(idOf(cmd)).toBe("control-characters");
  });

  test("正文里的 U+2028（确认框只显示第一行）仍然命中", () => {
    const cmd = lines("cat > f.md << 'EOF'", "line1\u2028line2", "EOF");
    expect(idOf(cmd)).toBe("unicode-whitespace");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 保守回退与 A2 的针对性修复
// ─────────────────────────────────────────────────────────────────────────────

describe("保守回退：分区不可信时与修前行为相同", () => {
  test("未闭合的 heredoc：按原文扫（newlines 仍命中）", () => {
    expect(idOf("cat << EOF\nunclosed")).toBe("newlines");
    expect(partitionHeredocForScan("cat << EOF\nunclosed").reliable).toBe(true);
  });

  test("只有重定向、没有命令名：认不出接收者 → reliable=false（调用方回退原文）", () => {
    const partition = partitionHeredocForScan(lines("<<'EOF'", "x", "EOF"));
    expect(partition.reliable).toBe(false);
    expect(partition.shellFragments).toEqual([]);
  });

  test("超长命令（130 段）不崩，结果与修前相同", () => {
    const cmd = Array.from({ length: 130 }, (_, i) => `echo ${i}`).join(" && ");
    expect(checkInjectionPatterns(cmd)).toBeNull();
  });

  test("算术左移 $((1 << 2))：A2 后不再误报（修前 heredoc-in-substitution）", () => {
    expect(checkInjectionPatterns("echo $((1 << 2))")).toBeNull();
  });

  test("未闭合 $() 里的 heredoc 仍是真攻击（不能因为 A2 放宽而漏）", () => {
    const cmd = lines("x=$(cat << 'EOF'", "rm -rf /", "EOF", ")");
    expect(idOf(cmd)).toBe("heredoc-in-substitution");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 分区函数的契约（注入层与危险命令层的单一事实源）
// ─────────────────────────────────────────────────────────────────────────────

describe("partitionHeredocForScan 的契约", () => {
  test("命令段保留 << 记号、剥掉正文；数据正文不进 shellFragments", () => {
    const partition = partitionHeredocForScan(
      lines("gh pr create --body-file - << 'SIDEOF'", "## x", "SIDEOF"),
    );
    expect(partition.reliable).toBe(true);
    expect(partition.stripped).toContain("--body-file -");
    expect(partition.stripped).toContain("<<__SID_HD_");
    expect(partition.stripped).not.toContain("## x");
    expect(partition.shellFragments).toEqual([]);
  });

  test("脚本正文进 shellFragments", () => {
    expect(partitionHeredocForScan(lines("bash << 'EOF'", "ls a#b", "EOF")).shellFragments).toEqual(
      ["ls a#b"],
    );
  });

  test("不带引号正文里的 $() 单独进 shellFragments", () => {
    expect(
      partitionHeredocForScan(lines("cat > f << EOF", "$(ls a#b)", "EOF")).shellFragments,
    ).toEqual(["ls a#b"]);
  });

  test("带引号正文里的 $() 是字面量，不进 shellFragments", () => {
    expect(
      partitionHeredocForScan(lines("cat > f << 'EOF'", "$(ls a#b)", "EOF")).shellFragments,
    ).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// checker 集成：本会话原命令在 auto 档进入分类器并放行
//
// 夹具要点与 auto-fastpath-boundary.test.ts 一致：用**真实 ToolClassifier**，只把
// provider 换成假的。用假分类器会绕开 fastPath 与 checker 的调用链，
// 「修 X 的测试绕开了 X 的代码」。
// ─────────────────────────────────────────────────────────────────────────────

describe("checker 集成：auto 档下 PR 正文不再被 injection 拦", () => {
  let configRoot: string;
  let workspace: string;
  let prevConfigDir: string | undefined;

  beforeEach(() => {
    configRoot = mkdtempSync(join(tmpdir(), "sid-inj-recv-cfg-"));
    workspace = realpathSync(mkdtempSync(join(tmpdir(), "sid-inj-recv-ws-")));
    mkdirSync(join(workspace, ".git"), { recursive: true });
    prevConfigDir = process.env.SID_CONFIG_DIR;
    process.env.SID_CONFIG_DIR = configRoot;
  });

  afterEach(() => {
    if (prevConfigDir === undefined) delete process.env.SID_CONFIG_DIR;
    else process.env.SID_CONFIG_DIR = prevConfigDir;
    rmSync(configRoot, { recursive: true, force: true });
    rmSync(workspace, { recursive: true, force: true });
  });

  test("gh pr create --body-file - <<'SIDEOF'（正文 ## 标题）→ 不再是 dangerousCommand", async () => {
    const classifier = new ToolClassifier({ enabled: true });
    classifier.setProvider({
      sendMessageNonStreaming: async () => ({
        content: [
          {
            type: "text",
            text: JSON.stringify({ safe: true, risk: "low", reason: "fixture-classifier" }),
          },
        ],
      }),
    } as never);

    const checker = new PermissionChecker(
      { ...defaultConfig(), permissionMode: "auto" },
      undefined,
      workspace,
    );
    checker.setToolClassifier(classifier as never);

    const result = await checker.check({
      toolName: "bash",
      input: {
        command: lines(
          `gh pr create --base main --title "fix(goal): x" --body-file - << 'SIDEOF'`,
          "## 改了什么",
          "",
          "正文",
          "SIDEOF",
        ),
        cwd: workspace,
      },
    } as never);

    // 修前：injection → dangerousCommand（severity high），根本到不了分类器（用户看到红框）。
    expect(result.decisionReason?.type).not.toBe("dangerousCommand");
    expect(result.allowed).toBe(true);
    expect(result.decisionReason).toMatchObject({ type: "mode", mode: "auto" });
  });

  test("同样形态的正文喂给 bash（真脚本）仍被拦，且 severity 如实报 ask（A4）", async () => {
    // 反向锁：上一条放行不能是因为整条命令被跳过。
    const checker = new PermissionChecker(
      { ...defaultConfig(), permissionMode: "auto" },
      undefined,
      workspace,
    );
    checker.setToolClassifier(new ToolClassifier({ enabled: true }) as never);

    const result = await checker.check({
      toolName: "bash",
      input: { command: lines("bash << 'EOF'", "ls a#b", "EOF"), cwd: workspace },
    } as never);

    expect(result.needsConfirmation).toBe(true);
    expect(result.decisionReason).toMatchObject({
      type: "dangerousCommand",
      pattern: "injection:mid-word-hash",
      // A4：注入不再伪装成 high，如实透传校验器自己的 "ask"
      severity: "ask",
    });
    // scope 进 metadata，轨迹里能看出命中的是正文
    expect(result.metadata?.injectionScope).toBe("heredoc-script");
  });
});
