/**
 * IDE 发现层的两条缺口回归测试：
 *   1. 多个窗口工作区重叠时的 PID 祖先消歧
 *   2. lockfile 全无时的「IDE 进程在跑但扩展没装」检测
 *
 * 两条的共同风险是**误伤**：消歧滤错一个候选，IDE 明明开着却发现不了；
 * 进程检测报错一个 IDE，用户会被引导去装一个装不上的扩展。
 * 所以每个用例都先给「不该过滤 / 不该误报」的反例，再给正确行为。
 *
 * 进程表全部注入，不碰真实 ps：测试环境的进程树既不稳定也不可复现。
 *
 * ⚠️ lockfile 的 PID 必须是**真实活着的进程**。cleanupStaleLockfiles 会把
 * 「PID 不存在」的 lockfile 当过期文件删掉 —— 这是对的，但它意味着测试里
 * 写一个虚构 PID 的 lockfile 会在 detectIDEs 入口处消失，用例测到的就不是消歧
 * 而是清理。所以这里统一用当前进程的 PID（一定活着），
 * 「这个 PID 算不算我们的祖先」由注入的祖先链决定，不由真实进程树决定。
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { createServer, type Server } from "net";
import { execFileSync } from "child_process";

import { detectIDEs } from "@sid-code/core/ide/detect.ts";
import { sidPaths } from "@sid-code/core/config/paths.ts";
import {
  ancestorPidsFrom,
  detectRunningIDEs,
  parseProcessTable,
  runningIDEsFrom,
  type ProcessRecord,
} from "@sid-code/core/ide/process-tree.ts";

const WORKSPACE = "/repo/app";

/** 当前进程一定活着，用它当 lockfile PID 才不会被 cleanupStaleLockfiles 清掉 */
const LIVE_PID = process.pid;

describe("祖先链回溯", () => {
  /** init(1) → IDE(100) → shell(200) → 我们(300)，外加一个无关窗口(400) */
  const records = parseProcessTable(
    [
      "    1     0 /sbin/launchd",
      "  100     1 /Applications/Cursor.app/Contents/MacOS/Cursor",
      "  200   100 /bin/zsh",
      "  300   200 sid-code",
      "  400     1 /Applications/Visual Studio Code.app/Contents/MacOS/Code",
    ].join("\n"),
  );

  test("ps 输出的不定空格与带空格的命令行都能解析", () => {
    expect(records).toContainEqual({
      pid: 100,
      ppid: 1,
      command: "/Applications/Cursor.app/Contents/MacOS/Cursor",
    });
    expect(records).toHaveLength(5);
  });

  test("从我们的父进程回溯，含 IDE 本体、不含 init", () => {
    const ancestors = ancestorPidsFrom(records, 200);
    expect(ancestors.has(100)).toBe(true);
    expect(ancestors.has(1)).toBe(false);
    expect(ancestors.has(400)).toBe(false);
  });

  test("遇到环停下来，不无限转", () => {
    const cyclic: ProcessRecord[] = [
      { pid: 2, ppid: 3, command: "a" },
      { pid: 3, ppid: 2, command: "b" },
    ];
    expect(ancestorPidsFrom(cyclic, 2).size).toBe(2);
  });

  test("解析不出的行被跳过，而不是抛异常", () => {
    expect(parseProcessTable("not a process line\n")).toEqual([]);
  });
});

