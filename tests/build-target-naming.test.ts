/**
 * 构建目标命名契约的反漂移测试（2026-07-31）。
 *
 * 背景：旧设计把 `make build` 绑成「bump 版本号 + 编译」、把日常不 bump 的构建叫
 * `make rebuild`，语义与所有项目的通用直觉正好相反。结果本地开发（尤其是模型驱动的
 * 会话）反复条件反射地敲 `make build`，静默把 package.json 版本号 +1；后面再跑
 * release.sh 就一次跳两个版本。真实案例见 docs/_template/rebuild和build命令模型经常搞混.txt。
 *
 * 修复方向不是「写文档提醒别敲错」——最容易被敲到的词就该绑到最安全的行为上。所以：
 *   make build       不 bump（日常）
 *   make build-bump  bump（少见，显式）
 *   make rebuild     build 的别名（历史文档兼容）
 *
 * 本文件锁住这个契约。断言的是**行为归属**（哪个目标调 bump-version）而非文案，
 * 因为一旦有人把 bump 挪回 `build`，上面那个陷阱立刻复活，且失败现场很难归因。
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");
const MAKEFILE = readFileSync(join(ROOT, "Makefile"), "utf8");

/**
 * 抽出某个 make 目标的配方体（recipe）——即目标行之后所有以 TAB 开头的行。
 * 只看配方体、不看整份文件，才能断言"bump 属于哪个目标"而非"文件里有没有出现过 bump"。
 */
function recipeOf(target: string): string {
  const lines = MAKEFILE.split("\n");
  const startIdx = lines.findIndex((l) => new RegExp(`^${target}:`).test(l));
  expect(startIdx, `Makefile 里找不到目标 ${target}:`).toBeGreaterThanOrEqual(0);

  const body: string[] = [];
  for (const line of lines.slice(startIdx + 1)) {
    if (line.startsWith("\t")) {
      body.push(line.trim());
      continue;
    }
    // 空行不终止配方（make 允许），非 TAB 的实义行才终止
    if (line.trim() === "") continue;
    break;
  }
  return body.join("\n");
}

describe("构建目标命名契约", () => {
  test("make build 不得 bump 版本号（最易误敲的词必须最安全）", () => {
    expect(recipeOf("build")).not.toContain("bump-version");
  });

  test("make build 确实执行编译与产物自检", () => {
    const recipe = recipeOf("build");
    // 配方里用的是 $(BUN) 变量，不是字面量 bun——匹配 "build --compile" 这段更稳
    expect(recipe).toContain("build --compile");
    expect(recipe).toContain("--self-check");
  });

  test("make build-bump 才是唯一 bump 版本号的构建目标", () => {
    expect(recipeOf("build-bump")).toContain("bump-version");
  });

  test("bump-version 在整份 Makefile 中只被 build-bump 引用一次", () => {
    // 防止有人「顺手」在别的目标里也加回 bump——那等于把陷阱换个门重开
    const hits = MAKEFILE.split("\n").filter(
      (l) => l.startsWith("\t") && l.includes("bump-version"),
    );
    expect(hits).toHaveLength(1);
  });

  test("make rebuild 保留为 build 的别名（历史文档不该突然报错）", () => {
    const recipe = recipeOf("rebuild");
    expect(recipe).toContain("build");
    expect(recipe).not.toContain("bump-version");
  });

  test("三个目标都在 .PHONY 中声明", () => {
    const phony = MAKEFILE.split("\n").find((l) => l.startsWith(".PHONY:")) ?? "";
    for (const target of ["build", "rebuild", "build-bump"]) {
      expect(phony).toContain(target);
    }
  });
});

describe("package.json 构建脚本与 make 对齐", () => {
  const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));

  test("bun run build 委托给 make build（避免第三种构建路径）", () => {
    // 旧值是裸 `bun build --compile ...`：既不嵌入内置 skill 也不跑 --self-check，
    // 与 make build 静默不等价，CI 用它构建出的产物缺内置 skill。
    expect(pkg.scripts.build).toBe("make build");
  });

  test("bun run build 不得 bump 版本号", () => {
    expect(pkg.scripts.build).not.toContain("bump-version");
  });

  test("build-bump 脚本存在且指向 make build-bump", () => {
    expect(pkg.scripts["build-bump"]).toBe("make build-bump");
  });
});

describe("文档与实现一致（CLAUDE.md 是模型读到的第一手指令）", () => {
  const claudeMd = readFileSync(join(ROOT, "CLAUDE.md"), "utf8");

  test("§0 构建验证铁律指向 make build", () => {
    expect(claudeMd).toContain("跑 `make build` 验证构建成功");
  });

  test("不再宣称 make build 会 +1 版本号", () => {
    // 旧表格写「`make build` | +1 | 本地自测」——正是误导来源
    expect(claudeMd).not.toMatch(/`make build`\s*\|\s*\+1/);
  });

  test("Make 目标表把 build 标为版本号不变", () => {
    expect(claudeMd).toMatch(/`make build`\s*\|\s*不变/);
  });

  test("build-bump 已在文档中登场（否则用户找不到 bump 入口）", () => {
    expect(claudeMd).toContain("make build-bump");
  });
});
