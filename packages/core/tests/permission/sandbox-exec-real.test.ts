/**
 * B2：真跑 `sandbox-exec` 的端到端测试（2026-11-05）。
 *
 * ## 为什么必须是这个文件
 *
 * 原有的 `p2-wiring-and-sandbox.test.ts` **只断言 profile 字符串**，从未真跑过
 * sandbox-exec —— 于是三处致命缺陷同时存在而测试全绿：
 *
 * - D1 网络行写成 `(remote ip "127.0.0.1:*")`，sandbox-exec 直接 exit 65，命令一行不跑；
 * - D2 `(deny default)` 下只放行几个 `/usr/*`，dyld 起不来，`/bin/echo hi` 都 SIGABRT（134）；
 * - D3 内层写死 `/bin/sh -c`，zsh 快照 source 失败是致命错误，用户命令不执行。
 *
 * 所以这里每一条用例都**真的 spawn 一个进程**，断言的是退出码与输出，不是 profile 文本。
 *
 * ## 约定
 *
 * - 只在 darwin 上跑（`describe.skipIf`）：CI 的 `macos-latest` 分片会真跑到，
 *   其它平台整组 skip 而不是静默通过（bun 会把 skip 计入 skip 数）。
 * - 每个用例自己的 tmpdir 做 cwd，`SID_CONFIG_DIR` 指另一个 tmpdir
 *   （测试落盘隔离约定：存/恢复原值，不无条件 delete）。
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
  existsSync,
} from "fs";
import { homedir, tmpdir } from "os";
import { join } from "path";
import { SandboxManager, defaultSandboxConfig } from "../../src/permission/sandbox.ts";
import { BashTool } from "../../src/tool/bash.ts";
import { setCwd, getCwd } from "../../src/bootstrap/state.ts";

const isDarwin = process.platform === "darwin";
const SHELL = "/bin/zsh";

let cwd: string;
let sidHome: string;
let prevSidConfigDir: string | undefined;
/** A4 用：home 下的探针目录（不在写白名单里），用例自己清 */
let homeProbe: string;

beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), "sbx-real-cwd-"));
  sidHome = mkdtempSync(join(tmpdir(), "sbx-real-home-"));
  homeProbe = join(homedir(), `.sid-sbx-probe-${process.pid}-${Date.now()}`);
  prevSidConfigDir = process.env.SID_CONFIG_DIR;
  process.env.SID_CONFIG_DIR = sidHome;
});

afterEach(() => {
  if (prevSidConfigDir === undefined) delete process.env.SID_CONFIG_DIR;
  else process.env.SID_CONFIG_DIR = prevSidConfigDir;
  rmSync(cwd, { recursive: true, force: true });
  rmSync(sidHome, { recursive: true, force: true });
  rmSync(homeProbe, { recursive: true, force: true });
});

/** 造一个启用中的 manager（默认 network: localhost）。 */
function manager(opts?: { network?: "localhost" | "all" | "none"; workspace?: string }) {
  return new SandboxManager(
    {
      ...defaultSandboxConfig(),
      enabled: true,
      ...(opts?.network ? { network: opts.network } : {}),
    },
    opts?.workspace ?? cwd,
  );
}

/** 真的跑一条沙箱内命令：外层 shell 与内层 shell 都用 $SHELL（这里固定 zsh）。 */
function runInSandbox(
  sb: SandboxManager,
  command: string,
  opts?: { cwd?: string },
): { exitCode: number; stdout: string; stderr: string } {
  const wrapped = sb.wrapCommand(command, SHELL);
  const r = Bun.spawnSync([SHELL, "-c", wrapped], {
    cwd: opts?.cwd ?? cwd,
    stdout: "pipe",
    stderr: "pipe",
  });
  return {
    exitCode: r.exitCode ?? -1,
    stdout: r.stdout.toString(),
    stderr: r.stderr.toString(),
  };
}

/**
 * 异步版本：**跑本机 server 的用例必须用它**。
 *
 * `Bun.spawnSync` 会阻塞事件循环，同一进程里的 `Bun.serve` 收不到请求，
 * curl 只能一直等到 `-m` 超时（实测 A8 以 5003ms 超时失败，看起来像沙箱拦截，
 * 其实是测试自己把 server 饿死了）。
 */