describe("PID 祖先消歧（detectIDEs）", () => {
  let dir: string;
  let savedConfigDir: string | undefined;
  let savedTerm: string | undefined;
  const servers: Server[] = [];

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "ide-discovery-"));
    savedConfigDir = process.env.SID_CONFIG_DIR;
    process.env.SID_CONFIG_DIR = dir;
    savedTerm = process.env.TERM_PROGRAM;
  });

  afterEach(async () => {
    if (savedConfigDir === undefined) delete process.env.SID_CONFIG_DIR;
    else process.env.SID_CONFIG_DIR = savedConfigDir;
    if (savedTerm === undefined) delete process.env.TERM_PROGRAM;
    else process.env.TERM_PROGRAM = savedTerm;
    delete process.env.SID_CODE_SSE_PORT;
    await Promise.all(servers.splice(0).map((s) => new Promise((r) => s.close(r))));
    rmSync(dir, { recursive: true, force: true });
  });

  /** 占一个真实端口：cleanupStaleLockfiles 还会探端口，没人听的端口一样会被清掉 */
  async function livePort(): Promise<number> {
    const server = createServer();
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as { port: number }).port;
    servers.push(server);
    return port;
  }

  /**
   * 一个真实活着、但与本测试进程无关的 PID。
   * lockfile 的 PID 必须活着（否则被 cleanupStaleLockfiles 当过期文件删掉），
   * 同时又不能是我们自己或我们的父进程（否则它天然落在祖先链上，测不出「被滤掉」）。
   */
  function foreignPid(): number {
    const out = execFileSync("ps", ["-ax", "-o", "pid=,ppid="], { encoding: "utf-8" });
    for (const line of out.split("\n")) {
      const [pid, ppid] = line.trim().split(/\s+/).map(Number);
      if (!pid || !ppid) continue;
      if (pid === process.pid || pid === process.ppid) continue;
      // 只要 launchd 的直接子进程：它们是长期驻留的系统进程，测试期间不会退出。
      // 取一个短命进程的话，它在写入和检测之间死掉，lockfile 会被 cleanupStaleLockfiles
      // 当过期文件删掉，用例测到的就是清理而不是消歧。
      if (ppid !== 1) continue;
      return pid;
    }
    throw new Error("找不到与测试进程无关的活进程，消歧用例无法构造");
  }

  async function writeLock(port: number, pid: number, name: string): Promise<void> {
    const lockDir = sidPaths.ideLockDir();
    mkdirSync(lockDir, { recursive: true });
    writeFileSync(
      join(lockDir, `${port}.lock`),
      JSON.stringify({ workspaceFolders: [WORKSPACE], pid, ideName: name }),
    );
  }

  test("外部终端：两个窗口都保留（祖先链不可能命中，过滤会让发现整体失灵）", async () => {
    delete process.env.TERM_PROGRAM;
    const [a, b] = [await livePort(), await livePort()];
    await writeLock(a, LIVE_PID, "窗口A");
    await writeLock(b, LIVE_PID, "窗口B");

    const found = await detectIDEs(WORKSPACE, { ancestorPids: new Set([LIVE_PID]) });
    expect(found.map((i) => i.port).sort()).toEqual([a, b].sort());
  });

  test("IDE 内置终端：只留祖先链上那个窗口，另一个被滤掉", async () => {
    process.env.TERM_PROGRAM = "cursor";
    const [ours, other] = [await livePort(), await livePort()];
    await writeLock(ours, LIVE_PID, "本窗口");
    await writeLock(other, foreignPid(), "另一个窗口");

    const found = await detectIDEs(WORKSPACE, { ancestorPids: new Set([LIVE_PID]) });
    expect(found.map((i) => i.port)).toEqual([ours]);
    expect(found[0]!.pid).toBe(LIVE_PID);
  });

  test("反例：祖先链查询失败时一个都不滤（滤掉的代价是 IDE 明明开着却发现不了）", async () => {
    process.env.TERM_PROGRAM = "vscode";
    const [a, b] = [await livePort(), await livePort()];
    await writeLock(a, LIVE_PID, "A");
    await writeLock(b, foreignPid(), "B");

    // { ok: false } 才是「查不到」。ancestorPids: new Set() 是另一回事：
    // 那表示查询成功但链是空的，会把两个候选都滤掉（见下一条用例）。
    const found = await detectIDEs(WORKSPACE, { ancestorLookup: { ok: false } });
    expect(found).toHaveLength(2);
  });

  test("对照：查询成功但链是空的，IDE 终端里的候选全部被滤掉", async () => {
    process.env.TERM_PROGRAM = "vscode";
    const [a, b] = [await livePort(), await livePort()];
    await writeLock(a, LIVE_PID, "A");
    await writeLock(b, foreignPid(), "B");

    const found = await detectIDEs(WORKSPACE, { ancestorPids: new Set() });
    expect(found).toHaveLength(0);
  });

  test("环境变量指定端口：即使不在祖先链上也保留（用户显式指定优先于消歧）", async () => {
    process.env.TERM_PROGRAM = "vscode";
    const port = await livePort();
    await writeLock(port, foreignPid(), "被指定的窗口");
    process.env.SID_CODE_SSE_PORT = String(port);

    const found = await detectIDEs(WORKSPACE, { ancestorPids: new Set([LIVE_PID]) });
    expect(found.map((i) => i.port)).toEqual([port]);
  });

  test("工作区不匹配的 lockfile 不会触发进程查询（查询是懒的）", async () => {
    process.env.TERM_PROGRAM = "vscode";
    const port = await livePort();
    await writeLock(port, LIVE_PID, "别的工作区");

    let queried = false;
    const found = await detectIDEs("/somewhere/else", {
      processTable: async () => {
        queried = true;
        return "";
      },
    });
    expect(found).toHaveLength(0);
    expect(queried).toBe(false);
  });

  test("祖先链含直接父进程时认它，且注入了祖先链就不再查进程表", async () => {
    process.env.TERM_PROGRAM = "windsurf";
    const port = await livePort();
    await writeLock(port, process.ppid, "父进程就是它");

    let queried = false;
    const found = await detectIDEs(WORKSPACE, {
      ancestorPids: new Set([process.ppid]),
      processTable: async () => {
        queried = true;
        return "";
      },
    });
    expect(found.map((i) => i.port)).toEqual([port]);
    expect(queried).toBe(false);
  });
});

describe("运行中 IDE 检测", () => {
  test("Cursor 的 Helper 进程命中 cursor", async () => {
    const stdout = "  100     1 Cursor Helper (Plugin): extension-host\n";
    expect(await detectRunningIDEs(async () => stdout)).toEqual(["cursor"]);
  });

  test("反例：Cursor 不被误报成 vscode（两者命令行都含 Code）", () => {
    const records = parseProcessTable(
      "  100     1 /Applications/Cursor.app/Contents/MacOS/Cursor\n" +
        "  101   100 Cursor Helper: shared-process\n",
    );
    expect(runningIDEsFrom(records)).toEqual(["cursor"]);
    expect(runningIDEsFrom(records)).not.toContain("vscode");
  });

  test("只有 VS Code 时报告 vscode", () => {
    const records = parseProcessTable("  100     1 Code Helper (Plugin): extension-host\n");
    expect(runningIDEsFrom(records)).toEqual(["vscode"]);
  });

  test("两个 IDE 同时开着时都报告（除了被 cursor 掩盖的 vscode）", () => {
    const records = parseProcessTable(
      "  100     1 Cursor Helper (Plugin)\n  200     1 Windsurf Helper\n",
    );
    expect(runningIDEsFrom(records).sort()).toEqual(["cursor", "windsurf"]);
  });

  test("查询失败返回空数组，而不是抛异常（提示文案必须能退回通用版）", async () => {
    expect(
      await detectRunningIDEs(async () => {
        throw new Error("ps: not found");
      }),
    ).toEqual([]);
  });
});
