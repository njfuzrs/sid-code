/**
 * bash 重定向提取 —— 权限确认绕过的回归网
 *
 * ## 这个文件为什么存在
 *
 * 2026-08-22 实测发现：`extractRedirectTargets` 漏掉了大量写入重定向形态
 * （`2>` `1>` `&>` `>|`、无空格前导、尾部还有 token 的），而它是三道安全判定的
 * 共同上游。漏一个目标的后果链是：
 *
 * ```
 * extractRedirectTargets 漏目标
 *   → read-only-validation.ts:308 isReadOnlyCommand 误判"只读"
 *     → bash.ts:499 checkPermissions 返回 { behavior: "allow" }   ← 免确认放行
 * ```
 *
 * 实测样本：`ls 2> ~/.ssh/authorized_keys` 被判 `allow` 直接放行，
 * 而同一个命令写成 `ls > ~/.ssh/authorized_keys` 会落到 passthrough 走后续权限检查。
 * **同一个写盘动作，换个操作符就绕过了确认。**
 *
 * ## 为什么现有 9563 个用例没抓到
 *
 * 按 `bash/parser` 在测试目录里 grep 引用，当时返回空——parser 零直接测试。
 * 消费方的测试喂进去的都是 `>` 这类"正常"命令，**没人想到要喂 `2>`**。
 * 这就是"手写用例只覆盖作者想到的输入"的实例，也是本文件用
 * **metamorphic（构造输入 + 已知 oracle）** 而不是随机 fuzz 的原因：
 * 每条用例都埋一个 sentinel 路径进去，然后断言它必须被提出来——
 * oracle 就是"我埋进去的东西"。
 *
 * 对照实验（2026-08-22 实跑）：20000 轮无 oracle 的随机 fuzz **零发现**
 * （`parseBashCommand` 外层有 try/catch 兜底，"永不抛"是结构上保证的）；
 * 34 条带 oracle 的构造输入抓到 10 条。**oracle 比输入量重要。**
 *
 * ## 三层断言缺一不可
 *
 * 1. **正向**：写入目标必须被提取
 * 2. **端到端**：同一批命令喂 `isReadOnlyCommand` 必须全部 `false`
 *    —— 这层才真正锁住用户风险，比断言 parser 输出更贴近实际后果
 * 3. **反向**：纯读命令必须仍判只读
 *    —— ⚠️ **这层不能省**。只有正向断言的话，把 `isReadOnlyCommand` 改成
 *    `return false` 就能让所有正向断言转绿：**单向断言可以被最笨的实现满足**。
 */

import { describe, expect, test } from "bun:test";
import {
  type BashASTNode,
  extractRedirectTargets,
  getCommandPrefix,
  extractSimpleCommands,
  parseBashCommand,
} from "@sid-code/core/tool/bash/parser.ts";
import { isReadOnlyCommand } from "@sid-code/core/tool/bash/read-only-validation.ts";

/** 埋进命令里的 oracle：断言它必须出现在提取结果中 */
const S = "/tmp/SENTINEL_TARGET";

/**
 * 全部会真实写盘的命令。每条都含 {@link S}。
 * 括号里标的是它当初为什么漏 —— 修复时两层根因（正则白名单 / mode 白名单）各占一半。
 */
const WRITE_COMMANDS: Array<[cmd: string, why: string]> = [
  [`echo hi > ${S}`, "基础覆盖写（原本就能提取，作为对照）"],
  [`echo hi >${S}`, "无空格分隔"],
  [`echo hi >> ${S}`, "追加写（原本就能提取）"],
  [`echo hi 1> ${S}`, "fd1 显式：旧正则不认数字前缀"],
  [`echo hi 2> ${S}`, "stderr：解析出 redirect 节点但被 mode 白名单丢弃"],
  [`echo hi 2>${S}`, "stderr + 无空格"],
  [`echo hi &> ${S}`, "stdout+stderr 合并：旧正则不认 &>"],
  [`echo hi &>> ${S}`, "合并追加"],
  [`echo hi >| ${S}`, "noclobber 覆盖：| 曾被管道拆分先吃掉"],
  [`echo x 3> ${S}`, "任意 fd"],
  [`echo hi > "${S}"`, "双引号目标"],
  [`echo hi > '${S}'`, "单引号目标"],
  [`echo hi && echo x > ${S}`, "&& 序列的后半段"],
  [`echo hi ; echo x > ${S}`, "; 序列"],
  [`echo hi || echo x > ${S}`, "|| 序列"],
  [`cat a | grep b > ${S}`, "管道末段"],
  [`echo hi > ${S} &`, "后台执行：旧正则的 $ 锚定被尾部 & 打断"],
  [`echo x >${S} <in`, "尾部还有 stdin 重定向"],
  [`echo x> ${S}`, "操作符粘在命令名上"],
  [`echo x > /dev/null > ${S}`, "多个重定向，取非丢弃的那个"],
  [`cat f 1>/tmp/other 2>${S}`, "两个目标：旧实现单次匹配只能拿一个"],
  [`echo x > ${S} 2>&1`, "重定向 + fd 复制混用"],
  [`ls 2> ${S}`, "只读命令 + stderr 重定向（最典型的绕过形态）"],
  [`grep foo bar 2>${S}`, "同上"],
  [`command echo x > ${S}`, "command 前缀"],
  [`env FOO=1 echo x > ${S}`, "env 包装"],
  [`nohup echo x > ${S}`, "nohup 包装"],
  [`time echo x > ${S}`, "time 包装"],
  [`printf x >${S};`, "尾随分号"],
];

