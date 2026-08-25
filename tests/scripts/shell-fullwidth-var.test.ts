/**
 * 门禁：shell 脚本里 `$VAR` 后面**不许**紧跟全角标点。
 *
 * ## 为什么值得一条独立门禁：这个坑复发了三次
 *
 * bash 的变量名解析对多字节字符是「按字节吃」的 —— `"$code，"` 里那个全角逗号
 * 会被吞进变量名，于是脚本报：
 *
 *     bash: code<乱码>: unbound variable
 *
 * `set -u`（本仓 shell 脚本一律 `set -euo pipefail`）下这是**直接退出**。
 *
 * 三次现场：
 *   1. `scripts/release.sh` —— `$code）`（见该文件内注释）
 *   2. `scripts/pr-batch.sh` —— `$VERSION，`（见该文件内注释）
 *   3. `evals/external-benchmarks/swe-bench/pull-image.sh` —— `载入成功（$tag）`
 *      （2026-08-25，PR4 收尾时新写的代码又踩，详见方案文档 §附录 ZZ.2d）
 *
 * 前两次都只是「修掉 + 在原地写一条注释」。注释拦不住第三次 ——
 * 因为写新代码的人不会先去读一个无关文件的注释。**所以做成机械门禁。**
 *
 * ## 判据：`${VAR}` 而不是 `$VAR`
 *
 * 花括号显式界定变量名边界，后面跟什么字符都无所谓。
 * 门禁只拦「裸 `$VAR` + 紧跟全角标点」这一种形态，不管注释行 ——
 * 注释里的示例代码（比如上面那些「反面教材」）不该被拦。
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const REPO_ROOT = join(import.meta.dir, "../..");

/** 会吞进变量名的全角标点。列举而非用 Unicode 区间：区间会连带拦住中文字，那是误报。 */
const FULLWIDTH = "（），、：；「」？！。";

/**
 * 裸 `$VAR` 紧跟全角标点。
 *
 * 刻意**不匹配** `${VAR}`（有花括号就是安全的）、也不匹配 `$(cmd)`（命令替换有括号界定）。
 */
const BAD = new RegExp(`\\$[A-Za-z_][A-Za-z0-9_]*[${FULLWIDTH}]`);

function shellFiles(): string[] {
  const r = spawnSync("git", ["ls-files", "*.sh"], { cwd: REPO_ROOT, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`git ls-files 失败: ${r.stderr}`);
  return r.stdout.split("\n").filter(Boolean);
}

describe("shell 门禁：$VAR 后不许紧跟全角标点", () => {
  test("全仓 *.sh 无违规（违规会在 set -u 下让脚本直接退出）", () => {
    const violations: string[] = [];
    for (const f of shellFiles()) {
      const lines = readFileSync(join(REPO_ROOT, f), "utf8").split("\n");
      lines.forEach((line, i) => {
        // 注释行跳过：注释里会写反面教材（本仓几个脚本头部就有）
        if (line.trimStart().startsWith("#")) return;
        if (BAD.test(line)) violations.push(`${f}:${i + 1}: ${line.trim()}`);
      });
    }
    // 断言写成「列表为空」而不是 length===0，失败时能直接看到是哪几行
    expect(violations).toEqual([]);
  });

  /**
   * 变异自证。没有这一步，上面那条断言可能是恒真的
   * （比如正则写错、或 `shellFiles()` 返回空数组也会「通过」）。
   */
  describe("变异自证：门禁确实拦得住、也确实放得过", () => {
    test("裸 $VAR + 全角标点 → 被正则命中", () => {
      expect(BAD.test('bad "exit=$code，不可信"')).toBe(true);
      expect(BAD.test('ok "载入成功（$tag）"')).toBe(true);
      expect(BAD.test('info "缺 $SETTINGS_TEMPLATE，跳过"')).toBe(true);
    });

    test("${VAR} + 全角标点 → 不命中（这就是正确写法）", () => {
      expect(BAD.test('bad "exit=${code}，不可信"')).toBe(false);
      expect(BAD.test('ok "载入成功（${tag}）"')).toBe(false);
    });

    test("$VAR + 半角标点 / 空格 → 不命中（半角不会被吞）", () => {
      expect(BAD.test('echo "exit=$code, fine"')).toBe(false);
      expect(BAD.test('echo "$code done"')).toBe(false);
    });

    test("$(cmd) 后跟全角标点 → 不命中（括号已界定）", () => {
      expect(BAD.test('bad "输出：$(tail -1 "$log")，看这里"')).toBe(false);
    });

    test("扫描确实读到了文件（防 shellFiles() 空数组导致的假绿）", () => {
      const files = shellFiles();
      expect(files.length).toBeGreaterThan(3);
      expect(files.some((f) => f.endsWith(".sh"))).toBe(true);
    });

    /**
     * 最直接的一条：真的用 bash 跑一遍，证明这不是「理论上的问题」。
     * 拿不到 bash 就跳过（不让门禁在没有 bash 的环境里假失败）。
     */
    test("bash 实测：裸写法在 set -u 下失败，${} 写法正常", () => {
      const run = (script: string) =>
        spawnSync("bash", ["-c", script], { encoding: "utf8", timeout: 10_000 });
      const probe = run("echo ok");
      if (probe.error) return; // 没有 bash，跳过

      const bare = run('set -euo pipefail; code=7; echo "exit=$code，不可信"');
      expect(bare.status).not.toBe(0);
      expect(bare.stderr).toContain("unbound variable");

      const braced = run('set -euo pipefail; code=7; echo "exit=${code}，不可信"');
      expect(braced.status).toBe(0);
      expect(braced.stdout.trim()).toBe("exit=7，不可信");
    });
  });
});