async function runInSandboxAsync(
  sb: SandboxManager,
  command: string,
  opts?: { cwd?: string },
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const wrapped = sb.wrapCommand(command, SHELL);
  const proc = Bun.spawn([SHELL, "-c", wrapped], {
    cwd: opts?.cwd ?? cwd,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { exitCode, stdout, stderr };
}

describe.skipIf(!isDarwin)("B2 端到端：真跑 sandbox-exec", () => {
  // ── A1 基础执行 ────────────────────────────────────────────────
  test("A1 基础执行：echo hi → exit 0 且 stdout=hi", () => {
    const r = runInSandbox(manager(), "echo hi");
    expect({ code: r.exitCode, out: r.stdout.trim(), err: r.stderr }).toEqual({
      code: 0,
      out: "hi",
      err: "",
    });
  });

  // ── A2 常用工具链 ──────────────────────────────────────────────
  test("A2 常用工具：ls / && git --version && /usr/bin/env true 全都能跑", () => {
    const r = runInSandbox(
      manager(),
      "ls / >/dev/null && git --version >/dev/null && /usr/bin/env true",
    );
    expect({ code: r.exitCode, err: r.stderr }).toEqual({ code: 0, err: "" });
  });

  /**
   * 私有源的凭据在 `~/.npmrc`。它**刻意没有**进 deny 列表（见 sandbox.ts 的
   * SENSITIVE_HOME_DIRS 注释）：deny 掉会让沙箱里的 `npm install` 直接不可用。
   * 这条用例是那个决定的看门狗 —— 谁把 `.npmrc` 加进 deny，这里会红。
   */
  test("A2b ~/.npmrc 可读（私有源不该因沙箱失效）", () => {
    const npmrc = join(homedir(), ".npmrc");
    if (!existsSync(npmrc)) return; // 没装 npm/没配私有源的机器跳过
    const r = runInSandbox(manager(), `cat ${npmrc} >/dev/null`);
    expect({ code: r.exitCode, err: r.stderr }).toEqual({ code: 0, err: "" });
  });

  // ── A3 工作区可写 ──────────────────────────────────────────────
  test("A3 工作区可写：在 cwd 写文件再读回", () => {
    const r = runInSandbox(manager(), "echo x > f && cat f");
    expect(r.exitCode).toBe(0);
    expect(r.stdout.trim()).toBe("x");
  });

  // ── A4 工作区外不可写 ──────────────────────────────────────────
  test("A4 工作区外不可写：$HOME 下的路径被拒且文件不存在", () => {
    mkdirSync(homeProbe, { recursive: true });
    const target = join(homeProbe, "outside");
    const r = runInSandbox(manager(), `echo x > ${target}`);
    expect(r.exitCode).not.toBe(0);
    expect(r.stderr).toMatch(/Operation not permitted/i);
    expect(existsSync(target)).toBe(false);
  });

  // ── A5 敏感目录不可读 ──────────────────────────────────────────
  test("A5 敏感目录不可读：sid home 下的文件被拒", () => {
    const secret = join(sidHome, "secret.txt");
    writeFileSync(secret, "top-secret", "utf8");
    const r = runInSandbox(manager(), `cat ${secret}`);
    expect(r.exitCode).not.toBe(0);
    expect(r.stderr).toMatch(/Operation not permitted/i);
    expect(r.stdout).not.toContain("top-secret");
  });

  // ── A6 快照可读（D3） ─────────────────────────────────────────
  test("A6 快照可 source：literal 放行快照，同目录其它文件仍被拒", () => {
    const snapshotDir = join(sidHome, "shell-snapshots");
    mkdirSync(snapshotDir, { recursive: true });
    const snapshot = join(snapshotDir, "snapshot-zsh-test.sh");
    writeFileSync(snapshot, "export SBX_SNAPSHOT_RAN=1\n", "utf8");
    const sibling = join(snapshotDir, "settings.json");
    writeFileSync(sibling, '{"secret":1}', "utf8");

    const sb = manager();
    sb.setSnapshotPath(snapshot);

    // 快照能 source 且变量生效
    const ok = runInSandbox(sb, `source ${snapshot} && echo "ran:$SBX_SNAPSHOT_RAN"`);
    expect({ code: ok.exitCode, out: ok.stdout.trim() }).toEqual({ code: 0, out: "ran:1" });

    // 同目录的另一个文件仍被 sid home 的 deny 挡住
    const denied = runInSandbox(sb, `cat ${sibling}`);
    expect(denied.exitCode).not.toBe(0);
    expect(denied.stderr).toMatch(/Operation not permitted/i);
  });

  /**
   * D3 的**直接**回归：内层 shell 必须跟随外层。
   *
   * 修前 `wrapCommand` 写死 `/bin/sh -c`：快照（zsh 语法 + sid home 被 deny）
   * 在 POSIX mode 下 source 失败是特殊内建致命错误，`|| true` 救不回来，
   * 命令直接退出（实测 exit 1/2 且无输出）。这条用例同时覆盖两个自变量：
   * 内层 shell 正确 = zsh；快照可读 = setSnapshotPath 生效。
   */
  test("A6b 内层 shell 跟随外层：zsh 快照 + zsh 内层能跑完并保留退出码", () => {
    const snapshot = join(sidHome, "snapshot.sh");
    writeFileSync(snapshot, "# zsh 风格快照\nalias sbx-alias='echo alias-ok'\n", "utf8");
    const sb = manager();
    sb.setSnapshotPath(snapshot);
    const r = runInSandbox(sb, `source ${snapshot} && eval 'echo ok'`);
    expect({ code: r.exitCode, out: r.stdout.trim() }).toEqual({ code: 0, out: "ok" });
  });

  /**
   * D3 的**直接**回归：内层 shell 必须跟随外层。
   *
   * 修前 `wrapCommand` 写死 `/bin/sh -c`。判据不能用「快照可读」那种场景 ——
   * A6 给快照加了 literal 放行，`/bin/sh` 读到它照样能跑（所以 M3 变异会逃逸）。
   * 这里刻意**不创建**快照文件：`source` 一个不存在的文件在 POSIX mode 下是
   * **特殊内建致命错误**，`|| true` 救不回来（2026-11-05 实测：sh → exit 1 且无输出；
   * zsh → 打印 ok、exit 0）。于是这条用例在「内层是 zsh」时绿、「内层是 sh」时红。
   */
  test("A6c 内层 shell 必须是 zsh：快照不可读时 sh 会吞掉命令，zsh 能继续", () => {
    const missing = join(sidHome, "missing-snapshot.sh");
    // 不 setSnapshotPath、不创建文件：模拟「快照丢了 / 落在 deny 区」
    const r = runInSandbox(manager(), `source ${missing} 2>/dev/null || true && echo ok`);
    expect({ code: r.exitCode, out: r.stdout.trim() }).toEqual({ code: 0, out: "ok" });
  });

  // ── A7 realpath ───────────────────────────────────────────────
  /**
   * 为什么单独测 realpath：Seatbelt 按**真实路径**匹配。workspace 给的是符号链接
   * （macOS 上 `/tmp`→`/private/tmp`），不做 realpath 就会把规则写成别名路径，
   * 实际写入的真实路径匹配不上 → 明明在 cwd 里却被拒。
   *
   * 这里刻意让真实目录落在 `$HOME` 下（不在 `/private/tmp` 的写白名单里），
   * 再用 `/tmp` 下的符号链接当 workspace —— 只有这样「做了 realpath」才是唯一能过的方式。
   */
  test("A7 /tmp 软链：用别名路径构造 manager，在 cwd 写文件仍成功", () => {
    const real = join(homeProbe, "ws");
    mkdirSync(real, { recursive: true });
    const alias = `/tmp/sbx-alias-${process.pid}-${Date.now()}`;
    symlinkSync(real, alias);

    try {
      const sb = manager({ workspace: alias });
      // profile 里必须是 realpath（alias 会被解析成 $HOME 下的真实路径）
      expect(sb.generateSeatbeltProfile()).toContain(real);
      expect(sb.generateSeatbeltProfile()).not.toContain(alias);

      const r = runInSandbox(sb, "echo y > g && cat g", { cwd: alias });
      expect({ code: r.exitCode, out: r.stdout.trim() }).toEqual({ code: 0, out: "y" });
    } finally {
      rmSync(alias, { force: true });
    }
  });

  // ── A8/A10 网络档位 ────────────────────────────────────────────
  test("A8 localhost 档：本机服务可访问", async () => {
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: () => new Response("sbx-ok"),
    });
    try {
      const r = await runInSandboxAsync(
        manager(),
        `curl --noproxy '*' -sS -m 5 http://localhost:${server.port}/`,
      );
      expect({ code: r.exitCode, out: r.stdout }).toEqual({ code: 0, out: "sbx-ok" });
    } finally {
      server.stop(true);
    }
  });

  test("A10 none 档：同一本机服务被拒", async () => {
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: () => new Response("sbx-ok"),
    });
    try {
      const r = await runInSandboxAsync(
        manager({ network: "none" }),
        `curl --noproxy '*' -sS -m 5 http://localhost:${server.port}/`,
      );
      expect(r.exitCode).not.toBe(0);
      expect(r.stdout).not.toContain("sbx-ok");
    } finally {
      server.stop(true);
    }
  });

  /**
   * A9 外网被拒。
   *
   * 判据取 curl 的 **exit 7**（Connection refused / 无路由），不取「能不能连通」：
   * 沙箱拒绝是 0ms 内失败，与外网是否可达无关。为防 CI runner 本来就没网导致
   * 「假通过」，先跑一次 `network: "all"` 对照——只有对照**不是** exit 7 才断言，
   * 否则打印原因并跳过（文档 §5.2 A9 的写法）。
   */
  test("A9 localhost 档：直连外网被拒（有可达性对照）", () => {
    const cmd = "curl --noproxy '*' -sS -m 3 http://1.1.1.1/ >/dev/null";
    const control = runInSandbox(manager({ network: "all" }), cmd);
    if (control.exitCode === 7) {
      // 这台机器本身连不出去：无法区分「沙箱拒」与「本来就不通」，跳过而不是假绿
      console.log("[A9] 对照组 network=all 也是 exit 7（机器无外网），本条跳过");
      return;
    }
    const r = runInSandbox(manager(), cmd);
    expect(r.exitCode).toBe(7);
  });

  // ── A11 子进程继承 ────────────────────────────────────────────
  test("A11 子进程继承：/bin/sh -c 里再 cat 敏感文件仍被拒", () => {
    const secret = join(sidHome, "nested-secret.txt");
    writeFileSync(secret, "nested", "utf8");
    const r = runInSandbox(manager(), `/bin/sh -c 'cat ${secret}'`);
    expect(r.exitCode).not.toBe(0);
    expect(r.stderr).toMatch(/Operation not permitted/i);
  });

  // ── A12 cwd 追踪仍工作（走 BashTool 真实入口） ─────────────────
  /**
   * 为什么必须走 BashTool 而不是直接 wrapCommand：
   * 直接包命令只验证「沙箱能跑」，验证不到 **BashTool 自己拼进命令字符串的那两段**
   * —— `source <快照>` 与收尾的 `pwd -P >| <cwdFile>`。后者写的是
   * `ensureSidTempDir()` 下的文件，若写白名单漏了 tmpdir，`pwd` 会静默失败、
   * 表现为「cd 了但全局 cwd 不动」，而所有直接包命令的用例依然全绿。
   */
  test("A12 cwd 追踪：走 BashTool 执行 cd sub，全局 cwd 切换成功", async () => {
    mkdirSync(join(cwd, "sub"), { recursive: true });
    const bash = new BashTool();
    bash.setSandboxManager(manager());
    setCwd(cwd);

    const r = await bash.execute({ command: "cd sub && pwd", description: "进入 sub" });
    expect(r.isError).toBeFalsy();
    expect(getCwd().endsWith("/sub")).toBe(true);
  });

  // ── A13 后台任务（走 BashTool + Task 系统） ────────────────────
  test("A13 后台任务：run_in_background 的 echo bg 能跑到输出文件里", async () => {
    const bash = new BashTool();
    bash.setSandboxManager(manager());
    setCwd(cwd);

    const r = await bash.execute({
      command: "echo bg",
      description: "后台回显",
      run_in_background: true,
    });
    expect(r.isError).toBeFalsy();
    const payload = JSON.parse(r.output) as { task_id: string; output_file: string };
    expect(payload.task_id).toBeTruthy();

    // 轮询输出文件（任务系统异步写盘），最多等 5s
    let seen = "";
    for (let i = 0; i < 100; i++) {
      try {
        seen = readFileSync(payload.output_file, "utf8");
      } catch {
        /* 文件还没建出来 */
      }
      if (seen.includes("bg")) break;
      await new Promise((res) => setTimeout(res, 50));
    }
    expect(seen).toContain("bg");
  });
});
