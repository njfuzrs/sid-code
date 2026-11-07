/**
 * verify-agent-note：路径解析与 git 失败处理的回归（X3-09）。
 *
 * ## 缺陷形态（两条，都静默）
 *
 * 1. `root` 取自 `new URL("..", import.meta.url).pathname` —— 这是 **percent-encoded**
 *    的（空格 → `%20`）。仓库路径含空格或非 ASCII 时 root 指向一个不存在的目录。
 * 2. `trackedNotes()` 用 `?? ""` 兜底 spawnSync 的输出，且不看 `r.error` / `r.status`。
 *
 * 两条叠加的后果：git 在坏 cwd 上失败 → stdout 为 null → `?? ""` → 空数组 →
 * 打印「0 份 Agent Note 形态合规」→ **exit 0**。而 pre-commit 只看退出码，
 * 于是「路径里带空格的人」这道门禁从来没跑过，却一直显示绿色。
 *
 * ## 测法
 *
 * 不依赖真实仓库的路径（CI 的 checkout 路径也不可控），而是把脚本复制到
 * 含空格 + 非 ASCII 的 tmpdir 里，铺一个最小仓库夹具真跑：
 *
 *   - 正常夹具 → `checked` 必须 > 0（修复前是 0）
 *   - 非 git 目录 → 必须非 0 退出并报出原因（修复前 exit 0）
 *
 * 每条都配变异自证：把被测的那行改回去，确认断言真的会红。
 * 「改回去了它还绿」说明这条测试没测到行为，只是走个过场。
 */
import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "../..");
const SCRIPT = join(ROOT, "scripts/verify-agent-note.ts");
const SRC = readFileSync(SCRIPT, "utf8");

/** 一份形态合规的最小 Note。文件名刻意用 ASCII —— 见下方「已知的相邻问题」。 */
const NOTE = `---
Status: implemented
Date: 2026-11-07
---
# 示例

## 决定了什么

A

## 放弃了什么

B

## 拿什么证明它生效了

C
`;

/**
 * 在 `dir` 下铺最小夹具：`scripts/` + `.agents/notes/`（一份已入库的 Note）。
 * `mutate` 把源码改坏（变异自证用）；改不中会抛错，**不允许静默返回原文** ——
 * 那会让变异断言变成恒绿。
 */
function seed(dir: string, mutate?: (src: string) => string): string {
  mkdirSync(join(dir, "scripts"), { recursive: true });
  const scriptPath = join(dir, "scripts/verify-agent-note.ts");
  let body = SRC;
  if (mutate) {
    const mutated = mutate(SRC);
    if (mutated === SRC) throw new Error("变异没命中源码 —— 被测写法变了，请同步更新测试");
    body = mutated;
  }
  writeFileSync(scriptPath, body);

  const noteDir = join(dir, ".agents/notes/implemented/process");
  mkdirSync(noteDir, { recursive: true });
  writeFileSync(join(noteDir, "2026-11-07-demo.md"), NOTE);
  return scriptPath;
}

/**
 * 跑脚本。
 *
 * 清掉继承来的 `GIT_*` 并设 `GIT_CEILING_DIRECTORIES`：否则 git 可能从 tmpdir
 * **向上找到本仓**（开发机与 CI 的 tmp 位置不同），「非仓库目录」用例就永远测不到失败。
 */
