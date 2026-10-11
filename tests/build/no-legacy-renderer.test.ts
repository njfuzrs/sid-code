/**
 * 旧渲染底座不许回来（B9 / T9.1）。
 *
 * T9.1 删掉了 `packages/tui-renderer`、端口的 legacy 分支和 `SID_TUI_RENDERER` 开关，仓库从此只有一套底座。
 * 这三样东西任何一样被加回来都不会让别的测试红：
 *   · 导入 `@sid-code/tui-renderer/*` —— 包不在了会报「模块找不到」，但有人顺手把包加回 workspace 就绿了；
 *   · 目录 `packages/tui-renderer` —— 老克隆的残留 symlink 不在 git 里，不会进 CI；
 *   · 读 `SID_TUI_RENDERER` —— 读一个没人设的变量，行为不变，什么都测不出来。
 * 所以单独钉一道静态断言。
 *
 * 扫描面是 git 追踪的文件（`git ls-files`），历史记录排除：CHANGELOG、changelog/、Agent Note、博客。
 * 这些地方提到旧底座是在记事实，不是在用它。
 */
import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

const REPO_ROOT = resolve(import.meta.dir, "..", "..");

/** 历史记录：提到旧底座是在记事实 */
const HISTORY = [/^CHANGELOG\.md$/, /^changelog\//, /^\.agents\/notes\//, /^website\/blog\//];

/**
 * 刻意写出违规形态的文件，各自要有理由：
 *   · 本文件：下面的自证用例要构造违规样本；
 *   · package-boundary.test.ts：端口门禁的「防假绿」用例用临时目录里的合成导入证明扫描器能检出违规。
 */
const ALLOW = new Set([
  "tests/build/no-legacy-renderer.test.ts",
  "tests/build/package-boundary.test.ts",
]);

const CODE = /\.(ts|tsx|js|mjs|cjs|json|sh)$|(^|\/)Makefile$/;

const IMPORT_RE =
  /(?:from\s+|import\s*\(\s*|require\s*\(\s*)["']@sid-code\/tui-renderer(?:\/[^"']*)?["']/;
const DEP_RE = /"@sid-code\/tui-renderer"\s*:/;
const ENV_READ_RE =
  /process\.env(?:\.SID_TUI_RENDERER\b|\[\s*["']SID_TUI_RENDERER["']\s*\])|\bSID_TUI_RENDERER\s*:/;

export type Violation = {
  file: string;
  line: number;
  kind: "import" | "dependency" | "env";
  text: string;
};

/** 纯函数：给定「路径 → 内容」，返回违规（不读磁盘，便于自证） */
export function findViolations(files: Iterable<[string, string]>): Violation[] {
  const out: Violation[] = [];
  for (const [file, src] of files) {
    if (ALLOW.has(file) || HISTORY.some((re) => re.test(file)) || !CODE.test(file)) continue;
    src.split("\n").forEach((text, i) => {
      const kind = IMPORT_RE.test(text)
        ? "import"
        : file.endsWith("package.json") && DEP_RE.test(text)
          ? "dependency"
          : ENV_READ_RE.test(text)
            ? "env"
            : null;
      if (kind) out.push({ file, line: i + 1, kind, text: text.trim() });
    });
  }
  return out;
}

function trackedFiles(): string[] {
  return execFileSync("git", ["ls-files", "-z"], { cwd: REPO_ROOT, encoding: "utf-8" })
    .split("\0")
    .filter(Boolean);
}

describe("旧渲染底座已删除且不回来（T9.1）", () => {
  const files = trackedFiles();

  test("防空转：真的扫到了代码文件", () => {
    expect(files.filter((f) => CODE.test(f)).length).toBeGreaterThan(1000);
  });

  test("没有任何追踪文件位于 packages/tui-renderer/ 或 render-port/legacy/", () => {
    expect(
      files.filter(
        (f) =>
          f.startsWith("packages/tui-renderer/") ||
          f.startsWith("packages/cli/src/ui/render-port/legacy/") ||
          f === "packages/cli/src/ui/render-port/select.ts",
      ),
    ).toEqual([]);
  });

  test("工作区里也没有 packages/tui-renderer 目录（vendor:fetch 会清掉老克隆的残留）", () => {
    expect(existsSync(join(REPO_ROOT, "packages", "tui-renderer"))).toBe(false);
  });

  test("没有导入 @sid-code/tui-renderer、没有声明它为依赖、没有读 SID_TUI_RENDERER", () => {
    const contents = files
      .filter((f) => CODE.test(f) && existsSync(join(REPO_ROOT, f)))
      .map((f) => [f, readFileSync(join(REPO_ROOT, f), "utf8")] as [string, string]);
    const v = findViolations(contents);
    expect(v.map((x) => `[${x.kind}] ${x.file}:${x.line}  ${x.text}`)).toEqual([]);
  });

  test("自证：三类违规都能检出，历史记录与非代码文件不算", () => {
    const got = findViolations([
      ["packages/cli/src/a.ts", `import { Box } from "@sid-code/tui-renderer/components/Box.tsx";`],
      ["packages/cli/src/b.ts", `const m = await import("@sid-code/tui-renderer/root.ts");`],
      ["packages/cli/package.json", `    "@sid-code/tui-renderer": "workspace:*"`],
      ["packages/cli/src/c.ts", `if (process.env.SID_TUI_RENDERER === "legacy") {}`],
      ["packages/cli/src/d.ts", `const v = process.env["SID_TUI_RENDERER"];`],
      ["packages/cli/tests/e.test.ts", `spawn(app, { env: { SID_TUI_RENDERER: "next" } });`],
      // 不算：历史记录、文档、注释里只提名字
      ["CHANGELOG.md", `import x from "@sid-code/tui-renderer/y.ts"`],
      [".agents/notes/x.ts", `process.env.SID_TUI_RENDERER`],
      ["packages/cli/src/ui/CLAUDE.md", `process.env.SID_TUI_RENDERER`],
      ["packages/cli/src/f.ts", `// 旧底座 tui-renderer 已删除，SID_TUI_RENDERER 不再读`],
    ]);
    expect(got.map((v) => `${v.kind} ${v.file}`)).toEqual([
      "import packages/cli/src/a.ts",
      "import packages/cli/src/b.ts",
      "dependency packages/cli/package.json",
      "env packages/cli/src/c.ts",
      "env packages/cli/src/d.ts",
      "env packages/cli/tests/e.test.ts",
    ]);
  });
});
