/**
 * E1：退出码语义表——`gh pr checks` 退出码 8 = 有检查 pending，不是命令失败。
 *
 * 缺口 G8（事故 `20261108-112620-7dd98bf5`）：该会话 86 次 `gh pr checks` 里有 44 次退出码 8，
 * 全被 `bash.ts` 的一刀切 `exitCode !== 0 → isError` 标成「命令执行失败（退出码 8）」。
 * 于是「CI 还在跑」这个**等待中的正常状态**被读成「查询坏了」，模型据此反复重查
 * （20 分钟窗口内 86 次）、甚至去修一个不存在的缺陷。
 *
 * 判据沿用 `command-semantics.ts` 已有的「最后一段简单命令决定退出码」口径，
 * 与 grep 无匹配 / diff 有差异同一把尺子——**没有第二张表**。
 */

import { describe, test, expect } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";
import { spawnSync } from "child_process";
import { interpretExitCode } from "@sid-code/core/tool/bash/command-semantics.ts";

describe("E1 退出码语义：gh pr checks 退出码 8 = pending", () => {
  test("T-E1-1 退出码 8 → is_error=false，且首行写明 pending", () => {
    const r = interpretExitCode("gh pr checks 662", 8);
    expect(r.isError).toBe(false);
    expect(r.header).toContain("pending");
    // 首行要能纠正模型的判断：「不是命令错误」这半句是重点
    expect(r.header).toContain("不是命令错误");
    // 不能走 message（那是「追加到末尾」的附注，模型先读正文时看不到）
    expect(r.message).toBeUndefined();
  });

  test("T-E1-2 退出码 0 不经过表；`| head` 结尾不匹配", () => {
    // 0 → 默认语义就是成功，不该带任何语义提示
    const zero = interpretExitCode("gh pr checks 662", 0);
    expect(zero.isError).toBe(false);
    expect(zero.header).toBeUndefined();

    // `gh pr checks 1 | head` 的退出码属于 head，不是 gh 的 8 —— 不能套 gh 语义
    const piped = interpretExitCode("gh pr checks 662 | head -10", 8);
    expect(piped.isError).toBe(true); // head 拿 8 就是真异常
    expect(piped.header).toBeUndefined();
  });

  test("T-E1-3 `cd x && gh pr checks 1` 匹配（最后一段是 gh）", () => {
    const r = interpretExitCode("cd /repo && gh pr checks 662", 8);
    expect(r.isError).toBe(false);
    expect(r.header).toContain("pending");

    // 真实形态：带 2>&1 和多个前置段
    const real = interpretExitCode(
      "cd /repo/wt && gh pr view 662 --json state,mergedAt --jq '.state' && echo '=== checks ===' && gh pr checks 662 2>&1",
      8,
    );
    expect(real.isError).toBe(false);
    expect(real.header).toContain("pending");
  });

  test("退出码 1（有检查失败）仍是错误，不被 gh 语义吞掉", () => {
    const r = interpretExitCode("gh pr checks 662", 1);
    expect(r.isError).toBe(true);
    expect(r.header).toBeUndefined();
  });

  test("其它 gh 子命令不受影响（只有 pr checks 有 8 这个语义）", () => {
    // gh pr view 退出码 8 不是 pending（实测 44 条退出码 8 全部来自 gh pr checks）
    expect(interpretExitCode("gh pr view 662 --json state", 8).isError).toBe(true);
    expect(interpretExitCode("gh pr view 662 --json state", 8).header).toBeUndefined();
    // gh run list 同理
    expect(interpretExitCode("gh run list --limit 3", 8).isError).toBe(true);
  });

  test("既有语义没被改动（grep / diff / which）", () => {
    expect(interpretExitCode("grep foo bar.txt", 1)).toEqual({
      isError: false,
      message: "无匹配",
      header: undefined,
    });
    expect(interpretExitCode("diff a.txt b.txt", 1).isError).toBe(false);
    expect(interpretExitCode("which exiftool", 1).isError).toBe(false);
    expect(interpretExitCode("ls /nonexistent", 1).isError).toBe(true);
  });
});

describe("E1 语义表依据（gh 版本变化时红）", () => {
  /**
   * T-E1-4：把 `gh pr checks --help` 里退出码说明作为快照。
   *
   * gh 改语义（比如把 pending 换成别的退出码）时这条会红，提示回头复核
   * `command-semantics.ts` 的 GH_SEMANTIC——而不是静默地把 pending 报成失败。
   *
   * gh 未安装时 skip：本仓贡献者不需要装 gh（CONTRIBUTING「贡献者不需要任何 LLM API key」
   * 同一条精神：本地门禁不该引入新的外部依赖）。CI 的 ubuntu/macos runner 预装 gh，会真跑。
   */
  const gh = spawnSync("gh", ["--version"], { encoding: "utf8" });
  const ghAvailable = gh.status === 0;

  test.skipIf(!ghAvailable)("T-E1-4 `gh pr checks --help` 仍写着 `8: Checks pending`", () => {
    const help = spawnSync("gh", ["pr", "checks", "--help"], { encoding: "utf8" });
    expect(help.status).toBe(0);
    const text = `${help.stdout}\n${help.stderr}`;
    // 说明可能是 "8: Checks pending" 也可能是 "8:\tChecks pending"，只锁语义
    expect(text).toMatch(/8:\s*Checks pending/i);
    // 同时锁住「1 = 有检查失败」没有被 gh 改成别的含义（我们靠默认语义处理它）
    expect(text).toMatch(/Additional exit codes/i);
  });
});

describe("E1 真实轨迹回放（T-E1-5）", () => {
  /**
   * `20261108-112620-7dd98bf5` 窗口内所有**带退出码**的失败命令（45 条：44 条退出码 8 + 1 条 1）。
   *
   * 断言口径与方案不同，这里说明原因：方案 §9.3 写的是「45 条退出码 8 的结果全部变成
   * is_error=false」，实测该会话退出码 8 恰好 **44** 条（另 1 条退出码 1 是 jq 表达式语法错，
   * 03:51:04）。夹具按实测生成，断言按实测写——照抄方案里的 45 会让这条测试变成
   * 「要么永远红、要么被改成不看内容」的假门禁。
   */
  const fixturePath = join(import.meta.dir, "fixtures", "exit-code-replay-7dd98bf5.json");
  const rows = JSON.parse(readFileSync(fixturePath, "utf8")) as Array<{
    command: string;
    exitCode: number;
    ts: string;
  }>;

  test("44 条退出码 8 全部变成 is_error=false；jq 语法错仍为 true", () => {
    const exit8 = rows.filter((r) => r.exitCode === 8);
    const others = rows.filter((r) => r.exitCode !== 8);

    expect(exit8.length).toBe(44); // 夹具本身的自证：数字变了说明夹具或提取口径漂了
    for (const row of exit8) {
      const r = interpretExitCode(row.command, row.exitCode);
      expect({ cmd: row.command, isError: r.isError }).toEqual({
        cmd: row.command,
        isError: false,
      });
      expect(r.header).toContain("pending");
    }

    // 03:51:04 那条：`gh pr view 662 --json ... --jq '{...enabledAt??"未挂"}'`
    // jq 语法错 → 退出码 1，必须仍然报错（语义表不能把真失败吞掉）
    expect(others.length).toBe(1);
    const bad = others[0]!;
    expect(bad.ts).toBe("2026-11-08T03:51:04.041Z");
    expect(bad.command).toContain("--jq");
    expect(interpretExitCode(bad.command, bad.exitCode).isError).toBe(true);
  });
});
