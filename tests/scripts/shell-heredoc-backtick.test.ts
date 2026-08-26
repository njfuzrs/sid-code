/**
 * 门禁：**未加引号**的 heredoc 体内不许出现未转义的反引号。
 *
 * ## 现场（2026-08-26，smoke-9）
 *
 * `evals/external-benchmarks/swe-bench/exec-swebench.sh` 的 `build_agent_script`
 * 用 `cat <<SCRIPT`（未加引号）生成容器内脚本，于是**整个脚本体都在宿主 bash 里
 * 做一次展开** —— 包括那段 Python 配置里的中文注释。注释里写了
 * `` `yield done; return` `` 这类反引号，结果每题固定刷 5 行：
 *
 *     exec-swebench.sh: 行 955: yield: 未找到命令
 *     exec-swebench.sh: 行 955: quota.ts: 未找到命令
 *     exec-swebench.sh: 行 955: ≥0: 未找到命令
 *
 * ## 为什么值得一条独立门禁，而不是"把那几处反引号改掉"
 *
 * 那修的是症状。写注释的人不会先去检查自己在不在一个未加引号的 heredoc 里 ——
 * 而 `exec-swebench.sh` 的注释密度极高（900+ 行里绝大部分是注释），几乎必然复发。
 * 这与 `shell-fullwidth-var.test.ts` 那条同型：**bash 把注释当代码**，
 * 靠"在原地写一条注释提醒"拦不住下一个人。
 *
 * ## 两种失败形态，第二种才是真危险的那个
 *
 *     cat <<SCRIPT                       # 未加引号
 *     # 注释里带反引号：`echo INJECTED`
 *     SCRIPT
 *     → "# 注释里带反引号：INJECTED"      ← 命令真的被执行
 *
 *     # 注释：判 `costLimit <= 0` 为错
 *     → "# 注释：判  为错"                ← 整段被静默吞掉
 *
 * 第一种至少会在日志里刷错误行（smoke-9 就是这么被发现的）。第二种**零声响**：
 * 吞掉的若不是注释而是一行配置，那就是一个未记录的必控变量，
 * 而"分数为什么变了"永远查不出来。
 *
 * ## 判据：只看未加引号的 heredoc
 *
 * `<<'EOF'` / `<<"EOF"` 加了引号 → 体内一律字面量，反引号无害，**不该拦**
 * （本仓大量脚本这么用，拦了就是全红）。
 * 转义过的 `` \` `` 也不拦：那是作者显式表达"要字面量"的正确写法。
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const REPO_ROOT = join(import.meta.dir, "../..");

/**
 * heredoc 起始行：`<<EOF` / `<<-EOF` / `<<'EOF'` / `<<"EOF"`。
 *
 * 捕获组 1 = 引号（有则安全），组 2 = 定界符。
 *
 * ⚠️ `(?<![<])<<(?!<)` 那两个断言是必需的，不是保险起见 —— 开发这条门禁时它自己先误报了：
 * `scripts/install-template.sh` 里有 `# <<< sid-code <<<` 这样的**标记注释**，
 * 裸 `<<-?` 会把 `<<< sid` 当成"定界符 sid 的 heredoc 起始"，于是从那行起
 * 后面整个文件都被当作 heredoc 体，刷出 3 条纯误报。
 * （`<<<` 在 bash 里是 here-string，与 heredoc 无关，本来就不该匹配。）
 *
 * 同理跳过注释行：注释里写 `<<EOF` 当例子（本文件顶部那段就是）不该开一个 heredoc。
 *
 * 刻意不处理同一行出现两个 heredoc 的情形（`cmd <<A <<B`）—— 本仓无此写法，
 * 支持它需要一个真正的 shell 解析器，而那会让门禁自身成为一个要维护的解析器。
 */
