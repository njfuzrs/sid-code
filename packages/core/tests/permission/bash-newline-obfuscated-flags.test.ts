/**
 * D3 回归：flag 混淆检测必须扫到多行命令的第二段及以后
 *
 * ## 这个文件为什么存在
 *
 * `splitShellSubcommands` 原来不把换行当命令分隔符，于是 `echo hi`⏎`grep "-"exec .`
 * 被当成**一条**子命令。两层后果叠加：
 *
 * 1. `validateObfuscatedFlags` 的 `echo` 豁免（`baseCommand === "echo"` 且无 shell 操作符）
 *    按「整段」生效，第二条命令的混淆 flag 一起被豁免；
 * 2. 即使不豁免，`extractBaseCommand` 只看段首词，第二段永远拿不到自己的命令名。
 *
 * 所以本文件锁两件事：`splitShellSubcommands` 认换行；`validateObfuscatedFlags`
 * 把换行也算作 shell 操作符（否则 echo 豁免仍然会外溢到第二段）。
 *
 * ## 之前为什么没拦住
 *
 * 现有 `bash-security-obfuscated-flags.test.ts` 的用例全是**单行**复合命令
 * （`&&` / `;` / `|`），换行形态一条都没有——和 `isReadOnlyCommand` 那边的盲区同源。
 *
 * ## 反向保护不能省
 *
 * 只断言「多行能命中」的话，把 `validateObfuscatedFlags` 改成恒返回 finding 也能全绿，
 * 而那会让所有带引号参数的多行命令白弹。所以每条命中用例都配一条同形态的不命中对照。
 */

import { describe, expect, test } from "bun:test";
import {
  checkInjectionPatterns,
  validateObfuscatedFlags,
} from "@sid-code/core/permission/bash-security.ts";
import { splitShellSubcommands } from "@sid-code/core/tool/bash/parser.ts";

describe("D3 — splitShellSubcommands 认换行", () => {
  test("两段多行命令拆成两条子命令", () => {
    expect(splitShellSubcommands('echo hi\ngrep "-"exec .')).toEqual(["echo hi", 'grep "-"exec .']);
  });

  test("三段多行命令（含 CRLF）", () => {
    expect(splitShellSubcommands("ls\r\ncat f\r\ngrep x y")).toEqual(["ls", "cat f", "grep x y"]);
  });
});

describe("D3 — echo 豁免不外溢到多行命令的第二段", () => {
  test("第二段的引号 flag 被扫到", () => {
    const finding = validateObfuscatedFlags('echo hi\ngrep "-"exec .', "echo");
    expect(finding?.message).toContain("flag");
  });

  test("分号形态的对照（既有行为，不回归）", () => {
    const finding = validateObfuscatedFlags('echo hi; grep "-"exec .', "echo");
    expect(finding?.message).toContain("flag");
  });

  test("反向保护：echo 段的 `---` 占位符不外溢成 finding", () => {
    // `echo "---"` 是惯用分隔符，bash 拼出来只是普通字符串，不可能是有效 flag。
    // 这条防的是「修成一律命中」的假修复。
    expect(validateObfuscatedFlags('echo "---"\nls -la', "echo")).toBeNull();
  });

  test("反向保护：多行只读命令不误报", () => {
    expect(validateObfuscatedFlags("echo hi\nls -la\ncat f", "echo")).toBeNull();
  });
});

describe("D3 — 端到端：checkInjectionPatterns 的拦截层归因", () => {
  test("多行命令的 flag 混淆不会再被 newlines 之外的层漏掉", () => {
    // 这一层是端到端口径：换行本身会先命中 `injection:newlines`（severity ask），
    // 所以这里断言的是「确实被拦」而不是某一条具体 finding。
    // 真正的回归信号在上面的 validateObfuscatedFlags 直调用例——它才区分得出
    // 「因为换行被拦」与「因为混淆 flag 被拦」。
    const finding = checkInjectionPatterns('echo hi\ngrep "-"exec .');
    expect(finding).not.toBeNull();
    expect(finding?.severity).toBe("ask");
  });
});
