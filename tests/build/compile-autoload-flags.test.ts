/**
 * 编译产物「不读取运行目录配置」防漂移哨兵 + 行为自证（P0-1 / P0-2）
 *
 * 背景：`bun build --compile` 的产物默认在运行时读取 **cwd** 的 `.env` / `.env.local` /
 * `.env.{NODE_ENV}` 注入 process.env，并读取 cwd 的 `bunfig.toml`（其 `preload` 会执行任意代码）。
 * 这一步发生在任何 JS 执行之前，工作区信任门与项目级配置白名单都管不到——
 * 在克隆的仓库里启动 sid-code，就可能被改道（如主模型 baseURL）或执行仓库里的代码。
 * JS 层没有防御位置，只能在编译参数上关。
 *
 * 与 node-env-define / build-info-define 同形态：修复只是每条构建命令多几个 flag，
 * **新增构建入口时极易漏带**，漏了构建照样 exit 0、单测照样全绿。
 *
 * ⚠️ 每条断言都配了「变异自证」注释：把实现改成那样时它必须变红。
 */

import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..", "..");

/** 每条 --compile 命令必须带齐的参数。tsconfig / package-json 当前默认已关，显式写上防 bun 改默认值。 */
const REQUIRED_FLAGS = [
  "--no-compile-autoload-dotenv",
  "--no-compile-autoload-bunfig",
  "--no-compile-autoload-tsconfig",
  "--no-compile-autoload-package-json",
] as const;

function nonCommentLines(text: string): string[] {
  return text.split("\n").filter((l) => !l.trimStart().startsWith("#"));
}

/**
 * 取出 shell 脚本里每条 `bun build --compile` 命令的完整文本（含 `\` 续行）。
 * 只看首行会漏掉续行里的参数，导致哨兵误红或误绿。
 */
function shellCompileCommands(text: string): string[] {
  const lines = nonCommentLines(text);
  const cmds: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i].includes("bun build --compile")) continue;
    let cmd = lines[i];
    while (cmd.trimEnd().endsWith("\\") && i + 1 < lines.length) {
      i++;
      cmd += "\n" + lines[i];
    }
    cmds.push(cmd);
  }
  return cmds;
}

/** 判定一条命令是否带齐参数，返回缺失项（空数组 = 齐全）。 */
function missingFlags(cmd: string): string[] {
  return REQUIRED_FLAGS.filter((f) => !new RegExp(`${f}(?![-\\w])`).test(cmd));
}

describe("编译产物禁止自动加载运行目录配置（哨兵）", () => {
  test("Makefile：BUILD_NO_AUTOLOAD 带齐四个参数，且每条 --compile 行都引用它", () => {
    const mk = readFileSync(join(ROOT, "Makefile"), "utf8");
    const varLine = mk.match(/^BUILD_NO_AUTOLOAD\s*=\s*(.+)$/m);
    expect(varLine).not.toBeNull();
    // 变异自证：从 BUILD_NO_AUTOLOAD 删掉任一参数 → 红
    expect(missingFlags(varLine![1])).toEqual([]);

    const compileLines = nonCommentLines(mk).filter((l) => l.includes("build --compile"));
    expect(compileLines.length).toBeGreaterThan(0);
    // 变异自证：去掉 build 目标里的 $(BUILD_NO_AUTOLOAD) → 红
    for (const line of compileLines) {
      expect(line.includes("$(BUILD_NO_AUTOLOAD)") || missingFlags(line).length === 0).toBe(true);
    }
  });

  for (const rel of ["scripts/release.sh", "scripts/build-branch-artifact.sh"]) {
    test(`${rel}：每条 bun build --compile 命令都带齐四个参数`, () => {
      const cmds = shellCompileCommands(readFileSync(join(ROOT, rel), "utf8"));
      expect(cmds.length).toBeGreaterThan(0);
      // 变异自证：删掉续行里的任一 --no-compile-autoload-* → 红
      for (const cmd of cmds) expect(missingFlags(cmd)).toEqual([]);
    });
  }

  test("哨兵自证：缺参数的命令会被判出来，前缀相同的参数不会被误判为齐全", () => {
    expect(missingFlags("bun build --compile --outfile x a.ts")).toEqual([...REQUIRED_FLAGS]);
    // `--no-compile-autoload-dotenvX` 不是目标参数，不能算命中
    const almost = REQUIRED_FLAGS.map((f) => f + "X").join(" ");
    expect(missingFlags(almost)).toEqual([...REQUIRED_FLAGS]);
    // 续行解析：参数写在第二行也要被算进去
    const multi = "bun build --compile \\\n  " + REQUIRED_FLAGS.join(" ") + " \\\n  a.ts\n";
    expect(shellCompileCommands(multi).map(missingFlags)).toEqual([[]]);
  });
});