const HEREDOC_START = /(?<![<])<<(?!<)-?\s*(['"]?)([A-Za-z_][A-Za-z0-9_]*)\1/;

/** 未转义的反引号：前面不是反斜杠。 */
const UNESCAPED_BACKTICK = /(^|[^\\])`/;

export interface Violation {
  file: string;
  line: number;
  delimiter: string;
  text: string;
}

/**
 * 扫一份 shell 脚本，返回所有「未加引号 heredoc 体内的未转义反引号」。
 *
 * 导出是为了让下面的变异自证能直接喂字符串进来 —— 只测"全仓扫描为空"的话，
 * 一个恒返回空数组的实现也能全绿（这正是 metric-exists-but-value-is-junk 那类假绿）。
 */
export function findHeredocBacktickViolations(content: string, file = "<inline>"): Violation[] {
  const lines = content.split("\n");
  const violations: Violation[] = [];
  /** 当前所处的未加引号 heredoc 的定界符；null = 不在 heredoc 体内（或在加引号的那种里） */
  let openDelim: string | null = null;
  /** 加引号的 heredoc 也要跟踪 —— 否则它体内若含 `<<XXX` 字样会被误判为新 heredoc 起始 */
  let openQuotedDelim: string | null = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();

    // 先判结束：定界符必须独占一行（`<<-` 允许前导 tab，故用 trim 比对）
    if (openDelim !== null && trimmed === openDelim) {
      openDelim = null;
      continue;
    }
    if (openQuotedDelim !== null && trimmed === openQuotedDelim) {
      openQuotedDelim = null;
      continue;
    }

    // 在未加引号的 heredoc 体内：查反引号
    if (openDelim !== null) {
      if (UNESCAPED_BACKTICK.test(line)) {
        violations.push({ file, line: i + 1, delimiter: openDelim, text: line.trim() });
      }
      continue;
    }
    // 在加引号的 heredoc 体内：什么都不查，也不认新的 heredoc 起始
    if (openQuotedDelim !== null) continue;

    // 注释行不开 heredoc（注释里写 `<<EOF` 当例子很常见，本文件顶部那段就是）
    if (trimmed.startsWith("#")) continue;

    const m = HEREDOC_START.exec(line);
    if (m) {
      if (m[1]) openQuotedDelim = m[2];
      else openDelim = m[2];
    }
  }
  return violations;
}

function shellFiles(): string[] {
  const r = spawnSync("git", ["ls-files", "*.sh"], { cwd: REPO_ROOT, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`git ls-files 失败: ${r.stderr}`);
  return r.stdout.split("\n").filter(Boolean);
}

describe("shell 门禁：未加引号 heredoc 体内不许有未转义反引号", () => {
  test("全仓 *.sh 无违规", () => {
    const violations: string[] = [];
    for (const f of shellFiles()) {
      const found = findHeredocBacktickViolations(readFileSync(join(REPO_ROOT, f), "utf8"), f);
      for (const v of found) violations.push(`${v.file}:${v.line}（<<${v.delimiter}）: ${v.text}`);
    }
    // 写成「列表为空」而不是 length===0：失败时直接看得到是哪几行
    expect(violations).toEqual([]);
  });

  test("扫描确实读到了文件（防 shellFiles() 空数组导致的假绿）", () => {
    const files = shellFiles();
    expect(files.length).toBeGreaterThan(3);
    expect(files.some((f) => f.endsWith(".sh"))).toBe(true);
  });

  describe("变异自证：拦得住、也放得过", () => {
    test("未加引号 heredoc + 注释里的反引号 → 命中（smoke-9 的真实形态）", () => {
      const v = findHeredocBacktickViolations(
        ["cat <<SCRIPT", "# 模板值 100 会让整轮在 `yield done; return` 处结束", "SCRIPT"].join(
          "\n",
        ),
      );
      expect(v.length).toBe(1);
      expect(v[0].line).toBe(2);
      expect(v[0].delimiter).toBe("SCRIPT");
    });

    test("加了引号（<<'EOF'）→ 不命中，这就是正确写法", () => {
      const v = findHeredocBacktickViolations(
        ["cat <<'SCRIPT'", "# 判 `costLimit <= 0` 为不限", "SCRIPT"].join("\n"),
      );
      expect(v).toEqual([]);
    });

    test('双引号定界符（<<"EOF"）同样安全', () => {
      const v = findHeredocBacktickViolations(
        ['cat <<"SCRIPT"', "# 带 `反引号` 的注释", "SCRIPT"].join("\n"),
      );
      expect(v).toEqual([]);
    });

    test("转义过的 \\` → 不命中（作者显式表达要字面量）", () => {
      const v = findHeredocBacktickViolations(
        ["cat <<SCRIPT", "echo \\`literal\\`", "SCRIPT"].join("\n"),
      );
      expect(v).toEqual([]);
    });

    test("heredoc 之外的反引号 → 不命中（那是正常的命令替换）", () => {
      const v = findHeredocBacktickViolations(["out=`date`", 'echo "$out"'].join("\n"));
      expect(v).toEqual([]);
    });

    test("<<- 变体（允许前导 tab 缩进定界符）也被正确识别", () => {
      const v = findHeredocBacktickViolations(
        ["cat <<-SCRIPT", "# 带 `反引号`", "\tSCRIPT"].join("\n"),
      );
      expect(v.length).toBe(1);
    });

    test("`<<<` here-string 与 `# <<< marker <<<` 标记注释 → 不误判为 heredoc 起始", () => {
      // 这条是**开发本门禁时真的踩到的误报**，不是假想：
      // scripts/install-template.sh 有 `# <<< sid-code <<<` 标记注释，
      // 裸 `<<-?` 会把 `<<< sid` 当成 heredoc 起始 → 此后整个文件被当 heredoc 体 → 3 条误报。
      const v = findHeredocBacktickViolations(
        [
          "# >>> sid-code >>>",
          "# 此块由安装脚本管理，`sid-code update` 会重跑安装脚本。",
          "# <<< sid-code <<<",
          'grep -q foo <<< "$var"',
          'echo "带 `date` 的普通命令替换"',
        ].join("\n"),
      );
      expect(v).toEqual([]);
    });

    test("注释行里的 <<EOF 示例 → 不开 heredoc", () => {
      const v = findHeredocBacktickViolations(
        ["# 反面教材： cat <<EOF", 'echo "这行有 `date`，但不在任何 heredoc 里"'].join("\n"),
      );
      expect(v).toEqual([]);
    });

    test("嵌套：加引号的外层 heredoc 里含 <<INNER 字样时不误判", () => {
      // 加引号的 heredoc 体内一切都是字面量，包括看起来像 heredoc 起始的行。
      // 不跟踪这一点的实现会在这里"进入"一个不存在的未加引号 heredoc，随后满屏误报。
      const v = findHeredocBacktickViolations(
        [
          "cat <<'OUTER'",
          "cat <<INNER",
          "# 这一行带 `反引号`，但整段都在加引号的 OUTER 里，是字面量",
          "INNER",
          "OUTER",
        ].join("\n"),
      );
      expect(v).toEqual([]);
    });

    test("bash 实测：未加引号时反引号真的被求值，加引号后原样保留", () => {
      const run = (s: string) =>
        spawnSync("bash", ["-c", s], { encoding: "utf8", timeout: 10_000 });
      if (run("echo ok").error) return; // 没有 bash，跳过

      // 形态一：命令真的被执行（这一条证明门禁拦的不是"理论问题"）
      const bare = run("cat <<SCRIPT\n# mark: `echo INJECTED`\nSCRIPT");
      expect(bare.stdout).toContain("INJECTED");
      expect(bare.stdout).not.toContain("echo INJECTED");

      // 形态二：整段被静默吞掉 —— 更危险，因为没有任何报错
      const swallowed = run("cat <<SCRIPT\n# 判 `costLimit -le 0` 为错\nSCRIPT");
      expect(swallowed.stdout).not.toContain("costLimit");

      // 加引号后原样保留
      const quoted = run("cat <<'SCRIPT'\n# mark: `echo INJECTED`\nSCRIPT");
      expect(quoted.stdout).toContain("`echo INJECTED`");
    });
  });
});
