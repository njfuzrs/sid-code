/**
 * A2 回归（2026-11-03 会话 3b4f9ca7 复盘）：`obfuscated-flags` 把 `echo "---"` 判成 flag 混淆。
 *
 * 缺陷形态：第 5 段状态机对「空白 + 引号 + 引号内容以 `-` 开头」一律命中，于是
 * `ls x && echo "---"` / `sed -n '1,40p' f; printf -- '--- x ---\n'` 这类**只读命令**
 * 全部被拒（本会话 4 个子代理共 21 次）。`---` / `--` / `- ` 被 bash 拼出来只是普通字符串，
 * 不可能是有效 flag。
 *
 * 两条修法各有独立断言（缺一条就退回误判或漏掉真绕过）：
 *   1. 引号内内容必须能构成 flag（`/^-{1,2}[A-Za-z0-9]/`），`---` 不算；
 *      引号内外是同一个 word（`"-"exec` 拼成 `-exec`），所以引号后的尾巴要一起看。
 *   2. echo / printf 的参数整体豁免，且**按子命令**判 —— 不再因为整条命令里有 `|&;` 而失效。
 *
 * 用例来源：GAIA 直接取本会话子代理会话记录里的**原文命令**，不手写近似形态 ——
 * 手写会丢掉让人误判的细节（`printf --`、`head -50`、`2>/dev/null` 的组合）。
 */

import { describe, test, expect } from "bun:test";
import { checkInjectionPatterns } from "@sid-code/core/permission/bash-security.ts";

/** 本会话被误判的 21 条真实命令（原文照抄自子代理会话记录） */
const REAL_READONLY_COMMANDS: string[] = [
  'ls /Users/zhourusheng/Code/person/github/ && echo "---" && ls /Users/zhourusheng/Code/person/github/hermes-agent && echo "---" && ls /Users/zhourusheng/Code/person/github/pi && echo "---" && ls /Users/zhourusheng/Code/person/github/opencode && echo "---" && ls /Users/zhourusheng/Code/person/github/deepseek-harness',
  'cd /Users/zhourusheng/Code/person/github/opencode && for w in sandbox bwrap bubblewrap seatbelt landlock firejail nsjail seccomp unshare cap-drop; do echo "--- $w ---"; grep -rn -i --include="*.ts" --include="*.tsx" "$w" packages/core/src packages/session-ui/src packages/tui/src packages/cli/src packages/process-daemon/src 2>/dev/null | grep -v node_modules | head -8; done',
  'ls /Users/zhourusheng/Code/person/claude-code 2>&1 | head -50; echo "---"; ls /Users/zhourusheng/Code/person/claude-code/src 2>&1 | head -50',
  "sed -n '885,905p' /Users/zhourusheng/Code/person/claude-code/src/tools/BashTool/BashTool.tsx; echo '--- Shell.ts 250-275 ---'; sed -n '240,280p' /Users/zhourusheng/Code/person/claude-code/src/utils/Shell.ts",
  "sed -n '85,140p' /Users/zhourusheng/Code/person/claude-code/src/entrypoints/sandboxTypes.ts; echo '--- package.json ---'; grep -n \"sandbox\" /Users/zhourusheng/Code/person/claude-code/package.json",
  'ls /Users/zhourusheng/Code/person/github/codex/codex-rs/ && echo "---" && ls /Users/zhourusheng/Code/person/github/codex/codex-rs/sandboxing/src/ 2>/dev/null && echo "---" && ls /Users/zhourusheng/Code/person/github/codex/codex-rs/linux-sandbox/ 2>/dev/null && echo "---" && ls /Users/zhourusheng/Code/person/github/codex/codex-rs/windows-sandbox-rs/ 2>/dev/null',
  'ls /Users/zhourusheng/Code/person/github/codex/codex-rs/execpolicy/src/ 2>/dev/null; echo "---"; ls /Users/zhourusheng/Code/person/github/codex/codex-rs/protocol/src/ | head -50',
  "cd /Users/zhourusheng/Code/person/github/codex/codex-rs/linux-sandbox/src && sed -n '1,40p' bwrap.rs | cat -n && echo '--- 390,430 ---' && sed -n '390,430p' bwrap.rs | cat -n",
  "cd /Users/zhourusheng/Code/person/github/codex/codex-rs/linux-sandbox/src && sed -n '1,30p' bwrap.rs | cat -n; printf -- '--- 390-430 ---\\n'; sed -n '390,430p' bwrap.rs | cat -n",
  "cd /Users/zhourusheng/Code/person/github/codex/codex-rs/execpolicy/src && cat -n decision.rs && printf -- '---- sandbox_migration head ----\\n' && head -60 sandbox_migration.rs",
  "cd /Users/zhourusheng/Code/person/github/codex/codex-rs/execpolicy/src && head -70 lib.rs && printf -- '---- rule types ----\\n' && grep -n \"pub enum Decision\\|Forbidden\\|Prompt\\|Allow\\|struct Rule\\|pub enum Rule\\|programs\" rule.rs | head -40",
  "cd /Users/zhourusheng/Code/person/github/codex/codex-rs/execpolicy/src && sed -n '1,70p' policy.rs && printf -- '---- eval ----\\n' && grep -n \"fn evaluate\\|fn check\\|Decision::\\|Evaluation\\|Unmatched\\|unmatched\" policy.rs | head -50",
  "cd /Users/zhourusheng/Code/person/github/codex/codex-rs && sed -n '430,500p' core/src/tools/orchestrator.rs | cat -n; printf -- '---- 640-690 ----\\n'; sed -n '640,690p' core/src/tools/orchestrator.rs",
  "cd /Users/zhourusheng/Code/person/github/codex/codex-rs && sed -n '1,30p' core/src/tools/runtimes/apply_patch.rs; printf -- '-- 85-135 --\\n'; sed -n '85,135p' core/src/tools/runtimes/apply_patch.rs; printf -- '-- 225,265 --\\n'; sed -n '225,265p' core/src/tools/runtimes/apply_patch.rs",
  "cd /Users/zhourusheng/Code/person/github/codex/codex-rs && sed -n '430,470p' core/src/tools/orchestrator.rs; printf -- '-- 655-675 --\\n'; sed -n '655,675p' core/src/tools/orchestrator.rs",
  "cd /Users/zhourusheng/Code/person/github/codex/codex-rs/windows-sandbox-rs && head -40 src/wfp.rs; printf -- '-- capabilities --\\n'; head -40 src/cap.rs",
  "cd /Users/zhourusheng/Code/person/github/codex/codex-rs/prompts/templates/permissions && cat sandbox_mode/read_only.md; printf -- '---- danger ----\\n'; cat sandbox_mode/danger_full_access.md",
  "cd /Users/zhourusheng/Code/person/github/codex/codex-rs/prompts/templates/permissions && cat sandbox_mode/read_only.md; echo '---- danger ----'; cat sandbox_mode/danger_full_access.md",
  "cd /Users/zhourusheng/Code/person/github/codex/codex-rs/prompts/templates/permissions && cat approval_policy/on_request.md; echo '---- never ----'; cat approval_policy/never.md",
  'ls /Users/zhourusheng/Code/person/github/gemini-cli/packages/core/src/sandbox/ 2>/dev/null; echo "---"; find /Users/zhourusheng/Code/person/github/gemini-cli/packages/core/src/sandbox -type f | head -50',
  'ls /Users/zhourusheng/Code/person/github/gemini-cli/packages/core/src/policy/; echo "---"; ls /Users/zhourusheng/Code/person/github/gemini-cli/docs/ | head -60',
];