/** 纯读命令：修复后必须仍判只读，否则就是拿"更安全"伤"更快"的净退步 */
const READ_ONLY_COMMANDS = [
  "ls",
  "ls -la",
  "cat f",
  "cat < f",
  "cat 0< f",
  "grep foo f",
  "grep x <in",
  "git log",
  "git status",
  "git diff",
  "echo hi",
  'echo "a > b"',
  "echo 'x >> y'",
  'grep "2>" f',
  "cat a | grep b",
  "ls 2>&1",
  "ls 2>&1 | head",
  "ls >&2",
  "cat f 2>/dev/null",
  "wc -l f",
  "head -5 f",
  "pwd",
];

describe("① 正向：写入重定向目标必须被提取", () => {
  for (const [cmd, why] of WRITE_COMMANDS) {
    test(`${cmd}  —— ${why}`, () => {
      const targets = extractRedirectTargets(parseBashCommand(cmd));
      expect(targets).toContain(S);
    });
  }
});

describe("② 端到端：写盘命令绝不能被判只读（否则 checkPermissions 免确认放行）", () => {
  for (const [cmd, why] of WRITE_COMMANDS) {
    test(`${cmd}  —— ${why}`, () => {
      // isReadOnlyCommand === true 会让 bash.ts:505 直接 return { behavior: "allow" }
      expect(isReadOnlyCommand(cmd)).toBe(false);
    });
  }
});

describe("③ 反向：纯读命令必须仍判只读（防过度提取导致白弹确认）", () => {
  for (const cmd of READ_ONLY_COMMANDS) {
    test(cmd, () => {
      expect(isReadOnlyCommand(cmd)).toBe(true);
    });
  }
});

describe("引号内的重定向符是字面量，不是重定向", () => {
  test.each([['echo "a > /tmp/quoted"'], ["echo 'b >> /tmp/quoted'"], ['grep "x 2> y" f']])(
    "%s",
    (cmd) => {
      expect(extractRedirectTargets(parseBashCommand(cmd))).toEqual([]);
    },
  );
});

describe("/dev/null 等丢弃目标豁免，但不许前缀命中", () => {
  test("2>/dev/null 不算写盘（否则极常见的纯读命令会开始白弹确认）", () => {
    expect(extractRedirectTargets(parseBashCommand("cat f 2>/dev/null"))).toEqual([]);
  });

  // 这条是 permission/bash-security.ts:119 记下的坑：用 startsWith 判断的话，
  // /dev/nullo 这个**真实文件**会被当成丢弃目标放行。
  test.each([
    ["cat f > /dev/nullo", "/dev/nullo"],
    ["cat f > /dev/null.bak", "/dev/null.bak"],
    ["cat f > /dev/nul", "/dev/nul"],
    ["cat f > ./dev/null", "./dev/null"],
  ])("%s 是真实文件，必须被提取", (cmd, target) => {
    expect(extractRedirectTargets(parseBashCommand(cmd))).toContain(target);
  });

  test("/dev/stdout 不在豁免集，按写处理（保守侧）", () => {
    expect(extractRedirectTargets(parseBashCommand("cat f > /dev/stdout"))).toContain(
      "/dev/stdout",
    );
  });
});

describe("fd 复制（2>&1 类）不是文件目标", () => {
  test.each([["ls 2>&1"], ["ls >&2"], ["ls 1>&2"], ["ls 2>&-"]])("%s", (cmd) => {
    expect(extractRedirectTargets(parseBashCommand(cmd))).toEqual([]);
  });

  test("与真实重定向混用时只提取真实目标", () => {
    expect(extractRedirectTargets(parseBashCommand("ls > /tmp/X 2>&1"))).toEqual(["/tmp/X"]);
  });
});

describe("读类重定向不算写盘目标", () => {
  test.each([["cat < /tmp/in"], ["cat 0< /tmp/in"], ["cat <<< 'here'"], ["cat <<EOF"]])(
    "%s",
    (cmd) => {
      expect(extractRedirectTargets(parseBashCommand(cmd))).toEqual([]);
    },
  );

  test("读写混用只提取写的那个", () => {
    expect(extractRedirectTargets(parseBashCommand("sort < a > /tmp/out"))).toEqual(["/tmp/out"]);
  });
});