describe("编译产物禁止自动加载运行目录配置（行为自证）", () => {
  // 用最小程序真编译、真运行：证明这组参数在当前 bun 版本上确实生效，
  // 而不是「参数写上了、但 bun 改了语义」。编完整 sid-code 要几十秒，最小程序足以证明参数语义。
  const work = mkdtempSync(join(tmpdir(), "compile-autoload-"));
  const projectDir = join(work, "untrusted-repo");
  const marker = join(work, "preload-ran");
  const entry = join(work, "main.ts");

  afterAll(() => rmSync(work, { recursive: true, force: true }));

  writeFileSync(
    entry,
    "console.log(JSON.stringify({a:process.env.A_FROM_DOTENV??null,b:process.env.B_FROM_LOCAL??null,c:process.env.C_FROM_PROD??null}));\n",
  );

  function setupUntrustedRepo(): void {
    rmSync(projectDir, { recursive: true, force: true });
    Bun.spawnSync(["mkdir", "-p", projectDir]);
    writeFileSync(join(projectDir, ".env"), "A_FROM_DOTENV=leaked\n");
    writeFileSync(join(projectDir, ".env.local"), "B_FROM_LOCAL=leaked\n");
    // 产物编译时 NODE_ENV 被 define 为 production，.env.production 同样在 bun 的加载列表里
    writeFileSync(join(projectDir, ".env.production"), "C_FROM_PROD=leaked\n");
    writeFileSync(
      join(projectDir, "p.ts"),
      `require("node:fs").writeFileSync(${JSON.stringify(marker)}, "PWNED");\n`,
    );
    writeFileSync(join(projectDir, "bunfig.toml"), 'preload = ["./p.ts"]\n');
  }

  function compileAndRun(extraFlags: string[]): { out: string; preloadRan: boolean } {
    const bin = join(work, `bin-${extraFlags.length}`);
    const b = Bun.spawnSync(
      [
        process.execPath,
        "build",
        "--compile",
        ...extraFlags,
        "--define",
        'process.env.NODE_ENV="production"',
        "--outfile",
        bin,
        entry,
      ],
      { cwd: work, stdout: "pipe", stderr: "pipe", env: { ...process.env } },
    );
    expect(b.exitCode, b.stderr.toString()).toBe(0);
    setupUntrustedRepo();
    rmSync(marker, { force: true });
    // 清掉父进程里可能存在的同名变量，避免假阳性
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) {
      if (v !== undefined && !/^(A_FROM_DOTENV|B_FROM_LOCAL|C_FROM_PROD)$/.test(k)) env[k] = v;
    }
    const r = Bun.spawnSync([bin], { cwd: projectDir, env, stdout: "pipe", stderr: "pipe" });
    expect(r.exitCode, r.stderr.toString()).toBe(0);
    return { out: r.stdout.toString().trim(), preloadRan: existsSync(marker) };
  }

  test("对照组：不带参数时产物会读 .env 与 bunfig preload（证明测试本身能看见漏洞）", () => {
    // 这条红了说明 bun 改了默认值或测试夹具失效——那下面那条「带参数后为空」就不再含信息。
    const r = compileAndRun([]);
    expect(JSON.parse(r.out).a).toBe("leaked");
    expect(r.preloadRan).toBe(true);
  }, 60_000);

  test("带齐参数后：.env / .env.local / .env.production 均不注入，preload 不执行", () => {
    // 变异自证：去掉 --no-compile-autoload-dotenv → a/b/c 变 leaked → 红；
    //           去掉 --no-compile-autoload-bunfig → 标记文件出现 → 红
    const r = compileAndRun([...REQUIRED_FLAGS]);
    expect(JSON.parse(r.out)).toEqual({ a: null, b: null, c: null });
    expect(r.preloadRan).toBe(false);
  }, 60_000);
});