describe("A2 — 本会话 21 条真实只读命令不再命中 obfuscated-flags", () => {
  for (const [i, cmd] of REAL_READONLY_COMMANDS.entries()) {
    test(`#${i + 1} ${cmd.slice(0, 70)}`, () => {
      // 只断言这一条：这些命令可能命中别的校验器（那属于另一件事），
      // 本条要锁的是「不再被当成 flag 混淆」。
      expect(checkInjectionPatterns(cmd)?.id).not.toBe("obfuscated-flags");
    });
  }
});

describe("A2 — 真绕过形态必须仍然命中（放宽不得开洞）", () => {
  // 这四条都来自既有测试 / 规则注释里点名过的攻击形态，一条都不能漏
  const BYPASS_SAMPLES = [
    `find . "-exec" rm {} \\;`,
    // 引号内只有 `-`、flag 名在引号外：bash 的 word 拼接拼出 `-exec`
    `find . "-"exec rm {} \\;`,
    `cmd '-f'`,
    `ls && find . "-delete"`,
    // 复合命令里的后半段同样要查（拆分不能把它跳过）
    `find . "-exec" rm {} \\; && echo hi`,
    // 管道后半段同样要查
    `echo hi | find . "-exec" rm {} \\;`,
  ];

  for (const cmd of BYPASS_SAMPLES) {
    test(`${cmd} → 命中`, () => {
      expect(checkInjectionPatterns(cmd)?.id).toBe("obfuscated-flags");
    });
  }

  test("ANSI-C / locale / 空引号三类原语不受本次改动影响", () => {
    expect(checkInjectionPatterns(`find . $'\\x2dexec' rm {}`)?.id).toBe("obfuscated-flags");
    expect(checkInjectionPatterns(`find . $"-exec" rm {}`)?.id).toBe("obfuscated-flags");
    expect(checkInjectionPatterns(`find . ''-exec rm {} \\;`)?.id).toBe("obfuscated-flags");
    expect(checkInjectionPatterns(`find . """-f" x`)?.id).toBe("obfuscated-flags");
  });
});

