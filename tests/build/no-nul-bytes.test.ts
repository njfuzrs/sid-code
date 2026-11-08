/**
 * 源码裸 NUL 字节门禁 —— CI 侧兜底（X3-12）。
 *
 * ## 为什么要在 CI 再写一遍（而不是只有 pre-commit）
 *
 * pre-commit 已经有一道完全相同的检查（`scripts/git-hooks/pre-commit.sh` 的
 * 「源码裸 NUL 字节门禁」），但 hook 装在本地、可被 `--no-verify` 直接跳过。
 * 本仓其余 hook 检查在 CI 都有等价物 —— 参考页对账 → `tests/website/gen-reference.test.ts`，
 * oxlint / oxfmt → lint job，Agent Note 形态 → `tests/build/agent-note-gate.test.ts` ——
 * 只有这条没有，于是「一次 --no-verify 就能把一个含 NUL 的源码文件合进 main」。
 *
 * ## 为什么要防裸 NUL（论证摘自 hook，改动前先读那里的完整版）
 *
 * 源码里出现裸 NUL(0x00) 会让 **grep 把整个文件判为二进制而静默跳过**：不是
 * 「漏掉 NUL 之后的部分」，是全文件所有符号都搜不到，且 `exit=1` 与「真的没有匹配」
 * 不可区分。实测 `repeated-readonly-guard.ts` 就因一个用作复合键分隔符的裸 `\0`
 * 对 grep 完全失明 —— 一次审计开局差点因此写出「16 条死防线」的假结论。
 * 合法需求用转义写法（`"\x1f"` 运行时等价、源码字节不含控制字符）。
 *
 * ## 检测手段：读字节判 0x00，不用 grep
 *
 * `grep -q "$(printf '\000')"` 是陷阱：命令替换会剥掉 NUL，模式退化成空串，于是它
 * 匹配所有干净文件、漏掉真含 NUL 的文件（判定完全反转，hook 注释里有实测记录）。
 * 而 grep 对二进制文件的行为本身又正是本门禁要防的东西 —— 用它自查等于用坏尺子量尺子。
 * 这里直接读字节判 `0x00`，不受 locale / 命令行拼接影响。
 *
 * ## 与 hook 的口径必须同源
 *
 * 扩展名清单与排除规则抄自 `pre-commit.sh` 的 `STAGED_SOURCES`。两边不一致的失效形态是
 * 「hook 拦了 CI 不拦」（绕过 hook 仍有缺口）或反过来（PR 上冒出 pre-commit 从没提示过的红）。
 * 所以末尾有一条断言把两边钉在一起：改 hook 的清单就必须同步改这里。
 */
import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "../..");
const PRE_COMMIT_SH = readFileSync(join(ROOT, "scripts/git-hooks/pre-commit.sh"), "utf8");

/** 与 `pre-commit.sh` 的 `STAGED_SOURCES` 同口径；改这里必须同步改 hook（反之亦然）。 */
const SOURCE_EXT_PATTERN = String.raw`\.(ts|tsx|js|jsx|mjs|cjs|sh|json|md)$`;
const SOURCE_EXT = new RegExp(SOURCE_EXT_PATTERN);
/** hook 里的 `grep -v -E '^vendor/'`：只排除仓库根的 vendor/（内嵌二进制所在处）。 */
const EXCLUDE = /^vendor\//;

/** 判一段字节里有没有 NUL(0x00)。独立成函数是为了让「检测器本身」也能被断言。 */
function hasNulByte(buf: Buffer): boolean {
  return buf.includes(0);
}

/**
 * 被追踪的源码文件清单。
 *
 * 用 `git ls-files` 而不是遍历目录：口径是「会进仓库的字节」，未追踪的构建产物
 * （dist/、website/.vitepress/dist/）不该被这条门禁管。
 * `-z` + NUL 分隔：文件名里出现空格或换行也不会被拆错。
 */
function trackedSourceFiles(): string[] {
  const out = execFileSync("git", ["ls-files", "-z"], {
    cwd: ROOT,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  return out.split("\0").filter((f) => f.length > 0 && SOURCE_EXT.test(f) && !EXCLUDE.test(f));
}

describe("源码裸 NUL 字节（CI 兜底，X3-12）", () => {
  // 这一条守的是「检测器不空转」：如果 hasNulByte 写错（比如永远返回 false），
  // 下面的全仓扫描会恒绿 —— 恒绿的门禁比没有门禁更危险。
  test("检测器对含 NUL 的字节判红、对干净字节放行", () => {
    expect(hasNulByte(Buffer.from("const sep = '\\x1f';\n"))).toBe(false);
    expect(hasNulByte(Buffer.from([0x61, 0x00, 0x62]))).toBe(true);
    // 尾部 NUL 与开头 NUL 同样要命中（只用 indexOf 判中段会漏掉这两个边界）
    expect(hasNulByte(Buffer.from([0x61, 0x62, 0x00]))).toBe(true);
    expect(hasNulByte(Buffer.from([0x00, 0x61, 0x62]))).toBe(true);
    expect(hasNulByte(Buffer.alloc(0))).toBe(false);
  });

  // 扫描集为空时（git 命令失败、cwd 不对、gitignore 把一切排除）下面那条会恒绿。
  // 用「量级」而不是「精确个数」：文件数会随开发增长，写死一个数字只会变成噪音。
  test("扫描集非空（防 git ls-files 失败后空转）", () => {
    const files = trackedSourceFiles();
    expect(files.length).toBeGreaterThan(500);
    // 抽查几个必然存在的文件，确认过滤规则没有把整个仓库筛掉
    expect(files).toContain("package.json");
    expect(files).toContain("scripts/git-hooks/pre-commit.sh");
  });

  test("被追踪的源码里没有裸 NUL 字节", () => {
    const hits: string[] = [];
    for (const rel of trackedSourceFiles()) {
      const buf = readFileSync(join(ROOT, rel));
      if (hasNulByte(buf)) hits.push(rel);
    }
    // 失败时把命中文件全列出来：只说「有 NUL」而不说在哪，等于让人自己重新扫一遍
    expect(hits).toEqual([]);
  });

  // 口径同步：hook 改了扩展名清单而这里没跟上，两边就会漂移（见文件头）。
  // 用「hook 里必须原样出现这条 pattern」而不是解析 shell —— 断言要能被一眼读懂，
  // 红了的修法就是「把这里和 hook 改成同一份清单」。
  test("扩展名口径与 pre-commit hook 一致", () => {
    expect(PRE_COMMIT_SH).toContain(`grep -E '${SOURCE_EXT_PATTERN}'`);
  });
});