describe(">| 不能被管道拆分吃掉（真管道要照常拆）", () => {
  const CASES: Array<[cmd: string, wantType: BashASTNode["type"]]> = [
    ["echo hi >| /tmp/X", "redirect"],
    ["echo hi >|/tmp/X", "redirect"],
    ["cat a | grep b", "pipeline"],
    ["cat a|grep b", "pipeline"],
    ["cat a | grep b | wc -l", "pipeline"],
    ["cat a || echo b", "sequence"],
    ["echo a > /tmp/X | cat", "pipeline"],
  ];
  test.each(CASES)("%s -> %s", (cmd, wantType) => {
    expect(parseBashCommand(cmd).type).toBe(wantType);
  });
});

describe("fd 号粘在命令名上时不算 fd 前缀", () => {
  // `foo2> f` 的 2 属于命令名 foo2，整体仍是 stdout 重定向；`cmd 2> f` 的 2 才是 fd 号。
  test.each([
    ["foo2> /tmp/X", "foo2", ">"],
    ["sha256sum2> /tmp/X", "sha256sum2", ">"],
    ["cmd 2> /tmp/X", "cmd", "2>"],
  ])("%s", (cmd, wantCommand, wantRawMode) => {
    const ast = parseBashCommand(cmd);
    expect(ast.type).toBe("redirect");
    if (ast.type !== "redirect") return;
    expect(ast.rawMode).toBe(wantRawMode);
    expect(ast.target.type).toBe("simple");
    if (ast.target.type === "simple") expect(ast.target.command).toBe(wantCommand);
    expect(extractRedirectTargets(ast)).toEqual(["/tmp/X"]);
  });
});

describe("命令体识别不受重定向剥离影响（getCommandPrefix 回归）", () => {
  test.each([
    ["ls 2> /tmp/x", "ls"],
    ["git log > /tmp/x", "git log"],
    ["cat f 1>/tmp/o 2>/tmp/e", "cat f"],
    ["echo x > /tmp/x &", "echo x"],
    ["timeout 10 npm test > /tmp/x", "npm test"],
  ])("%s -> %s", (cmd, want) => {
    expect(getCommandPrefix(cmd)).toBe(want);
  });
});

describe("畸形与截断输入不造假目标、不抛异常", () => {
  test.each([["echo x >"], ["echo x > "], [">"], [">>"], ["echo x >>"], ["2>"], ["echo x 2>"]])(
    "%s 截断后不产生空目标",
    (cmd) => {
      const targets = extractRedirectTargets(parseBashCommand(cmd));
      expect(targets).toEqual([]);
    },
  );

  test("进程替换的目标不是文件路径，不提取", () => {
    for (const cmd of ["diff <(ls a) <(ls b)", "tee >(cat) < f", "echo x > >(cat)"]) {
      expect(extractRedirectTargets(parseBashCommand(cmd))).toEqual([]);
    }
  });

  test("大量重定向不丢不漏（2000 个）", () => {
    const n = 2000;
    const cmd = Array.from({ length: n }, (_, k) => `echo ${k} > /tmp/f${k}`).join(" && ");
    expect(extractRedirectTargets(parseBashCommand(cmd))).toHaveLength(n);
  });

  test("深层嵌套不栈溢出", () => {
    const deep = "$(".repeat(50_000) + "echo x" + ")".repeat(50_000);
    expect(() => parseBashCommand(deep)).not.toThrow();
  });

  test("随机畸形输入下四个导出函数都不抛，且目标恒为数组", () => {
    // 确定性 PRNG：失败可复现（不用 Math.random）
    let seed = 7;
    const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
    const ATOMS = [
      "echo",
      ">",
      ">>",
      ">|",
      "&>",
      "&>>",
      "1>",
      "2>",
      "3<",
      "<",
      "<<<",
      "<<",
      "|",
      "&&",
      ";",
      "&",
      "'",
      '"',
      "\\",
      " ",
      "(",
      ")",
      "$(",
      "/tmp/x",
      "a",
      "2>&1",
      ">&2",
      "中文",
    ];
    for (let i = 0; i < 5000; i++) {
      const cmd = Array.from(
        { length: 1 + Math.floor(rnd() * 14) },
        () => ATOMS[Math.floor(rnd() * ATOMS.length)],
      ).join("");
      const ast = parseBashCommand(cmd);
      expect(Array.isArray(extractRedirectTargets(ast))).toBe(true);
      expect(Array.isArray(extractSimpleCommands(ast))).toBe(true);
      expect(typeof getCommandPrefix(cmd)).toBe("string");
      expect(typeof isReadOnlyCommand(cmd)).toBe("boolean");
    }
  });
});