describe("A2 — echo / printf 豁免按子命令生效", () => {
  // 修前豁免条件是「整条命令是 echo 且不含 |&;」，于是这些组合一条都拿不到豁免。
  // 它们本身都是只读探测，把 `---` 当 flag 混淆拒掉纯属噪声。
  const NOISE_COMMANDS = [
    `echo "---"; ls`,
    `ls src && echo "---" && ls test`,
    `ls src 2>&1 | head -50; echo "---"; ls test`,
    `printf -- '--- 390-430 ---\\n'`,
    `sed -n '1,40p' a.rs | cat -n; printf -- '--- 390-430 ---\\n'; sed -n '390,430p' a.rs`,
    `echo '--- Shell.ts 250-275 ---'`,
  ];

  for (const cmd of NOISE_COMMANDS) {
    test(`${cmd} → 放行`, () => {
      expect(checkInjectionPatterns(cmd)?.id).not.toBe("obfuscated-flags");
    });
  }

  test("echo 段之后的真实绕过仍会被后续子命令抓到", () => {
    // 豁免只覆盖 echo / printf 自己那一段，不能顺延给整条命令
    expect(checkInjectionPatterns(`echo "---" && find . "-exec" rm {} \\;`)?.id).toBe(
      "obfuscated-flags",
    );
    expect(checkInjectionPatterns(`printf -- '---\\n'; find . "-exec" rm {} \\;`)?.id).toBe(
      "obfuscated-flags",
    );
  });
});

describe("A2 — flag 形态判据边界（`/^-{1,2}[A-Za-z0-9]/`）", () => {
  test("不是 flag 的占位符一律放行", () => {
    for (const cmd of [
      `echo "---"`,
      `echo "-"`,
      `cmd "--"`,
      `cmd "-- 标题 --"`,
      `cmd "-- separator --"`,
      `cmd "- "`,
      `cmd "--- end ---"`,
    ]) {
      expect(checkInjectionPatterns(cmd)?.id).not.toBe("obfuscated-flags");
    }
  });

  test("短 flag / 长 flag / 带值 flag 仍命中", () => {
    for (const cmd of [`cmd "-f"`, `cmd "--force"`, `cmd "--output=/tmp/x"`, `cmd "-exec"`]) {
      expect(checkInjectionPatterns(cmd)?.id).toBe("obfuscated-flags");
    }
  });
});

describe("A2 — 第 1 条修法独立验收：非 echo 子命令里的占位符", () => {
  // 这组用例只能靠「引号内容能否构成 flag」这一条放行——它们不在 echo/printf 段里，
  // 子命令豁免帮不上忙。变异自证（把 FLAG_LIKE_RE 放宽回 `/^-/`）必须让这组变红，
  // 否则第 1 条修法就是「没有独立验收」的死代码。
  //
  // 场景来源：文档点名的 `sed -n '1,5p' f; "---"` —— 用非 echo 的分隔写法。
  test("非 echo 子命令里的分隔符占位符全部放行", () => {
    for (const cmd of [
      `sed -n '1,5p' f; "---"`,
      `sed -n '1,5p' f; printf "---"`, // printf 也在豁免名单，这条是双保险
      `cmd "---"`,
      `cmd "--"`,
      `cmd "- "`,
      `cmd "-- separator --"`,
      // 引号内是 `---`、引号外还有内容：拼出来是 `---x`，第三位仍是 `-`，不是 flag
      `cmd "---"x`,
    ]) {
      expect(checkInjectionPatterns(cmd)?.id).not.toBe("obfuscated-flags");
    }
  });

  test("同一位置换成真 flag 立刻命中（证明上面放行不是因为整段被跳过）", () => {
    expect(checkInjectionPatterns(`sed -n '1,5p' f; cmd "-f"`)?.id).toBe("obfuscated-flags");
    expect(checkInjectionPatterns(`sed -n '1,5p' f; cmd "--force"`)?.id).toBe("obfuscated-flags");
  });
});

describe("A2 — 第 2 条修法独立验收：echo/printf 段里的真 flag 形态", () => {
  // 这组是第 2 条修法（按子命令豁免）的**唯一**独立验收：
  // 引号内是 `-exec` / `-f` / `--force` —— 形态上是合法 flag，第 1 条帮不上忙，
  // 只能靠「这段属于 echo/printf，参数不参与 flag 解析」放行。
  // 变异自证（把 ECHO_LIKE_COMMANDS 清空）必须让这组变红，否则第 2 条修法没有验收。
  test("复合命令里的 echo / printf 段豁免（修前因含 |&; 拿不到豁免）", () => {
    for (const cmd of [
      `ls && echo "-exec"`,
      `ls src && echo "-f" && ls test`,
      `ls; printf -- '--force\\n'`,
      `ls -la | head; echo "--output=/tmp/x"`,
      `sed -n '1,5p' f; echo "-exec rm {} \\;"`,
    ]) {
      expect(checkInjectionPatterns(cmd)?.id).not.toBe("obfuscated-flags");
    }
  });

  test("豁免不外溢：同一段换成非 echo 命令立刻命中", () => {
    // 与上组一一对应的反例，证明放行来自「这段是 echo/printf」而非「整条命令被跳过」
    for (const cmd of [
      `ls && cmd "-exec"`,
      `ls src && head "-f" && ls test`,
      `ls; find . '--force\\n'`,
      `ls -la | head; awk "--output=/tmp/x"`,
    ]) {
      expect(checkInjectionPatterns(cmd)?.id).toBe("obfuscated-flags");
    }
  });
});
