/**
 * C2 回归：mcp-state.json 损坏后，下一次写入必须「先备份再覆盖」。
 *
 * 缺陷形态：`readState` 静默吞掉解析异常并返回 `{}`，紧接着 `setMcpServerDisabled`
 * 把空对象整体写回 —— 原有禁用 / 启用名单被一份几乎为空的文件静默覆盖，不可逆。
 *
 * 变异自证（逐条撤掉修复，对应断言必须变红）：
 * - 删掉 `setMcpServerDisabled` 里的备份逻辑 → 「disable 前先备份」用例红；
 * - 去掉 `readPath === primary` 守卫（无条件备份）→ 「linked worktree」用例红
 *   （旧键那份损坏文件会被误挪走）；
 * - 删掉 `readState` 里的告警 → 「告警」用例红。
 *
 * 落盘隔离：`SID_CONFIG_DIR` 指向 tmpdir，测试前后存 / 恢复原值（不要无条件 delete）。
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "fs";
import { dirname, join } from "path";
import { tmpdir } from "os";
import { execSync } from "child_process";
import { initLogger, LogLevel } from "@sid-code/core/debug/logger.ts";
import {
  getMcpServerToggles,
  resolveProjectStateFile,
  setMcpServerDisabled,
} from "@sid-code/core/mcp/project-files.ts";

let ROOT: string;
let REPO: string;
let prevConfigDir: string | undefined;

beforeEach(() => {
  ROOT = realpathSync(mkdtempSync(join(tmpdir(), "sid-mcp-state-corrupt-")));
  prevConfigDir = process.env.SID_CONFIG_DIR;
  process.env.SID_CONFIG_DIR = join(ROOT, "cfg");
  mkdirSync(process.env.SID_CONFIG_DIR, { recursive: true });
  // 项目身份按 git root 归一（M4），所以给一个真实仓库，走生产同一条路径
  REPO = join(ROOT, "repo");
  mkdirSync(REPO, { recursive: true });
  execSync("git init -q", { cwd: REPO });
});

afterEach(() => {
  if (prevConfigDir === undefined) delete process.env.SID_CONFIG_DIR;
  else process.env.SID_CONFIG_DIR = prevConfigDir;
  rmSync(ROOT, { recursive: true, force: true });
});

/** 该项目 mcp-state.json 的读写路径（经 resolveProjectStateFile 推导，不硬编码） */
async function statePaths(cwd: string = REPO): Promise<{ path: string; primary: string }> {
  return await resolveProjectStateFile("mcp-state.json", cwd);
}

/** 在指定路径写一份损坏内容（父目录按需创建） */
function writeCorruptAt(file: string, content = '{ "disabledMcpServers": ['): void {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, content);
}

/** 目录下的全部 `.corrupt-*` 备份文件 */
function corruptBackupsIn(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((f) => f.includes(".corrupt-"));
}

