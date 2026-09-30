/**
 * D14 / D15 / D16：自定义命令模板流水线（custom.ts processTemplate）。
 *
 * D14：修复前「参数替换 → 文件注入 → Shell 注入」，用户参数里的 `!{}` `@{}` 会被执行。
 * D15：修复前文件注入无确认、无路径边界、无大小上限，与相邻的 shell 注入不对称。
 * D16：修复前 `$(\d+)` 贪婪、越界 / `$0` 静默变空串、切分不认引号。
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync, mkdirSync, realpathSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { CustomCommand } from "@sid-code/cli/command/custom.ts";

/** 与 custom.ts 的 FILE_INJECTION_MAX_BYTES 同值（该常量不导出，避免只为测试留死导出） */
const FILE_INJECTION_MAX_BYTES = 10 * 1024 * 1024;

/** 只做参数替换：无注入的模板 + 空 ctx（不需要任何确认通道） */
async function substituteArgs(tpl: string, args: string): Promise<string> {
  const r = await new CustomCommand("t", "d", tpl).execute(args, {} as AppContext);
  return (r as { prompt: string }).prompt;
}
import type { AppContext } from "@sid-code/cli/command/types.ts";

let root: string;
let proj: string;
let outside: string;
let prevCwd: string;

beforeAll(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "sid-tpl-")));
  proj = join(root, "proj");
  outside = join(root, "outside");
  mkdirSync(proj);
  mkdirSync(outside);
  writeFileSync(join(proj, "notes.md"), "PROJECT_NOTE");
  writeFileSync(join(proj, ".env"), "SECRET=1");
  writeFileSync(join(outside, "x.txt"), "OUTSIDE_CONTENT");
  prevCwd = process.cwd();
  process.chdir(proj);
});

afterAll(() => {
  process.chdir(prevCwd);
  rmSync(root, { recursive: true, force: true });
});

/** 记录两个确认通道被问了什么；默认都批准 */
function ctx(opts: { file?: boolean; shell?: boolean } = {}) {
  const asked = { file: [] as string[], shell: [] as string[][] };
  const c = {
    requestUserConfirmation: async (d: string) => {
      asked.file.push(d);
      return opts.file ?? true;
    },
    confirmShellCommands: async (cmds: string[]) => {
      asked.shell.push(cmds);
      return opts.shell ?? true;
    },
  } as unknown as AppContext;
  return { c, asked };
}

async function run(tpl: string, args: string, c: AppContext) {
  return (await new CustomCommand("t", "d", tpl).execute(args, c)) as {
    kind: string;
    prompt?: string;
    message?: string;
  };
}

describe("D14 用户参数不参与注入扫描", () => {
  test("参数里的 !{...} 不执行，连确认框都不弹，按字面量进 prompt", async () => {
    const { c, asked } = ctx();
    const r = await run("请分析：$ARGUMENTS", "!{echo PWNED_MARKER}", c);
    expect(r.kind).toBe("submit_prompt");
    expect(r.prompt).toBe("请分析：!{echo PWNED_MARKER}");
    expect(asked.shell).toEqual([]);
  });

  test("参数里的 @{/etc/passwd} 不触发任何读取，输出就是那 14 个字符", async () => {
    const { c, asked } = ctx();
    const r = await run("看：$1", "@{/etc/passwd}", c);
    expect(r.prompt).toBe("看：@{/etc/passwd}");
    expect(asked.file).toEqual([]);
  });

  test("shell 确认框只展示模板作者写的命令", async () => {
    const { c, asked } = ctx();
    await run("!{echo A} $ARGUMENTS", "!{echo FROM_USER}", c);
    expect(asked.shell).toEqual([["echo A"]]);
  });

  test("注入结果不再被参数替换（命令输出里的 $1 原样保留）", async () => {
    const { c } = ctx();
    const r = await run("!{printf '$1'} / $1", "ARG", c);
    expect(r.prompt).toBe("$1 / ARG");
  });
});

