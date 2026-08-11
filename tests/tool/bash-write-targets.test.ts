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
import { bashWriteTargets } from "@sid-code/core/tool/jit-affected-paths.ts";

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

/**
 * B4 · `cp`/`mv`/`install`/`touch`/`mkdir`（2026-08-08 新增）
 *
 * 这五个动词此前被刻意排除，理由写在 `jit-affected-paths.ts` 的函数头注释里：
 * 「目标可能是目录、可能带多个源，语义判定复杂」。**「目标可能是目录」这条已被实测推翻** ——
 * JIT 下游 `discoverDetailed` 有 `targetIsDir` 分支，传目录 / 传尾斜杠 / 传不存在的路径
 * 三种形态全部安全。上游因为一个不存在的约束拒绝提取了很久。
 */
describe("bashWriteTargets · B4 文件搬运/创建动词", () => {
  it("cp / mv 取目标（最后一个非选项 token）", () => {
    expect(bashWriteTargets("cp src/a.ts src/ui/b.ts")).toEqual(["src/ui/b.ts"]);
    expect(bashWriteTargets("mv src/a.ts src/ui/b.ts")).toEqual(["src/ui/b.ts"]);
  });

  it("目标是目录（含尾斜杠）也报 —— 下游能消化，这正是原注释里被推翻的那条理由", () => {
    expect(bashWriteTargets("cp -r src/a src/ui/")).toEqual(["src/ui/"]);
    expect(bashWriteTargets("mv src/a.ts src/ui")).toEqual(["src/ui"]);
  });

  it("多源形态只取目标（`cp a b dst/` 里 a、b 是源不是写目标）", () => {
    expect(bashWriteTargets("cp a.ts b.ts src/ui/")).toEqual(["src/ui/"]);
    expect(bashWriteTargets("mv a.ts b.ts c.ts src/ui/")).toEqual(["src/ui/"]);
  });

  it("touch / mkdir 的每个非选项参数都是目标", () => {
    expect(bashWriteTargets("touch src/ui/New.tsx")).toEqual(["src/ui/New.tsx"]);
    expect(bashWriteTargets("touch src/a.ts src/ui/b.tsx")).toEqual(["src/a.ts", "src/ui/b.tsx"]);
    expect(bashWriteTargets("mkdir -p src/ui/sub")).toEqual(["src/ui/sub"]);
  });

  it("install 带值选项（`-m 644`）的值不被当成路径", () => {
    expect(bashWriteTargets("install -m 644 a.conf src/etc/a.conf")).toEqual(["src/etc/a.conf"]);
    // touch/mkdir 走逐个 push 分支，带值选项的值必须被吃掉，否则 `755` 会变成目标
    expect(bashWriteTargets("mkdir -m 755 src/ui/sub")).toEqual(["src/ui/sub"]);
  });

  it("源含通配不影响提取（只取目标），但目标含通配一律放弃", () => {
    expect(bashWriteTargets("cp src/*.ts src/ui/")).toEqual(["src/ui/"]);
    expect(bashWriteTargets("cp src/a.ts src/*/")).toEqual([]);
  });

  it("过滤链继续生效：变量 / tmp / dev（新增动词不得绕过 push 的判据）", () => {
    expect(bashWriteTargets("cp src/a.ts $DEST")).toEqual([]);
    expect(bashWriteTargets("mv a /tmp/x")).toEqual([]);
    expect(bashWriteTargets("cp a.ts /dev/null")).toEqual([]);
    expect(bashWriteTargets("touch $F")).toEqual([]);
  });

  it("动词必须在片段开头（不误抓 `git mv` 之外的 prose 与子串）", () => {
    // `xcp` / `mvx` 这类子串不是这五个动词
    expect(bashWriteTargets("xcp a b")).toEqual([]);
    expect(bashWriteTargets("echo cp a.ts b.ts")).toEqual([]);
  });

  it("与重定向形态共存时两边都报", () => {
    expect(bashWriteTargets("cp src/a.ts src/ui/b.ts && echo done > src/log.txt")).toEqual([
      "src/log.txt",
      "src/ui/b.ts",
    ]);
  });

  it("只有动词没有参数时安全返回", () => {
    for (const c of ["cp", "mv ", "touch", "mkdir -p", "install -m 644"]) {
      expect(() => bashWriteTargets(c)).not.toThrow();
      expect(bashWriteTargets(c)).toEqual([]);
    }
  });
});

/**
 * **刻意永久不支持**的形态（设计取舍，不是待办）。
 *
 * 这一组是**显式断言**而非遗漏：不写的话，未来有人「顺手」给 `rm` 加上支持
 * 不会有任何东西变红，而那条裁决就静默失效了。
 * **设计取舍也需要测试来固定，不然它和缺口区分不开。**
 */
describe("bashWriteTargets · 刻意不支持（断言，不是遗漏）", () => {
  it("rm 不报 —— 删掉之后那个目录的规则不再适用于任何后续操作，注入是纯浪费", () => {
    expect(bashWriteTargets("rm src/ui/Old.tsx")).toEqual([]);
    expect(bashWriteTargets("rm -rf src/ui/legacy")).toEqual([]);
  });

  it("程序自己写文件不报 —— 要支持等于要静态分析任意程序，不是难而是不可能", () => {
    expect(bashWriteTargets("python src/ui/gen.py")).toEqual([]);
    expect(bashWriteTargets("bun scripts/codegen.ts")).toEqual([]);
    expect(bashWriteTargets("make build")).toEqual([]);
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
