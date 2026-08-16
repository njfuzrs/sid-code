/**
 * 启动期孤儿运行时数据回收测试（2026-08-16）
 *
 * 覆盖三处「清理逻辑代码全在、生产调用全 0」的兜底：
 *  - shell-snapshots/：清理挂在退出钩子上，崩溃 / kill -9 不跑 → 永久残留（实测 379 个 / 52MB）
 *  - tasks/：evictTaskOutput 只在驱逐路径删盘，异常退出留下（实测 5621 个 / 21MB）
 *  - checkpoints/：cleanupOldSessions 挂在懒加载 init 里，只读会话从不触发（实测 651 个超期未删）
 *
 * ## 这些用例刻意断言什么
 *
 * 1. **超期删、未超期留** —— 两侧都要断言。只断言"删了"的测试对"删太多"是盲的，
 *    而这三个函数删的是用户数据（checkpoints 里是 /undo 历史）。
 * 2. **并行安全** —— checkpoints 必须跳过活跃会话，也必须跳过**本会话**（后者是实现时
 *    查出的真缺口：清理接线在 `cli.ts:1157`，而本会话的 `registerSession()` 到
 *    `cli.ts:2212` 才跑，中间那段本会话不在注册表里 → `--resume` 一个 30 天前的旧会话
 *    会把用户正要恢复的 checkpoint 删掉）。这是本组里最要紧的两条：误删别人或自己的
 *    checkpoint 等于抹掉 /undo 历史，而"少删一轮"的代价只是几十 MB。
 *
 *    ⚠ 刻意不写"fail-closed"：`listActiveSessions()` 把读失败吞掉并返回 `[]`
 *   （`session/concurrent.ts:81/88`），所以调用方**分不清**「没有活跃会话」与
 *    「目录读不了」。真正的保护来自 `selfSessionId` 与 30 天阈值两层，不是那个 catch。
 * 3. **水位线节流** —— 未到期不该扫盘。
 *
 * ## 为什么不用 maxAgeMs=0 造"立即过期"
 *
 * `statSync().mtimeMs` 是**浮点**（亚毫秒），刚写的文件 `now - mtimeMs` 可能是**负数**，
 * 于是 `> 0` 恒 false、一个都不删且不报错（仓库记忆 mtime-float-breaks-maxage-zero）。
 * 所以这里一律用 `utimesSync` 把 mtime 显式推到过去，再用真实阈值判 —— 断言的是
 * 生产用的那条判据，不是一个只在测试里成立的特例。
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  existsSync,
  rmSync,
  utimesSync,
  readdirSync,
  readFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runStartupHousekeeping } from "@sid-code/core/config/startup-housekeeping.ts";
import { sidPaths } from "@sid-code/core/config/paths.ts";

let tmpHome: string;
let prevConfigDir: string | undefined;

/** 把某个路径的 mtime 推到 `daysAgo` 天前 */
function ageBy(path: string, daysAgo: number): void {
  const t = new Date(Date.now() - daysAgo * 24 * 3600_000);
  utimesSync(path, t, t);
}

beforeEach(() => {
  tmpHome = mkdtempSync(join(tmpdir(), "sid-housekeeping-orphan-"));
  prevConfigDir = process.env.SID_CONFIG_DIR;
  process.env.SID_CONFIG_DIR = tmpHome;
});