describe("C2 项目状态文件损坏：告警 + 读取回退空名单 + 写前备份", () => {
  test("损坏文件读出空名单（fail-safe，不抛错）", async () => {
    const { path } = await statePaths();
    writeCorruptAt(path);
    expect(await getMcpServerToggles(REPO)).toEqual({ disabled: [], enabled: [] });
  });

  test("disable 前先备份：备份与原内容逐字节相同，新文件含本次禁用", async () => {
    const { path, primary } = await statePaths();
    const corrupt = '{ "disabledMcpServers": [';
    writeCorruptAt(path, corrupt);

    const written = await setMcpServerDisabled("x", true, REPO);

    expect(written).toBe(primary);
    const backups = corruptBackupsIn(dirname(primary));
    expect(backups.length).toBe(1);
    expect(readFileSync(join(dirname(primary), backups[0]), "utf-8")).toBe(corrupt);
    // 新文件是合法 JSON，本次禁用已落盘、可读回
    const state = JSON.parse(readFileSync(primary, "utf-8")) as { disabledMcpServers: string[] };
    expect(state.disabledMcpServers).toContain("x");
    expect((await getMcpServerToggles(REPO)).disabled).toEqual(["x"]);
  });

  test("同一个损坏文件只备份一次", async () => {
    const { path, primary } = await statePaths();
    writeCorruptAt(path);
    await setMcpServerDisabled("a", true, REPO);
    await setMcpServerDisabled("b", true, REPO);
    expect(corruptBackupsIn(dirname(primary)).length).toBe(1);
    expect((await getMcpServerToggles(REPO)).disabled.sort()).toEqual(["a", "b"]);
  });

  test("读到损坏后又读到合法内容（外部已修复）不会误备份好文件", async () => {
    const { path, primary } = await statePaths();
    writeCorruptAt(path);
    // 第一次读：损坏 → 标记待备份
    expect(await getMcpServerToggles(REPO)).toEqual({ disabled: [], enabled: [] });
    // 外部把文件改回合法内容（用户手动修好 / 另一个进程写回）
    writeFileSync(path, JSON.stringify({ disabledMcpServers: ["keep"] }));

    await setMcpServerDisabled("x", true, REPO);

    expect(corruptBackupsIn(dirname(primary))).toEqual([]);
    expect((await getMcpServerToggles(REPO)).disabled.sort()).toEqual(["keep", "x"]);
  });

  test("文件不存在（首次使用）不产生任何备份", async () => {
    const { primary } = await statePaths();
    await setMcpServerDisabled("s", true, REPO);
    expect(corruptBackupsIn(dirname(primary))).toEqual([]);
    expect((await getMcpServerToggles(REPO)).disabled).toEqual(["s"]);
  });

  test("损坏时写一条 WARN：消息含文件路径与备份说明", async () => {
    const { path } = await statePaths();
    writeCorruptAt(path, "{ not json");
    const logFile = join(ROOT, "warn.log");
    const lg = initLogger({
      enabled: true,
      level: LogLevel.WARN,
      logFile,
      console: false,
      fileOnly: true,
    });
    try {
      await getMcpServerToggles(REPO);
      await lg.flush();
      const text = readFileSync(logFile, "utf-8");
      expect(text).toContain("已损坏");
      expect(text).toContain(path);
      expect(text).toContain("备份");
    } finally {
      // 全局单例：不复位会污染同进程的其它测试文件
      initLogger({ enabled: false });
    }
  });

  test("linked worktree：读旧键那份、写主仓根那份时不备份（写入不会覆盖损坏文件）", async () => {
    writeFileSync(join(REPO, "README.md"), "x\n");
    const git = "git -c user.email=t@t -c user.name=t";
    execSync(`${git} add -A && ${git} commit -qm init`, { cwd: REPO });
    const wt = join(ROOT, "wt");
    execSync(`git worktree add -q -b wtbranch ${JSON.stringify(wt)}`, { cwd: REPO });

    // 构造 #220 时期的遗留布局：旧键（worktree 自己）那份损坏、主仓根那份不存在
    const { sanitizeProjectKey } = await import("@sid-code/core/memory/paths.ts");
    const { getCheckoutRoot } = await import("@sid-code/core/config/project-bases.ts");
    const { sidPaths } = await import("@sid-code/core/config/paths.ts");
    const legacy = join(
      sidPaths.projects(),
      sanitizeProjectKey(getCheckoutRoot(wt)),
      "mcp-state.json",
    );
    const corrupt = "{ not json";
    writeCorruptAt(legacy, corrupt);

    const { path: readPath, primary } = await statePaths(wt);
    expect(readPath).toBe(legacy);
    expect(readPath).not.toBe(primary);

    const written = await setMcpServerDisabled("x", true, wt);

    expect(written).toBe(primary);
    // 损坏的旧键文件原样保留：本次写入的目标是主仓根那份，不会覆盖它
    expect(readFileSync(readPath, "utf-8")).toBe(corrupt);
    expect(corruptBackupsIn(dirname(readPath))).toEqual([]);
    // 主仓根那份被创建
    const created = JSON.parse(readFileSync(primary, "utf-8")) as { disabledMcpServers: string[] };
    expect(created.disabledMcpServers).toContain("x");
  });
});
