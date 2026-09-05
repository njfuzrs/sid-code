/**
 * IDE 层健壮性缺口回归测试（D3 / D5 / D6 / D7 / D8）
 *
 * 这五条的共同形态是「**静默的边界失配**」：两个系统在边界上对不齐，
 * 而边界本身不会报错 —— method 名失配、参数名失配、Unicode 编码失配、
 * 字段没有消费方。全部是"看起来一切正常，功能就是不工作"。
 *
 * 所以每个用例都刻意先断言**"修复前会怎样"的那个反例**，
 * 再断言修复后的正确行为 —— 否则用例会退化成"跟着实现走"的同义反复。
 */

import { describe, test, expect, afterEach, beforeEach } from "bun:test";
import { createServer, type Server } from "net";
import { mkdtempSync, writeFileSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

import { isSubPath, lockfileToDetectedIDE } from "@sid-code/core/ide/detect.ts";
import { isPortListening, cleanupStaleLockfiles } from "@sid-code/core/ide/lockfile.ts";
import { parseDiffResponse } from "@sid-code/core/ide/diff.ts";
import { DIFF_STATUS } from "@sid-code/core/ide/protocol.ts";
import {
  resolveIDEHost,
  windowsPathToWSL,
  wslPathToWindows,
  isRunningInWSL,
  _resetWSLCacheForTesting,
} from "@sid-code/core/ide/wsl.ts";

// ───────────────────────── D6 · NFC 归一化 ─────────────────────────

describe("D6 · isSubPath 的 Unicode 归一化", () => {
  // café：NFC 是 4 个码位（é 是单码位 U+00E9），NFD 是 5 个（e + U+0301）。
  // macOS 文件系统给 NFD，VS Code 报 NFC —— 两个字符串肉眼完全一样。
  const NFC = "/Users/me/caf\u00E9/src";
  const NFD = "/Users/me/cafe\u0301/src";

  test("前提：这两个字符串确实肉眼相同但字节不同（否则本用例没意义）", () => {
    expect(NFC).not.toBe(NFD);
    expect(NFC.normalize("NFC")).toBe(NFD.normalize("NFC"));
  });

  test("NFD 的 cwd 能匹配 NFC 的工作区（修复前必然 false）", () => {
    expect(isSubPath(NFD, NFC)).toBe(true);
    expect(isSubPath(NFC, NFD)).toBe(true);
  });

  test("NFD 子目录匹配 NFC 父目录", () => {
    expect(isSubPath(NFD + "/tool/edit.ts", NFC)).toBe(true);
  });

  test("归一化没有放宽真实的非子路径判断", () => {
    expect(isSubPath("/a/bc", "/a/b")).toBe(false);
    expect(isSubPath("/x/y", NFC)).toBe(false);
  });
});

// ───────────────────────── D7 · 端口探活 ─────────────────────────

describe("D7 · lockfile 端口探活", () => {
  let server: Server | undefined;

  afterEach(async () => {
    if (server) {
      await new Promise<void>((r) => server!.close(() => r()));
      server = undefined;
    }
  });

  test("有人监听时返回 true", async () => {
    server = createServer();
    const port: number = await new Promise((resolve) => {
      server!.listen(0, "127.0.0.1", () => {
        resolve((server!.address() as { port: number }).port);
      });
    });
    expect(await isPortListening(port)).toBe(true);
  });

  test("没人监听时返回 false（这正是 PID 判据看不见的那种状态）", async () => {
    // 先占一个端口拿到号，再关掉 —— 得到一个"确定没人听"的端口号
    const s = createServer();
    const port: number = await new Promise((resolve) => {
      s.listen(0, "127.0.0.1", () => resolve((s.address() as { port: number }).port));
    });
    await new Promise<void>((r) => s.close(() => r()));

    expect(await isPortListening(port)).toBe(false);
  });

  test("cleanupStaleLockfiles 会删掉「PID 活着但端口已死」的 lockfile", async () => {
    // 隔离：把 lockfile 目录指到 tmpdir，绝不碰真实的 ~/.sid-code/
    const dir = mkdtempSync(join(tmpdir(), "sid-ide-lock-"));
    const prevHome = process.env.SID_CONFIG_DIR;
    process.env.SID_CONFIG_DIR = dir;

    try {
      const { sidPaths } = await import("@sid-code/core/config/paths.ts");
      const lockDir = sidPaths.ideLockDir();
      const { mkdirSync, existsSync } = await import("fs");
      mkdirSync(lockDir, { recursive: true });

      // 取一个确定没人监听的端口
      const s = createServer();
      const deadPort: number = await new Promise((resolve) => {
        s.listen(0, "127.0.0.1", () => resolve((s.address() as { port: number }).port));
      });
      await new Promise<void>((r) => s.close(() => r()));

      const lockPath = join(lockDir, `${deadPort}.lock`);
      // pid 用当前进程 —— 它**一定活着**，所以旧的 PID 判据清不掉这个文件
      writeFileSync(
        lockPath,
        JSON.stringify({ pid: process.pid, ideName: "Fake", transport: "ws" }),
      );

      expect(existsSync(lockPath)).toBe(true);
      await cleanupStaleLockfiles();
      expect(existsSync(lockPath)).toBe(false);
    } finally {
      if (prevHome === undefined) delete process.env.SID_CONFIG_DIR;
      else process.env.SID_CONFIG_DIR = prevHome;
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ───────────────────────── D8 · WSL 不再是死字段 ─────────────────────────

describe("D8 · WSL 寻址与路径换算", () => {
  const saved: Record<string, string | undefined> = {};
  const KEYS = ["WSL_DISTRO_NAME", "WSL_INTEROP", "SID_CODE_WSL_HOST_IP"];

  beforeEach(() => {
    // 必须存/恢复原值而不是无条件 delete：bun test 同批多文件跑在同一进程里
    for (const k of KEYS) saved[k] = process.env[k];
    _resetWSLCacheForTesting();
  });

  afterEach(() => {
    for (const k of KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k]!;
    }
    _resetWSLCacheForTesting();
  });

  test("非 WSL 环境：host 恒为回环，字段被消费但行为逐字节不变", () => {
    for (const k of KEYS) delete process.env[k];
    _resetWSLCacheForTesting();

    expect(resolveIDEHost(true)).toBe("127.0.0.1");
    expect(resolveIDEHost(false)).toBe("127.0.0.1");
    expect(resolveIDEHost(undefined)).toBe("127.0.0.1");
  });

  test("WSL + IDE 在 Windows 上：host 换成宿主地址（这才是字段真正生效的点）", () => {
    process.env.WSL_DISTRO_NAME = "Ubuntu";
    process.env.SID_CODE_WSL_HOST_IP = "172.20.16.1";
    _resetWSLCacheForTesting();

    expect(isRunningInWSL()).toBe(true);
    expect(resolveIDEHost(true)).toBe("172.20.16.1");
    // IDE 不在 Windows 上（原生 Linux IDE）时仍走回环
    expect(resolveIDEHost(false)).toBe("127.0.0.1");
  });

  test("lockfileToDetectedIDE 把宿主地址带进 URL（D8 的消费终点）", () => {
    process.env.WSL_DISTRO_NAME = "Ubuntu";
    process.env.SID_CODE_WSL_HOST_IP = "172.20.16.1";
    _resetWSLCacheForTesting();

    const ide = lockfileToDetectedIDE(12345, { transport: "ws", runningInWindows: true });
    expect(ide.url).toBe("ws://172.20.16.1:12345");
    expect(ide.ideRunningInWindows).toBe(true);
  });

  test("非 WSL 下 URL 与修复前完全一致（回归保护）", () => {
    for (const k of KEYS) delete process.env[k];
    _resetWSLCacheForTesting();

    expect(lockfileToDetectedIDE(12345, { transport: "ws", runningInWindows: true }).url).toBe(
      "ws://127.0.0.1:12345",
    );
    expect(lockfileToDetectedIDE(8080, { transport: "sse" }).url).toBe("http://127.0.0.1:8080");
  });

  test("路径换算：WSL 下双向转换", () => {
    process.env.WSL_DISTRO_NAME = "Ubuntu";
    _resetWSLCacheForTesting();

    expect(windowsPathToWSL("C:\\Users\\me\\a.ts")).toBe("/mnt/c/Users/me/a.ts");
    expect(windowsPathToWSL("c:/Users/me/a.ts")).toBe("/mnt/c/Users/me/a.ts");
    expect(wslPathToWindows("/mnt/c/Users/me/a.ts")).toBe("C:\\Users\\me\\a.ts");

    // 已经是本方言的路径不该被改动
    expect(windowsPathToWSL("/home/me/a.ts")).toBe("/home/me/a.ts");
    expect(wslPathToWindows("/home/me/a.ts")).toBe("/home/me/a.ts");
  });

  test("路径换算：非 WSL 下是严格 no-op", () => {
    for (const k of KEYS) delete process.env[k];
    _resetWSLCacheForTesting();

    for (const p of ["C:\\Users\\me\\a.ts", "/mnt/c/Users/me/a.ts", "/home/me/a.ts"]) {
      expect(windowsPathToWSL(p)).toBe(p);
      expect(wslPathToWindows(p)).toBe(p);
    }
  });
});

// ───────────────────────── D3 · diff 响应解析 ─────────────────────────

describe("D3 · openDiff 响应解析", () => {
  test("CC 扩展的内容块数组形态（标准）", () => {
    const raw = JSON.stringify([
      { type: "text", text: DIFF_STATUS.saved },
      { type: "text", text: "用户手改后的全文" },
    ]);
    expect(parseDiffResponse(raw)).toEqual({
      status: DIFF_STATUS.saved,
      content: "用户手改后的全文",
    });
  });

  test("只回状态、没有内容块（用户直接接受，未二次编辑）", () => {
    const raw = JSON.stringify([{ type: "text", text: DIFF_STATUS.rejected }]);
    expect(parseDiffResponse(raw)).toEqual({ status: DIFF_STATUS.rejected, content: undefined });
  });

  test("宽容：对象形态 {status, content}", () => {
    const raw = JSON.stringify({ status: DIFF_STATUS.tabClosed, content: "x" });
    expect(parseDiffResponse(raw)).toEqual({ status: DIFF_STATUS.tabClosed, content: "x" });
  });

  test("宽容：裸状态字符串", () => {
    expect(parseDiffResponse("  FILE_SAVED  ")).toEqual({ status: DIFF_STATUS.saved });
  });

  test("非法 JSON 不抛异常，交由上层落到 error 分支", () => {
    expect(parseDiffResponse("{不是 json")).toEqual({});
  });
});

// ───────────────────────── D5 · ide_connected 通知 ─────────────────────────

describe("D5 · 连接成功后发 ide_connected", () => {
  test("connectToIDE 成功时向 IDE 发一次 ide_connected（带 pid）", async () => {
    const { IDEIntegration, resetIDEIntegration } =
      await import("@sid-code/core/ide/integration.ts");
    const { AGENT_NOTIFY, IDE_NOTIFY } = await import("@sid-code/core/ide/protocol.ts");
    resetIDEIntegration();

    const sent: Array<{ method: string; params?: unknown }> = [];
    const subscribed: string[] = [];
    const client = {
      notify(method: string, params?: Record<string, unknown>) {
        sent.push({ method, params });
        return true;
      },
      onNotification(method: string) {
        subscribed.push(method);
        return () => {};
      },
    };
    const mcpManager = {
      addServer: async () => [],
      isConnected: () => true,
      getClient: () => client,
      removeServer: async () => {},
    };

    const integ = new IDEIntegration(mcpManager as never, "/tmp/ws");
    const ok = await integ.connectToIDE({ url: "ws://127.0.0.1:1", name: "Fake", port: 1 });

    expect(ok).toBe(true);
    expect(sent).toEqual([{ method: AGENT_NOTIFY.ideConnected, params: { pid: process.pid } }]);

    // 顺序判据：通知必须排在两个订阅之后 —— IDE 可能在收到 ide_connected 后
    // 立刻回推一次当前选区，订阅还没挂上就会静默丢掉那一次。
    expect(subscribed).toEqual([IDE_NOTIFY.selectionChanged, IDE_NOTIFY.atMentioned]);

    resetIDEIntegration();
  });

  test("传输层不支持发通知时不影响连接判定（IDE 是可选增强）", async () => {
    const { IDEIntegration, resetIDEIntegration } =
      await import("@sid-code/core/ide/integration.ts");
    resetIDEIntegration();

    const client = {
      notify: () => false, // 传输层没有 sendNotification
      onNotification: () => () => {},
    };
    const mcpManager = {
      addServer: async () => [],
      isConnected: () => true,
      getClient: () => client,
      removeServer: async () => {},
    };

    const integ = new IDEIntegration(mcpManager as never, "/tmp/ws");
    expect(await integ.connectToIDE({ url: "ws://127.0.0.1:1", name: "Fake", port: 1 })).toBe(true);
    resetIDEIntegration();
  });
});
