/**
 * 回滚命令层的轨迹埋点（观测缺口 PR1 · T2 的命令层那一半）
 *
 * 设计文档 §4.1 要求这四个入口各一条、`via` 正确、且不含路径原文。core 侧
 * `RewindManager` 的埋点由 `session/rewind-telemetry.test.ts` 覆盖，这里补
 * `/rewind <n>`、`/undo`、`/undo <file>`、`/restore <id>` 四个命令。
 *
 * 为什么必须单独测命令层：反死线门禁只断言「有 `emitRewind` 调用点」，不校验
 * via / outcome。把 `restore` 的 `"ok"` 写成 `"nothing"`、或把 `rewind_n` 写成
 * `"dialog"`，门禁照样绿 —— 而那正是回滚率分子被污染的方式。
 *
 * 走真实 `CheckpointManager`（`getCheckpointManager` 按 sessionId 复用全局实例），
 * **不用 `mock.module`**：bun 的模块 mock 是进程级的，会污染同批其他测试文件。
 */
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { UndoCommand } from "@sid-code/cli/command/commands/undo/undo.ts";
import { RestoreCommand } from "@sid-code/cli/command/commands/restore/restore.ts";
import { RewindCommand } from "@sid-code/cli/command/commands/rewind/rewind.ts";
import type { CommandContext, LocalCommandResult } from "@sid-code/cli/command/types.ts";
import { defaultConfig } from "@sid-code/core/config/config.ts";
import type { Config } from "@sid-code/core/config/config.ts";
import { getCheckpointManager } from "@sid-code/core/checkpoint/manager.ts";
import { setRewindTraceSink, sha12 } from "@sid-code/core/session/rewind-telemetry.ts";

type Captured = Record<string, unknown>;
let captured: Captured[] = [];
let configDir: string;
let workspace: string;
const prevConfigDir = process.env.SID_CONFIG_DIR;

beforeEach(() => {
  captured = [];
  setRewindTraceSink((data) => captured.push(data));
  configDir = mkdtempSync(join(tmpdir(), "sid-rewind-cmd-"));
  process.env.SID_CONFIG_DIR = configDir;
  workspace = mkdtempSync(join(tmpdir(), "sid-rewind-cmd-ws-"));
});

afterEach(() => {
  setRewindTraceSink(null);
  if (prevConfigDir === undefined) delete process.env.SID_CONFIG_DIR;
  else process.env.SID_CONFIG_DIR = prevConfigDir;
  rmSync(configDir, { recursive: true, force: true });
  rmSync(workspace, { recursive: true, force: true });
});

const config = () => defaultConfig() as unknown as Config;

/** 命令只用到 config / sessionState / checkpointSessionId / ctxMgr */
function makeCtx(over: Record<string, unknown> = {}): CommandContext {
  return {
    config: config(),
    sessionState: { sessionId: "rewind-cmd-session" },
    ...over,
  } as unknown as CommandContext;
}

/** 真实 CheckpointManager（全局单例按 sessionId 复用；index 跨测试递增，不硬编码 id） */
async function cpMgr(sessionId = "rewind-cmd-session") {
  return getCheckpointManager(sessionId, config().checkpoint);
}

/** 写一个文件并建快照，返回 [路径, 快照 id] */
async function snapshotFile(mgr: Awaited<ReturnType<typeof cpMgr>>, name: string, body: string) {
  const filePath = join(workspace, name);
  writeFileSync(filePath, body);
  const id = await mgr.createSnapshot([filePath], "Edit", `改 ${name}`);
  return { filePath, id };
}

const events = () => captured;

describe("/rewind <n>", () => {
  it("有可回退轮次 → 一条 ok，via=rewind_n，requested/turns_removed 都对", async () => {
    let remaining = 3;
    const ctx = makeCtx({
      ctxMgr: {
        rewindTurns: (n: number) => {
          const removed = Math.min(n, remaining);
          remaining -= removed;
          return removed;
        },
        getTurnCount: () => remaining,
      },
    });

    const result = await new RewindCommand().call("2", ctx);

    expect(result.type).toBe("text");
    expect(events()).toHaveLength(1);
    expect(events()[0].via).toBe("rewind_n");
    expect(events()[0].outcome).toBe("ok");
    expect(events()[0].requested).toBe(2);
    expect(events()[0].turns_removed).toBe(2);
  });

  it("空转 → 一条 nothing（不是 ok，也不算没发生）", async () => {
    const ctx = makeCtx({
      ctxMgr: { rewindTurns: () => 0, getTurnCount: () => 0 },
    });

    const result = await new RewindCommand().call("9", ctx);

    expect(result.type).toBe("text");
    expect(events()).toHaveLength(1);
    expect(events()[0].outcome).toBe("nothing");
    expect(events()[0].requested).toBe(9);
    expect(events()[0].turns_removed).toBe(0);
  });
});

