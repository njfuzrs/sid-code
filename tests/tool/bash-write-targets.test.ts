/**
 * 第 7 批 · Bash 写文件触发 JIT（§8.9 共同盲区）
 *
 * 本文件的断言比例刻意倾斜：**"不该报"的用例比"该报"的多**。
 * 理由是这条特性的风险不对称 ——
 *   - 漏报的代价 = 回到现状（bash 本来就不触发 JIT），无新增损失
 *   - 误报的代价 = 把不相干目录的规则灌进上下文，既烧 token 又可能让模型
 *     遵循错误规范，且**难以察觉**（没人会去核对"为什么这份规则在这里"）
 * 所以设计目标是"宁漏不误"，测试就得优先锁住不误报。
 */
import { describe, it, expect } from "bun:test";
import { bashWriteTargets } from "../../src/tool/jit-affected-paths.ts";

describe("bashWriteTargets · 该报的高确定性形态", () => {
  it("覆盖写 `> path`", () => {
    expect(bashWriteTargets("echo hi > src/ui/a.tsx")).toEqual(["src/ui/a.tsx"]);
  });

  it("追加写 `>> path`", () => {
    expect(bashWriteTargets("echo hi >> docs/log.md")).toEqual(["docs/log.md"]);
  });

  it("带 fd 前缀的重定向 `2> path`", () => {
    expect(bashWriteTargets("cmd 2> build/err.log")).toEqual(["build/err.log"]);
  });

  it("无空格形态 `>path`", () => {
    expect(bashWriteTargets("echo hi >src/a.ts")).toEqual(["src/a.ts"]);
  });

  it("heredoc 写文件（这是文档点名的典型形态）", () => {
    const cmd = "cat > src/config/new.ts <<'EOF'\nexport const a = 1\nEOF";
    expect(bashWriteTargets(cmd)).toContain("src/config/new.ts");
  });

  it("tee 与 tee -a", () => {
    expect(bashWriteTargets("echo x | tee src/out.txt")).toEqual(["src/out.txt"]);
    expect(bashWriteTargets("echo x | tee -a src/out.txt")).toEqual(["src/out.txt"]);
  });

  it("sed 原地改（-i 与 --in-place）", () => {
    expect(bashWriteTargets("sed -i 's/a/b/' src/ui/Foo.tsx")).toEqual(["src/ui/Foo.tsx"]);
    expect(bashWriteTargets("sed --in-place -e 's/a/b/' lib/x.js")).toEqual(["lib/x.js"]);
  });

  it("带引号的含空格路径", () => {
    expect(bashWriteTargets('echo x > "src/my dir/a.ts"')).toEqual(["src/my dir/a.ts"]);
  });

  it("一条命令多个写目标都报", () => {
    const got = bashWriteTargets("echo a > src/a.ts && echo b > src/b.ts");
    expect(got).toEqual(["src/a.ts", "src/b.ts"]);
  });

  it("绝对路径原样返回（JIT 侧统一归一化，此处不加工）", () => {
    expect(bashWriteTargets("echo x > /proj/src/a.ts")).toEqual(["/proj/src/a.ts"]);
  });

  it("重复目标去重", () => {
    expect(bashWriteTargets("echo a > x.ts; echo b >> x.ts")).toEqual(["x.ts"]);
  });
});

describe("bashWriteTargets · 不该报的形态（误报比漏报更贵）", () => {
  it("纯读命令不报", () => {
    expect(bashWriteTargets("cat src/a.ts")).toEqual([]);
    expect(bashWriteTargets("ls -la src/")).toEqual([]);
    expect(bashWriteTargets("git status")).toEqual([]);
  });

  it("变量与命令替换不报（值在运行时才定，静态提取必错）", () => {
    expect(bashWriteTargets("echo x > $OUT")).toEqual([]);
    expect(bashWriteTargets("echo x > ${OUT}/a.ts")).toEqual([]);
    expect(bashWriteTargets("echo x > $(mktemp)")).toEqual([]);
    expect(bashWriteTargets("echo x > `mktemp`")).toEqual([]);
  });

  it("通配符不报（展开结果未知）", () => {
    expect(bashWriteTargets("echo x > src/*.ts")).toEqual([]);
  });

  it("fd 复制 `>&2` / `2>&1` 不是文件路径", () => {
    expect(bashWriteTargets("echo err >&2")).toEqual([]);
    expect(bashWriteTargets("cmd > out.log 2>&1")).toEqual(["out.log"]);
  });

  it("/dev/null 与 /tmp 不报（不是项目业务文件，报了纯白扫）", () => {
    expect(bashWriteTargets("cmd > /dev/null")).toEqual([]);
    expect(bashWriteTargets("cmd 2> /dev/null")).toEqual([]);
    expect(bashWriteTargets("cmd > /tmp/scratch.log")).toEqual([]);
  });

  it("sed 不带 -i 不报（没改文件，只是读）", () => {
    expect(bashWriteTargets("sed 's/a/b/' src/a.ts")).toEqual([]);
  });

  it("sed -i 但最后一个 token 是脚本本体时不报（避免把 's/a/b/' 当文件）", () => {
    expect(bashWriteTargets("sed -i 's/a/b/'")).toEqual([]);
  });

  it("管道到命令不报（`| grep` 的 grep 不是写目标）", () => {
    expect(bashWriteTargets("cat a.ts | grep foo")).toEqual([]);
  });

  it("非字符串 / 空输入安全返回空（契约要求不抛）", () => {
    expect(bashWriteTargets(undefined)).toEqual([]);
    expect(bashWriteTargets(null)).toEqual([]);
    expect(bashWriteTargets("")).toEqual([]);
    expect(bashWriteTargets("   ")).toEqual([]);
    expect(bashWriteTargets(123)).toEqual([]);
    expect(bashWriteTargets({})).toEqual([]);
  });

  it("超长命令不挂死（heredoc 灌大段内容的真实形态）", () => {
    const huge = "cat > src/big.ts <<'EOF'\n" + "x".repeat(50_000) + "\nEOF";
    const t0 = performance.now();
    const got = bashWriteTargets(huge);
    // 只要求不退化，不断言具体耗时阈值（CI 机器负载不可控）
    expect(performance.now() - t0).toBeLessThan(1000);
    expect(got).toContain("src/big.ts");
  });

  it("契约：任何输入都不抛", () => {
    const weird = [">>>", "> > >", "|||", "sed -i", "tee", ">", "$(", "```", "\0", "a".repeat(9999)];
    for (const w of weird) {
      expect(() => bashWriteTargets(w)).not.toThrow();
    }
  });
});