afterEach(() => {
  // 存/恢复原值，不无条件 delete（同进程多文件跑，会抹掉 preload 兜底）
  if (prevConfigDir === undefined) delete process.env.SID_CONFIG_DIR;
  else process.env.SID_CONFIG_DIR = prevConfigDir;
  try {
    rmSync(tmpHome, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

describe("孤儿 shell 快照回收（阈值 24h，按 mtime 判）", () => {
  test("超 24h 的删、24h 内的留", () => {
    const dir = sidPaths.shellSnapshots();
    mkdirSync(dir, { recursive: true });

    const stale = join(dir, "snapshot-zsh-11111.sh");
    const fresh = join(dir, "snapshot-zsh-22222.sh");
    writeFileSync(stale, "# old\n");
    writeFileSync(fresh, "# new\n");
    ageBy(stale, 3);

    runStartupHousekeeping(Date.now());

    expect(existsSync(stale)).toBe(false);
    expect(existsSync(fresh), "未超期的快照被删了 —— 可能有活跃会话正在 source 它").toBe(true);
  });

  test("只删 .sh，目录里的其它文件与目录本身都不碰", () => {
    const dir = sidPaths.shellSnapshots();
    mkdirSync(dir, { recursive: true });
    const other = join(dir, "README.txt");
    const sub = join(dir, "subdir");
    writeFileSync(other, "not a snapshot\n");
    mkdirSync(sub, { recursive: true });
    ageBy(other, 30);
    ageBy(sub, 30);

    runStartupHousekeeping(Date.now());

    // 限定后缀：将来有人往该目录放别的东西时不该被连带删掉
    expect(existsSync(other)).toBe(true);
    expect(existsSync(sub)).toBe(true);
    expect(existsSync(dir)).toBe(true);
  });

  test("目录不存在时不抛异常（首次启动路径）", () => {
    expect(existsSync(sidPaths.shellSnapshots())).toBe(false);
    expect(() => runStartupHousekeeping(Date.now())).not.toThrow();
  });
});

describe("孤儿 task 输出回收（阈值 7 天）", () => {
  test("超 7 天的 .output 删、7 天内的留", () => {
    const dir = sidPaths.tasks();
    mkdirSync(dir, { recursive: true });

    const stale = join(dir, "a001stale.output");
    const fresh = join(dir, "a002fresh.output");
    writeFileSync(stale, "old output\n");
    writeFileSync(fresh, "new output\n");
    ageBy(stale, 10);

    runStartupHousekeeping(Date.now());

    expect(existsSync(stale)).toBe(false);
    expect(existsSync(fresh)).toBe(true);
  });

  test("非 .output 文件不碰", () => {
    const dir = sidPaths.tasks();
    mkdirSync(dir, { recursive: true });
    const other = join(dir, "index.json");
    writeFileSync(other, "{}\n");
    ageBy(other, 90);

    runStartupHousekeeping(Date.now());

    expect(existsSync(other)).toBe(true);
  });
});

describe("过期 checkpoints 兜底回收（阈值 30 天 + 并行安全）", () => {
  test("超 30 天的会话目录删、未超期的留", () => {
    const root = sidPaths.checkpointsRoot();
    const stale = join(root, "20260601-000000-aaaaaaaa");
    const fresh = join(root, "20260815-000000-bbbbbbbb");
    mkdirSync(stale, { recursive: true });
    mkdirSync(fresh, { recursive: true });
    writeFileSync(join(stale, "index.json"), "{}\n");
    writeFileSync(join(fresh, "index.json"), "{}\n");
    ageBy(stale, 40);

    runStartupHousekeeping(Date.now());

    expect(existsSync(stale)).toBe(false);
    expect(existsSync(fresh)).toBe(true);
  });

  test("并行安全：活跃会话的目录即使 mtime 超期也绝不删", () => {
    const root = sidPaths.checkpointsRoot();
    // 关键情形：一个跑了 30 天以上的长会话，checkpoint 目录 mtime 停在很早
    //（只在真改文件时才写），但它活着、随时可能被 /undo 用到。
    const activeId = "20260601-000000-cccccccc";
    const activeDir = join(root, activeId);
    mkdirSync(activeDir, { recursive: true });
    writeFileSync(join(activeDir, "index.json"), "{}\n");
    ageBy(activeDir, 60);

    // 用当前进程 pid 注册成活跃会话 —— listActiveSessions() 按 pid 存活过滤，
    // 本进程必然活着，所以这条注册一定会被认作活跃。
    const sessDir = sidPaths.activeSessions();
    mkdirSync(sessDir, { recursive: true });
    writeFileSync(
      join(sessDir, `${activeId}.json`),
      JSON.stringify({
        sessionId: activeId,
        pid: process.pid,
        startedAt: Date.now(),
        cwd: tmpHome,
      }),
    );

    runStartupHousekeeping(Date.now());

    expect(
      existsSync(activeDir),
      "活跃会话的 checkpoint 目录被删了 —— 这会抹掉另一个正在跑的会话的 /undo 历史",
    ).toBe(true);
  });

  test("时序缺口：本会话尚未注册（--resume 旧会话）时也不得删自己的目录", () => {
    // 这是实现时发现的真缺口，不是假想：runStartupHousekeeping 接线在 cli.ts:1157，
    // 而本会话的 registerSession() 要到 cli.ts:2212 才跑 —— 中间本会话不在注册表里。
    // 平时无害（新会话目录还很新），但 `--resume` 一个 30 天前的旧会话时，
    // 目录 mtime 超期 + 未注册 = 用户正要恢复的 checkpoint 被删。
    const root = sidPaths.checkpointsRoot();
    const resumedId = "20260601-000000-eeeeeeee";
    const resumedDir = join(root, resumedId);
    mkdirSync(resumedDir, { recursive: true });
    writeFileSync(join(resumedDir, "index.json"), "{}\n");
    ageBy(resumedDir, 60);

    // 刻意**不**写 active-sessions 注册文件 —— 复现"还没注册"的那一段时序
    expect(existsSync(join(sidPaths.activeSessions(), `${resumedId}.json`))).toBe(false);

    runStartupHousekeeping(Date.now(), { selfSessionId: resumedId });

    expect(
      existsSync(resumedDir),
      "本会话的 checkpoint 被自己的启动清理删了 —— --resume 旧会话会当场丢掉 /undo 历史",
    ).toBe(true);
  });

  test("非活跃会话（pid 已退出）的超期目录照常回收", () => {
    const root = sidPaths.checkpointsRoot();
    const deadId = "20260601-000000-dddddddd";
    const deadDir = join(root, deadId);
    mkdirSync(deadDir, { recursive: true });
    ageBy(deadDir, 60);

    // pid=1 之外挑一个几乎必然不存在的高位 pid，模拟"注册文件还在但进程早没了"
    const sessDir = sidPaths.activeSessions();
    mkdirSync(sessDir, { recursive: true });
    writeFileSync(
      join(sessDir, `${deadId}.json`),
      JSON.stringify({ sessionId: deadId, pid: 999_999, startedAt: Date.now(), cwd: tmpHome }),
    );

    runStartupHousekeeping(Date.now());

    expect(existsSync(deadDir)).toBe(false);
  });
});

describe("水位线节流对新增的三项同样生效", () => {
  test("距上次清理不足 24h 时，一个孤儿都不该被删", () => {
    const now = Date.now();
    // 水位线写成"刚刚清理过"
    mkdirSync(tmpHome, { recursive: true });
    writeFileSync(sidPaths.lastCleanup(), String(now - 60_000));

    const snapDir = sidPaths.shellSnapshots();
    mkdirSync(snapDir, { recursive: true });
    const stale = join(snapDir, "snapshot-zsh-33333.sh");
    writeFileSync(stale, "# old\n");
    ageBy(stale, 30);

    runStartupHousekeeping(now);

    expect(existsSync(stale), "水位线未到期却扫了盘 —— 节流失效会让每次启动都遍历几千个文件").toBe(
      true,
    );
  });

  test("水位线到期后跑一轮并刷新水位线（下次启动即被节流）", () => {
    const now = Date.now();
    mkdirSync(tmpHome, { recursive: true });
    writeFileSync(sidPaths.lastCleanup(), String(now - 48 * 3600_000));

    const snapDir = sidPaths.shellSnapshots();
    mkdirSync(snapDir, { recursive: true });
    const stale = join(snapDir, "snapshot-zsh-44444.sh");
    writeFileSync(stale, "# old\n");
    ageBy(stale, 30);

    runStartupHousekeeping(now);
    expect(existsSync(stale)).toBe(false);

    // 第二轮：水位线已刷新，新造的超期文件不该被删
    const stale2 = join(snapDir, "snapshot-zsh-55555.sh");
    writeFileSync(stale2, "# old2\n");
    ageBy(stale2, 30);
    runStartupHousekeeping(now);
    expect(existsSync(stale2)).toBe(true);
  });
});

describe("接线门禁：清理必须真的在生产启动路径上被调用", () => {
  // 本 PR 治的病就是「清理代码全在、生产调用全 0」。如果只写上面那些行为用例，
  // 新代码会重蹈覆辙：单测全绿、真实会话零触发。所以必须钉住接线本身。
  //
  // 判据用静态断言而非跑一次 CLI：起真实 CLI 要 API key 与 TTY，在 CI 里不可行。
  const CLI_PATH = join(import.meta.dir, "..", "..", "..", "cli", "src", "cli.ts");

  test("cli.ts 调了 runStartupHousekeeping 且传了 selfSessionId", () => {
    const text = readFileSync(CLI_PATH, "utf-8");
    expect(existsSync(CLI_PATH)).toBe(true);
    expect(text).toContain("runStartupHousekeeping(");
    // 不传 selfSessionId 会让 `--resume` 旧会话时删掉用户正要恢复的 checkpoint，
    // 详见上方「时序缺口」用例。这条锁住那个参数不被后人顺手删掉。
    // 注意不能用 `\([^)]*selfSessionId`：实参里有 `Date.now()`，`[^)]*` 会在它的
    // 右括号处就停住，永远匹配不到后面的 selfSessionId（第一版就是这么写的，白红一次）。
    // 改为从调用点起取一小段窗口再找参数名。
    const callIdx = text.indexOf("runStartupHousekeeping(");
    expect(callIdx).toBeGreaterThan(-1);
    expect(
      text.slice(callIdx, callIdx + 200).includes("selfSessionId"),
      "cli.ts 调 runStartupHousekeeping 时没传 selfSessionId —— --resume 旧会话会丢 /undo 历史",
    ).toBe(true);
  });

  test("三个新增清理都挂在水位线块内（不是写了函数没人调）", () => {
    const src = readFileSync(
      join(import.meta.dir, "..", "..", "src", "config", "startup-housekeeping.ts"),
      "utf-8",
    );
    for (const fn of [
      "cleanupOrphanedShellSnapshots",
      "cleanupOrphanedTaskOutputs",
      "cleanupStaleCheckpoints",
    ]) {
      // 定义 1 处 + 调用 1 处 = 至少 2 次出现。只有 1 次说明是死函数 ——
      // 正是 checkpoints/shell-snapshots 那三处缺陷的形态。
      const hits = src.split(new RegExp(`\\b${fn}\\b`)).length - 1;
      expect(hits, `${fn} 在本文件中只出现 ${hits} 次，疑似定义了没调用`).toBeGreaterThanOrEqual(2);
    }
  });

  test("checkpoint 兜底阈值与 CheckpointManager 的 maxAgeDays 默认值保持一致", () => {
    // 两个数字是同一套策略的两个触发者。写歪了会出现"兜底比本体更激进"这种
    // 谁也说不清的行为：本体 30 天不删、兜底 7 天就删掉了用户的 /undo 历史。
    const hk = readFileSync(
      join(import.meta.dir, "..", "..", "src", "config", "startup-housekeeping.ts"),
      "utf-8",
    );
    const mgr = readFileSync(
      join(import.meta.dir, "..", "..", "src", "checkpoint", "manager.ts"),
      "utf-8",
    );
    const hkDays = /CHECKPOINT_MAX_AGE_MS\s*=\s*(\d+)\s*\*\s*24/.exec(hk)?.[1];
    // 实际形态是 `maxAgeDays: config?.maxAgeDays ?? 30`（默认值在 ?? 右边），
    // 所以要抠的是兜底值而不是"冒号后的第一个数字"——后者在这行根本匹配不到数字。
    const mgrDays = /maxAgeDays\s*:\s*config\?\.maxAgeDays\s*\?\?\s*(\d+)/.exec(mgr)?.[1];
    expect(hkDays, "没抠到 CHECKPOINT_MAX_AGE_MS 的天数，正则或常量名漂移了").toBeDefined();
    expect(mgrDays, "没抠到 CheckpointManager 的 maxAgeDays 默认值").toBeDefined();
    expect(hkDays).toBe(mgrDays);
  });
});

describe("不越界：本模块不碰 settings 与记忆", () => {
  test("settings.json 与 projects/ 下的记忆目录一个都不动（哪怕 mtime 很旧）", () => {
    mkdirSync(tmpHome, { recursive: true });
    const settings = sidPaths.settings();
    writeFileSync(settings, '{"theme":"dark"}\n');
    ageBy(settings, 365);

    const memDir = join(sidPaths.projects(), "Users-someone-proj", "memory");
    mkdirSync(memDir, { recursive: true });
    const memFile = join(memDir, "MEMORY.md");
    writeFileSync(memFile, "- 记忆索引\n");
    ageBy(memFile, 365);
    ageBy(memDir, 365);

    runStartupHousekeeping(Date.now());

    // 这两类是用户资产，不是可重建的运行时数据 —— 由各自模块管理，本模块一概不碰
    expect(existsSync(settings)).toBe(true);
    expect(existsSync(memFile)).toBe(true);
    expect(readdirSync(memDir)).toContain("MEMORY.md");
  });
});
