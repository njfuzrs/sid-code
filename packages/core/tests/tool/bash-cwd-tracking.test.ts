/**
 * 持久 Shell 会话 — bash cwd 追踪 + 跨工具 cwd 一致性测试
 *
 * 验证：
 * 1. bash 执行 `cd <dir>` 后写回全局 cwd 状态
 * 2. read/glob 等工具通过 normalizeToolPath 读全局 cwd，跟随 bash 的 cd
 * 3. 后台命令不写回 cwd
 * 4. cwd 指向已删除目录时回退
 */
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { BashTool } from "@sid-code/core/tool/bash.ts";
import { normalizeToolPath } from "@sid-code/core/tool/path-utils.ts";
import { getCwd, setCwd, getOriginalCwd } from "@sid-code/core/bootstrap/state.ts";

let tmpRoot: string;
let originalGlobalCwd: string;

beforeEach(() => {
  originalGlobalCwd = getCwd();
  tmpRoot = mkdtempSync(join(tmpdir(), "sid-cwd-test-"));
});

afterEach(() => {
  // 恢复全局 cwd，避免污染其它测试
  setCwd(originalGlobalCwd);
  try {
    rmSync(tmpRoot, { recursive: true, force: true });
  } catch {
    /* 忽略 */
  }
});

describe("bash cwd 追踪", () => {
  it("cd 后写回全局 cwd 状态", async () => {
    if (process.platform === "win32") return; // Windows 不追踪 cwd
    const subDir = join(tmpRoot, "sub");
    mkdirSync(subDir);

    const bash = new BashTool();
    // 从 tmpRoot 起步
    setCwd(tmpRoot);
    const result = await bash.execute({
      command: "cd sub",
      description: "进入 sub 目录",
    });
    expect(result.isError).toBeFalsy();
    // 全局 cwd 应更新为 subDir（pwd -P 解析符号链接，tmpdir 在 macOS 上是符号链接，用 endsWith 容错）
    expect(getCwd().endsWith("/sub")).toBe(true);
  });

  it("跨工具一致性：cd 后 normalizeToolPath 解析相对路径基于新 cwd", async () => {
    if (process.platform === "win32") return;
    const subDir = join(tmpRoot, "proj");
    mkdirSync(subDir);
    writeFileSync(join(subDir, "foo.ts"), "// test", "utf8");

    const bash = new BashTool();
    setCwd(tmpRoot);
    await bash.execute({ command: "cd proj", description: "进入 proj" });

    // read/glob 等工具用 normalizeToolPath("foo.ts") 解析，应基于新 cwd 指向 proj/foo.ts
    const resolved = normalizeToolPath("foo.ts");
    expect(resolved.endsWith("/proj/foo.ts")).toBe(true);
  });

  it("命令失败时不写回 cwd（pwd -P 未执行）", async () => {
    if (process.platform === "win32") return;
    const bash = new BashTool();
    setCwd(tmpRoot);
    const before = getCwd();
    // cd 到不存在目录 → 命令失败
    const result = await bash.execute({
      command: "cd /nonexistent-dir-xyz-12345",
      description: "进入不存在目录",
    });
    expect(result.isError).toBe(true);
    // cwd 不应改变
    expect(getCwd()).toBe(before);
  });

  it("显式传 cwd 参数优先于全局 cwd", async () => {
    if (process.platform === "win32") return;
    const subDir = join(tmpRoot, "explicit");
    mkdirSync(subDir);
    writeFileSync(join(subDir, "marker.txt"), "found", "utf8");

    const bash = new BashTool();
    setCwd(tmpRoot); // 全局 cwd 是 tmpRoot
    const result = await bash.execute({
      command: "cat marker.txt",
      cwd: subDir, // 显式指定
      description: "读 marker",
    });
    expect(result.isError).toBeFalsy();
    expect(result.output).toContain("found");
  });
});

