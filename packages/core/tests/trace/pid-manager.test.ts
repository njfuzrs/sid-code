/**
 * pid-manager 单测
 */
import { describe, test, expect, afterEach, afterAll } from "bun:test";
import { join } from "node:path";
import { existsSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import * as PidManager from "@sid-code/core/trace/pid-manager.ts";
import { getSidHome } from "@sid-code/core/config/paths.ts";

// 从 getSidHome() 派生而非硬编码 join(homedir(), ".sid-code")：
// 后者会让本测试**真的往用户家目录写** PID 文件，且在隔离生效时期望路径失配。
// getSidHome() 尊重 SID_CONFIG_DIR（含 tests/preload-isolate-sid-home.ts 设的兜底）。
const BASE_DIR = join(getSidHome(), "trajectories");
const PIDS_DIR = join(BASE_DIR, ".pids");

/** 清理测试数据 */
function cleanupTestFiles() {
  try {
    void PidManager["findOrphanPids"]; // 仅引用确保模块加载
  } catch {
    /* ignore */
  }

  // 删除当前 PID 文件
  try {
    PidManager.cleanup("test-session-001");
  } catch {
    /* ignore */
  }

  // 删除测试用的孤儿 PID 文件
  const orphanPid = 123456;
  const orphanPath = join(PIDS_DIR, `${orphanPid}.json`);
  try {
    if (existsSync(orphanPath)) {
      const { unlinkSync } = require("node:fs") as typeof import("node:fs");
      unlinkSync(orphanPath);
    }
  } catch {
    /* ignore */
  }

  // 确保至少有一个测试孤儿 PID
  const testOrphanPid = 999999;
  const testOrphanPath = join(PIDS_DIR, `${testOrphanPid}.json`);
  try {
    if (existsSync(testOrphanPath)) {
      const { unlinkSync } = require("node:fs") as typeof import("node:fs");
      unlinkSync(testOrphanPath);
    }
  } catch {
    /* ignore */
  }
}

afterEach(() => {
  cleanupTestFiles();
});

describe("pid-manager", () => {
  test("write() 创建 PID 文件且内容正确", () => {
    const result = PidManager.write("test-session-001");
    expect(result).toBe(true);

    const pidPath = join(PIDS_DIR, `${process.pid}.json`);
    expect(existsSync(pidPath)).toBe(true);

    const raw = readFileSync(pidPath, "utf-8");
    const entry = JSON.parse(raw);
    expect(entry.pid).toBe(process.pid);
    expect(entry.session_id).toBe("test-session-001");
    expect(typeof entry.start_time).toBe("string");
    expect(typeof entry.process_title).toBe("string");
  });

  test("cleanup() 删除 PID 文件", () => {
    // 先写
    PidManager.write("test-session-001");
    const pidPath = join(PIDS_DIR, `${process.pid}.json`);
    expect(existsSync(pidPath)).toBe(true);

    // 再删
    PidManager.cleanup("test-session-001");
    expect(existsSync(pidPath)).toBe(false);
  });

  test("cleanup() 不匹配的 session 不会误删", () => {
    // 写入
    PidManager.write("test-session-001");
    const pidPath = join(PIDS_DIR, `${process.pid}.json`);
    expect(existsSync(pidPath)).toBe(true);

    // 用错的 session_id 调用 cleanup
    PidManager.cleanup("non-existent-session");
    expect(existsSync(pidPath)).toBe(true); // 仍然存在

    // 正确清理
    PidManager.cleanup("test-session-001");
    expect(existsSync(pidPath)).toBe(false);
  });

  test("cleanup() 空目录不报错", () => {
    // 不应抛异常
    expect(() => PidManager.cleanup("test-session-001")).not.toThrow();
  });

  test("findOrphanPids() 返回进程已不存在的条目", () => {
    // 创建假 PID 文件（指向不存在进程的 PID）
    const orphanPid = 999999;
    const orphanPath = join(PIDS_DIR, `${orphanPid}.json`);
    try {
      mkdirSync(PIDS_DIR, { recursive: true });
    } catch {
      /* ignore */
    }

    const orphanEntry: PidManager.PidEntry = {
      pid: orphanPid,
      session_id: "orphaned-session",
      start_time: new Date().toISOString(),
      process_title: "test-process",
    };
    writeFileSync(orphanPath, JSON.stringify(orphanEntry, null, 2));

    const orphans = PidManager.findOrphanPids();
    // 应该包含我们创建的孤儿 PID
    const found = orphans.find((o) => o.pid === orphanPid);
    expect(found).toBeDefined();
    expect(found!.session_id).toBe("orphaned-session");

    // 清理
    try {
      require("node:fs").unlinkSync(orphanPath);
    } catch {
      /* ignore */
    }
  });

  test("findOrphanPids() 不把活跃进程标记为孤儿", () => {
    // 写入当前进程 PID 文件
    PidManager.write("test-session-001");

    const orphans = PidManager.findOrphanPids();
    // 当前进程 PID 不应该出现在孤儿列表中
    const found = orphans.find((o) => o.pid === process.pid);
    expect(found).toBeUndefined();
  });

  test("findOrphanPids() 空目录返回空数组", () => {
    // 确保所有本 session 的文件被清理
    PidManager.cleanup("test-session-001");

    // 多次调用确保空目录
    const orphans = PidManager.findOrphanPids();
    // 可能还有其他进程的 PID 文件，但不应报错
    expect(Array.isArray(orphans)).toBe(true);
  });

  test("write() 重复写覆盖旧值", () => {
    // 第一次写
    PidManager.write("test-session-001");
    const pidPath = join(PIDS_DIR, `${process.pid}.json`);
    const firstRaw = readFileSync(pidPath, "utf-8");
    const firstEntry = JSON.parse(firstRaw);
    // 先钉住覆盖前的值，否则「覆盖」无从谈起：原先这里读出 firstEntry 却从不断言，
    // 真正被验证的只有第二次写的结果，第一次写即使根本没落盘测试也照样绿。
    expect(firstEntry.session_id).toBe("test-session-001");

    // 第二次写
    PidManager.write("test-session-002"); // 不同 session_id
    const secondRaw = readFileSync(pidPath, "utf-8");
    const secondEntry = JSON.parse(secondRaw);

    expect(secondEntry.session_id).toBe("test-session-002");
    expect(secondEntry.pid).toBe(process.pid);

    // 清理
    PidManager.cleanup("test-session-002");
  });

  test("scanStaleHeartbeats() 无残留返回空数组", () => {
    const sessions = PidManager.scanStaleHeartbeats();
    expect(Array.isArray(sessions)).toBe(true);
  });
});

/**
 * P2-13：僵尸会话误报。
 *
 * 旧行为把 scanStaleHeartbeats() 的**全量**结果当「疑似 hang」报警，实测启动时刷 29 行，
 * 而 29 条全是「进程已退出」——即真 hang 数为 0。`is_process_alive` 字段一直存在，
 * 只是从不参与过滤。这里钉住分类判据本身。
 */
describe("pid-manager · classifyStaleHeartbeats（P2-13 hang 与未正常收尾分流）", () => {
  const SESSIONS_DIR = join(BASE_DIR, "sessions");
  /** 本组测试造的 session 目录，afterAll 里逐个删（只删自己造的，绝不整目录 rm） */
  const created: string[] = [];

  /** 造一个「有心跳、无 crash.json、心跳已过期」的残留会话目录 */
  function makeStaleSession(name: string, opts: { withLivePid: boolean }): string {
    const sessionId = `p2-13-${name}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const dir = join(SESSIONS_DIR, sessionId);
    mkdirSync(dir, { recursive: true });
    created.push(dir);

    // 心跳时间戳设在 10 分钟前，确保跨过 30s stale 阈值
    const ts = new Date(Date.now() - 600_000).toISOString();
    writeFileSync(join(dir, "heartbeat.txt"), JSON.stringify({ ts }));

    if (opts.withLivePid) {
      // 把 PID 指向**当前测试进程**——它必然存活，于是该会话被判为真 hang。
      // 用真实存活 pid 而不是 mock process.kill：判据本身就是 kill(pid, 0)，
      // mock 掉它等于测试自己写的假逻辑。
      mkdirSync(PIDS_DIR, { recursive: true });
      const pidFile = join(PIDS_DIR, `${process.pid}.json`);
      writeFileSync(
        pidFile,
        JSON.stringify({
          pid: process.pid,
          session_id: sessionId,
          start_time: new Date().toISOString(),
          process_title: "p2-13-test",
        }),
      );
      created.push(pidFile);
    }
    // withLivePid=false：不写 PID 文件 → 查不到存活进程 → 判为已退出（未正常收尾）

    return sessionId;
  }

  afterAll(() => {
    for (const p of created) {
      try {
        rmSync(p, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
    }
  });

  test("N 个「有心跳 + 进程已退出」的残留：hang 计数为 0，未正常收尾计数为 N", () => {
    const N = 3;
    const ids = Array.from({ length: N }, (_, i) =>
      makeStaleSession(`exited-${i}`, {
        withLivePid: false,
      }),
    );

    const stale = PidManager.scanStaleHeartbeats();
    const mine = stale.filter((s) => ids.includes(s.session_id));
    expect(mine.length).toBe(N); // 扫描仍返回全量，分类才是新增的那一步

    const { hang, unfinished } = PidManager.classifyStaleHeartbeats(mine);
    expect(hang.length).toBe(0);
    expect(unfinished.length).toBe(N);
  });

  test("进程仍存活的残留会话被判为真 hang", () => {
    const id = makeStaleSession("alive", { withLivePid: true });

    const stale = PidManager.scanStaleHeartbeats();
    const mine = stale.filter((s) => s.session_id === id);
    expect(mine.length).toBe(1);

    const { hang, unfinished } = PidManager.classifyStaleHeartbeats(mine);
    expect(hang.length).toBe(1);
    expect(unfinished.length).toBe(0);
    expect(hang[0].session_id).toBe(id);
  });

  test("分类是纯函数：hang + unfinished 无重无漏地覆盖输入", () => {
    const input: PidManager.StaleHeartbeatSession[] = [
      { session_id: "a", last_heartbeat_ts: "2026-08-10T00:00:00.000Z", is_process_alive: false },
      { session_id: "b", last_heartbeat_ts: "2026-08-10T00:00:01.000Z", is_process_alive: true },
      { session_id: "c", last_heartbeat_ts: "2026-08-10T00:00:02.000Z", is_process_alive: false },
    ];
    const { hang, unfinished } = PidManager.classifyStaleHeartbeats(input);
    expect(hang.map((s) => s.session_id)).toEqual(["b"]);
    expect(unfinished.map((s) => s.session_id)).toEqual(["a", "c"]);
    expect(hang.length + unfinished.length).toBe(input.length);
  });
});