describe("D15 文件注入：边界 / 确认 / 上限", () => {
  test("cwd 内普通文件直接放行，不弹确认", async () => {
    const { c, asked } = ctx();
    const r = await run("@{notes.md}", "", c);
    expect(r.prompt).toContain("PROJECT_NOTE");
    expect(asked.file).toEqual([]);
  });

  test("../ 跳出 cwd 被判为 cwd 外，确认框里写明原因", async () => {
    const { c, asked } = ctx({ file: false });
    await run("@{../outside/x.txt}", "", c);
    expect(asked.file.length).toBe(1);
    expect(asked.file[0]).toContain("项目目录之外");
  });

  test("绝对路径在 cwd 外：需确认，用户批准后才读", async () => {
    const { c, asked } = ctx({ file: true });
    const r = await run(`@{${join(outside, "x.txt")}}`, "", c);
    expect(asked.file.length).toBe(1);
    expect(r.prompt).toContain("OUTSIDE_CONTENT");
  });

  test("用户拒绝 → 不读、返回已取消，内容不进 prompt", async () => {
    const { c } = ctx({ file: false });
    const r = await run("@{../outside/x.txt}", "", c);
    expect(r.kind).toBe("message");
    expect(r.message).toMatch(/拒绝注入文件/);
    expect(JSON.stringify(r)).not.toContain("OUTSIDE_CONTENT");
  });

  test("cwd 内但命中敏感模式（.env）也要确认", async () => {
    const { c, asked } = ctx({ file: false });
    await run("@{.env}", "", c);
    expect(asked.file.length).toBe(1);
    expect(asked.file[0]).toContain("敏感文件");
  });

  test("无确认通道 → fail-closed 拒绝（与 shell 注入同取向）", async () => {
    const r = await run("@{.env}", "", {} as AppContext);
    expect(r.kind).toBe("message");
    expect(JSON.stringify(r)).not.toContain("SECRET=1");
  });

  test("确认回调抛异常 → 保守拒绝", async () => {
    const c = {
      requestUserConfirmation: async () => {
        throw new Error("弹窗失败");
      },
    } as unknown as AppContext;
    const r = await run("@{.env}", "", c);
    expect(r.kind).toBe("message");
  });

  test("超过上限的文件被截断并提示，而非整文件塞进上下文", async () => {
    const big = join(proj, "big.log");
    writeFileSync(big, Buffer.alloc(FILE_INJECTION_MAX_BYTES + 1024, "a"));
    const { c } = ctx();
    const r = await run("@{big.log}", "", c);
    expect(r.prompt).toContain("已截断");
    expect(r.prompt!.length).toBeLessThan(FILE_INJECTION_MAX_BYTES + 500);
    rmSync(big);
  });
});

describe("D16 参数占位符边界", () => {
  test("$10 → 第 1 个参数 + 字符 0", async () => {
    expect(await substituteArgs("第 $10 项", "AAA")).toBe("第 AAA0 项");
  });
  test("$0 保留字面量", async () => {
    expect(await substituteArgs("[$0]", "AAA")).toBe("[$0]");
  });
  test("越界保留字面量，不变空串", async () => {
    expect(await substituteArgs("[$5]", "AAA")).toBe("[$5]");
  });
  test("切分认引号", async () => {
    expect(await substituteArgs("[$1]", '"a b" c')).toBe("[a b]");
    expect(await substituteArgs("[$2]", "'x y' z")).toBe("[z]");
  });
  test("回归：$@ / $* / $ARGUMENTS / {{args}} 仍是原文", async () => {
    const a = '"a b" c';
    expect(await substituteArgs("$@|$*|$ARGUMENTS|{{args}}", a)).toBe(`${a}|${a}|${a}|${a}`);
  });
  test("参数文本里的 $1 不被二次展开", async () => {
    expect(await substituteArgs("$1 $2", "$2 X")).toBe("$2 X");
  });
});