function run(scriptPath: string, cwd: string) {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v === undefined || k.startsWith("GIT_")) continue;
    env[k] = v;
  }
  env.GIT_CEILING_DIRECTORIES = cwd;
  const r = spawnSync("bun", [scriptPath, "--json"], { cwd, encoding: "utf8", env });
  return { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

/** 在 tmpdir 下建一个含空格 + 非 ASCII 的目录（复现外部贡献者的 clone 路径）。 */
function spaceyDir(): string {
  return join(mkdtempSync(join(tmpdir(), "sid-note-path-")), "仓库 with space");
}

function git(cwd: string, args: string[]): void {
  const r = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")} 失败：${r.stderr}`);
}

describe("verify-agent-note：路径含空格 / 非 ASCII 时仍能读到 Note（X3-09）", () => {
  test("含空格 + 中文的仓库路径下 checked > 0（修复前 checked === 0）", () => {
    const dir = spaceyDir();
    const scriptPath = seed(dir);
    git(dir, ["init", "-q"]);
    git(dir, ["add", "-A"]);

    const r = run(scriptPath, dir);
    expect(r.status).toBe(0);
    const { checked } = JSON.parse(r.stdout) as { checked: number };
    expect(checked).toBe(1);
  });

  test("变异自证：换回未解码的 URL.pathname，上一条会红", () => {
    const dir = spaceyDir();
    const scriptPath = seed(dir, (src) =>
      src.replace(
        /fileURLToPath\(new URL\("\.\.", import\.meta\.url\)\)/,
        'new URL("..", import.meta.url).pathname',
      ),
    );
    git(dir, ["init", "-q"]);
    git(dir, ["add", "-A"]);

    const r = run(scriptPath, dir);
    // 旧写法下 root 是 `…/仓库%20with%20space/` —— cwd 不存在，git 拿不到任何文件。
    // 这里不断言退出码：两种失效形态（静默 0 份 / 抛错）都算「测出来是坏的」，
    // 关键是 checked 不能等于 1。
    const checked = r.status === 0 ? (JSON.parse(r.stdout) as { checked: number }).checked : 0;
    expect(checked).toBe(0);
  });
});

describe("verify-agent-note：git 失败必须非 0 退出（X3-09）", () => {
  test("非 git 目录 → 非 0 退出，且 stderr 说明是 git 失败（修复前 exit 0）", () => {
    const dir = spaceyDir();
    const scriptPath = seed(dir); // 刻意不 git init

    const r = run(scriptPath, dir);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain("git ls-files");
    // 不能让「0 份合规」这句话出现在失败场景里 —— 它正是旧行为的假绿来源
    expect(r.stdout + r.stderr).not.toContain("份 Agent Note 形态合规");
  });

  test("变异自证：去掉 spawnSync 的 error / status 检查，上一条会红", () => {
    const dir = spaceyDir();
    const scriptPath = seed(dir, (src) =>
      src
        .replace("if (r.error) {", "if (false && r.error) {")
        .replace("if (r.status !== 0) {", "if (false && r.status !== 0) {"),
    );

    const r = run(scriptPath, dir);
    // 旧行为：拿不到文件 → checked 0 → 打印「0 份…合规」→ exit 0
    expect(r.status).toBe(0);
    expect(JSON.parse(r.stdout) as { checked: number }).toMatchObject({ checked: 0 });
  });
});

/**
 * 同形写法扫描：`new URL(...).pathname` 拿来当文件系统路径，全仓 scripts/ 只允许 0 处。
 *
 * 为什么做成静态扫描而不是逐处补测试：这条缺陷的形态是「写法本身错了」，
 * 每一个新脚本都可能再抄一次（X3-09 原文就点出 `fetch-ripgrep.ts` 是同形写法）。
 * 逐处补行为测试只能守住今天这两处。
 */
describe("scripts/ 下不再有拿 URL.pathname 当文件路径的写法（防同形复发）", () => {
  const BAD = /new URL\([^)]*import\.meta\.url[^)]*\)\.pathname/;

  function offenders(): string[] {
    const r = spawnSync("git", ["ls-files", "scripts/"], { cwd: ROOT, encoding: "utf8" });
    if (r.status !== 0) throw new Error(`git ls-files 失败：${r.stderr}`);
    const out: string[] = [];
    for (const f of r.stdout.split("\n").filter((f) => f.endsWith(".ts"))) {
      const text = readFileSync(join(ROOT, f), "utf8");
      text.split("\n").forEach((line, i) => {
        if (line.trimStart().startsWith("*") || line.trimStart().startsWith("//")) return;
        if (BAD.test(line)) out.push(`${f}:${i + 1}: ${line.trim()}`);
      });
    }
    return out;
  }

  test("零违规", () => {
    expect(offenders()).toEqual([]);
  });

  test("扫描确实读到了文件（防「空数组 = 全绿」）", () => {
    const r = spawnSync("git", ["ls-files", "scripts/"], { cwd: ROOT, encoding: "utf8" });
    expect(r.stdout.split("\n").filter((f) => f.endsWith(".ts")).length).toBeGreaterThan(10);
  });

  test("变异自证：正则命中旧写法、放过正确写法", () => {
    expect(BAD.test('const root = new URL("..", import.meta.url).pathname;')).toBe(true);
    expect(BAD.test('const ROOT = join(dirname(new URL(import.meta.url).pathname), "..");')).toBe(
      true,
    );
    expect(BAD.test("fileURLToPath(new URL('..', import.meta.url))")).toBe(false);
    // 判据锚在 `import.meta.url` 上：普通的 URL 取 pathname（解析 HTTP 地址）不该被误拦
    expect(BAD.test("const p = new URL(req.url).pathname;")).toBe(false);
  });
});