describe("/undo", () => {
  it("撤销最近快照 → 一条 ok，via=undo，带 files_restored", async () => {
    const mgr = await cpMgr();
    const { filePath } = await snapshotFile(mgr, "undo.txt", "v1");
    writeFileSync(filePath, "v2");

    const result = await new UndoCommand().call("", makeCtx());

    expect(result.type).toBe("text");
    expect(events()).toHaveLength(1);
    expect(events()[0].via).toBe("undo");
    expect(events()[0].outcome).toBe("ok");
    expect(Number(events()[0].files_restored)).toBeGreaterThanOrEqual(1);
  });

  it("没有快照可撤 → 一条 nothing", async () => {
    // 新 sessionId = 全新的 CheckpointManager（没有快照）
    const emptySession = `empty-${Date.now()}`;
    const result = await new UndoCommand().call(
      "",
      makeCtx({ sessionState: { sessionId: emptySession } }),
    );

    expect(result.type).toBe("text");
    expect(events()).toHaveLength(1);
    expect(events()[0].via).toBe("undo");
    expect(events()[0].outcome).toBe("nothing");
  });
});

describe("/undo <file>", () => {
  it("撤销单文件 → 一条 ok，只留 path_sha12，不含路径原文", async () => {
    const mgr = await cpMgr();
    const { filePath } = await snapshotFile(mgr, "single.txt", "before");
    writeFileSync(filePath, "after");

    const result = await new UndoCommand().call(filePath, makeCtx());

    expect(result.type).toBe("text");
    expect(events()).toHaveLength(1);
    expect(events()[0].via).toBe("undo_file");
    expect(events()[0].outcome).toBe("ok");
    expect(events()[0].path_sha12).toBe(sha12(filePath));
    // 隐私硬约束：路径原文不能进会被上传的轨迹
    expect(JSON.stringify(events())).not.toContain(filePath);
  });

  it("文件没有可撤销的修改 → 一条 nothing（仍带 path_sha12 供对账）", async () => {
    const missing = join(workspace, "never-snapshotted.txt");
    writeFileSync(missing, "x");

    await new UndoCommand().call(missing, makeCtx());

    expect(events()).toHaveLength(1);
    expect(events()[0].via).toBe("undo_file");
    expect(events()[0].outcome).toBe("nothing");
    expect(events()[0].path_sha12).toBe(sha12(missing));
    expect(JSON.stringify(events())).not.toContain(missing);
  });
});

describe("/restore <id>", () => {
  it("快照不存在 → 一条 nothing（reason=not_found）", async () => {
    await new RestoreCommand().call("s999999", makeCtx());

    expect(events()).toHaveLength(1);
    expect(events()[0].via).toBe("restore");
    expect(events()[0].outcome).toBe("nothing");
    expect(events()[0].reason).toBe("not_found");
  });

  it("目标已是最新（之后没有快照）→ 一条 nothing（reason=already_latest）", async () => {
    const mgr = await cpMgr();
    const { id } = await snapshotFile(mgr, "latest.txt", "v1");

    await new RestoreCommand().call(id, makeCtx());

    expect(events()).toHaveLength(1);
    expect(events()[0].via).toBe("restore");
    expect(events()[0].outcome).toBe("nothing");
    expect(events()[0].reason).toBe("already_latest");
  });

  it("确认后恢复 → 一条 ok，带 files_restored 与回滚的后续快照数", async () => {
    const mgr = await cpMgr();
    const { id } = await snapshotFile(mgr, "restore-target.txt", "v1");
    await snapshotFile(mgr, "restore-later.txt", "v1");

    const pending = (await new RestoreCommand().call(id, makeCtx())) as Extract<
      LocalCommandResult,
      { type: "confirm" }
    >;
    expect(pending.type).toBe("confirm");
    expect(events()).toHaveLength(0); // 确认前不记：还没发生任何回滚

    await pending.onConfirm();

    expect(events()).toHaveLength(1);
    expect(events()[0].via).toBe("restore");
    expect(events()[0].outcome).toBe("ok");
    expect(events()[0].snapshot_id).toBe(id);
    expect(Number(events()[0].files_restored)).toBeGreaterThanOrEqual(1);
    expect(Number(events()[0].snapshots_rolled_back)).toBeGreaterThanOrEqual(1);
  });
});