describe("cwd 删除回退", () => {
  it("全局 cwd 指向已删除目录时回退到原始启动目录", async () => {
    if (process.platform === "win32") return;
    const doomed = join(tmpRoot, "doomed");
    mkdirSync(doomed);
    setCwd(doomed);
    rmSync(doomed, { recursive: true, force: true }); // 删除当前 cwd

    const bash = new BashTool();
    // resolveCwd 应检测到 doomed 不存在，回退到 getOriginalCwd()
    const result = await bash.execute({
      command: "pwd",
      description: "打印当前目录",
    });
    // 不应因 cwd 不存在而崩溃
    expect(result.isError).toBeFalsy();
    expect(result.output).toContain(getOriginalCwd());
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 删掉自己站着的目录（2026-08-27，从 SWE-bench 轨迹挖出的真实产品缺陷）
// ═══════════════════════════════════════════════════════════════════════════
//
// 原始形态（smoke-10 pytest-7982 的 agent.log）：
//
//   [TOOL] ▶ bash {"description":"清理临时测试目录","command":"rm -rf /tmp/symlink_test"}
//   [TOOL] ✗ bash (54ms)
//   命令执行失败（退出码 1）:
//   pwd: error retrieving current directory: getcwd: cannot access parent directories
//
// `rm -rf` 是成功的，失败的是 cwd 追踪那个收尾 `pwd -P`（cwd 已不存在）。
// 旧实现用 `&&` 拼，整条退出码取最后一段 → **成功的操作被报成失败**。
//
// ## ⚠️ 这个缺陷只在 bash 下复现，zsh 下隐身
//
// 实测差异在 `pwd -P` 拿 cwd 的方式：
//   zsh  → 用缓存的 $PWD，cwd 被删也 exit 0   ← macOS 开发机默认 shell
//   bash → 真去 getcwd()，cwd 被删则 exit 1   ← 容器/CI 里的 shell，缺陷在这
// 且必须有 `eval` 包裹（有 shell 快照时才有）—— `eval` 触发二次解析，
// 让 bash 真的去 getcwd() 而不吃 $PWD 缓存。
//
// 而 `getPlatformShell` 取 `process.env.SHELL || "/bin/bash"`，所以
// **这组测试必须自己把 SHELL 钉成 bash**。第一版没钉，结果变异自证时
// "退回旧实现仍然全绿" —— 一条只在特定 shell 下才有意义的断言，
// 不锁那个 shell 就等于没写。
describe("删掉自己站着的目录（强制 bash：zsh 下此缺陷隐身）", () => {
  let savedShell: string | undefined;

  beforeEach(() => {
    savedShell = process.env.SHELL;
    process.env.SHELL = "/bin/bash";
  });

  afterEach(() => {
    if (savedShell === undefined) delete process.env.SHELL;
    else process.env.SHELL = savedShell;
  });

  it("命令必须报成功，不能被收尾的 pwd 污染成失败", async () => {
    if (process.platform === "win32") return;
    const doomed = join(tmpRoot, "self-delete");
    mkdirSync(doomed);
    const bash = new BashTool();
    const cdResult = await bash.execute({ command: `cd ${doomed}` });
    expect(cdResult.isError).toBeFalsy();
    // pwd -P 解析符号链接（macOS tmpdir 是 /private/var 的软链），用 endsWith 容错
    // —— 同本文件既有断言的规矩
    expect(getCwd().endsWith("/self-delete")).toBe(true);

    const rmResult = await bash.execute({ command: `rm -rf ${doomed}` });
    // 核心断言：删掉自己站的目录后，命令必须报成功
    expect(rmResult.isError).toBeFalsy();
    // 且操作真的生效（不是"报成功但没删"）
    expect(existsSync(doomed)).toBe(false);
    // 并且必须告知 cwd 已失效 —— 否则两套 cwd 状态会静默发散（见下一条）
    expect(String(rmResult.output)).toContain("[工作目录已失效]");
  });

  it("失效告知必须说清「两套状态发散」，而不是「后续命令会失败」", async () => {
    if (process.platform === "win32") return;
    // ⚠️ 这条锁的是**文案的事实正确性**，不是文案好不好看。
    // 实测：cwd 被删后 bash 经 resolveCwd 局部回退到启动目录（命令照样跑通），
    // 而 read/edit/grep 经 normalizeToolPath(getCwd()) 仍指向已删除的路径。
    // 我最初写的「后续任何命令都会失败」是错的 —— 那会让模型以为
    // 不跑命令就没事，而真正的风险是**文件类工具静默读写到错误位置**。
    const doomed = join(tmpRoot, "stale-notice");
    mkdirSync(doomed);
    const bash = new BashTool();
    await bash.execute({ command: `cd ${doomed}` });
    const r = await bash.execute({ command: `rm -rf ${doomed}` });

    const out = String(r.output);
    expect(out).toContain("[工作目录已失效]");
    // 必须点破发散：两边基准不一致
    expect(out).toContain("read/edit/grep");
    // 必须给出可执行的下一步（否则模型会原地重试同一条命令）
    expect(out).toContain("cd");
    // ⛔ 不许再声称"后续任何命令都会失败" —— 实测不成立
    expect(out).not.toContain("后续任何命令都会失败");

    // 实证「命令照样跑通」这一半，防止将来有人照错文案改回去
    const next = await bash.execute({ command: "echo still-works" });
    expect(next.isError).toBeFalsy();
    expect(String(next.output)).toContain("still-works");
  });

  it("cwd 健在时不许出现失效告知（防误报）", async () => {
    if (process.platform === "win32") return;
    const alive = join(tmpRoot, "alive");
    mkdirSync(alive);
    const bash = new BashTool();
    await bash.execute({ command: `cd ${alive}` });
    const ok = await bash.execute({ command: "echo hi" });
    expect(String(ok.output)).not.toContain("[工作目录已失效]");
    // 失败命令 —— cwd 健在时同样不该报失效
    const bad = await bash.execute({ command: "exit 3" });
    expect(bad.isError).toBeTruthy();
    expect(String(bad.output)).not.toContain("[工作目录已失效]");
  });

  it("用户命令的真失败不许被 cwd 追踪吞掉", async () => {
    if (process.platform === "win32") return;
    // ⛔ 一个诱人但错误的修法：给收尾的 pwd 接 `|| true`。
    // 实测 `false && { pwd; } || true` → exit 0 —— 它把**用户命令的真失败
    // 也吞成成功**，比原 bug 更坏（失败报成成功）。
    // 正确修法是先把退出码存进 __sc_rc，跑完 pwd 再用它退出。
    const alive = join(tmpRoot, "rc-preserved");
    mkdirSync(alive);
    const bash = new BashTool();
    await bash.execute({ command: `cd ${alive}` });
    const r = await bash.execute({ command: "exit 42" });
    expect(r.isError).toBeTruthy();
  });
});
