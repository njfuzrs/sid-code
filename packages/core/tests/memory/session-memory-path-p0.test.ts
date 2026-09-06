/**
 * P0-4 防复发：Session Memory 必须按会话分文件
 *
 * 旧实现只按项目键派生一个 `.session_memory.md`，于是同一项目的并发会话、
 * `--resume` 的旧会话、同一仓库的多个 worktree 全都读写同一个物理文件——
 * 无锁、无 session 校验、无启动重置。最坏形态不是「压缩后失忆」，
 * 而是**压缩后记成了别人的事**：注入文案写着「以下是本次会话的结构化笔记」，
 * 一句「本次」把跨会话污染断言成了本会话事实。
 *
 * 隔离：设 SID_CONFIG_DIR 指向 tmpdir（路径派生读的是它），并用一个真实 git
 * 仓库当 cwd —— getSessionMemoryPath 走 resolveProjectRoot（git toplevel）。
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, rmSync, existsSync } from "fs";
import { join, dirname, basename } from "path";
import { tmpdir } from "os";
import { getSessionMemoryPath, getSessionMemoryDir } from "@sid-code/core/memory/paths.ts";

let tmpHome: string;
let prevConfigDir: string | undefined;
let repoA: string;

beforeAll(() => {
  tmpHome = mkdtempSync(join(tmpdir(), "sid-sm-path-home-"));
  prevConfigDir = process.env.SID_CONFIG_DIR;
  process.env.SID_CONFIG_DIR = tmpHome;
  repoA = mkdtempSync(join(tmpdir(), "sid-sm-repo-"));
});

afterAll(() => {
  // 存/恢复原值，不无条件 delete（同进程多文件共享 env）
  if (prevConfigDir === undefined) delete process.env.SID_CONFIG_DIR;
  else process.env.SID_CONFIG_DIR = prevConfigDir;
  for (const d of [tmpHome, repoA]) {
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
});

describe("getSessionMemoryPath 按会话分文件", () => {
  test("两个不同会话 id 派生出两个不同文件（旧实现下两者相等）", () => {
    const a = getSessionMemoryPath(repoA, "20260906-101010-aaaaaaaa");
    const b = getSessionMemoryPath(repoA, "20260906-202020-bbbbbbbb");
    expect(a).not.toBe(b);
    // 且都落在同一个项目的 session-memory/ 子目录下
    expect(dirname(a)).toBe(dirname(b));
    expect(basename(dirname(a))).toBe("session-memory");
  });

  test("同一会话 id 稳定复现同一路径（resume 必须拿回自己那份笔记）", () => {
    const sid = "20260906-101010-aaaaaaaa";
    expect(getSessionMemoryPath(repoA, sid)).toBe(getSessionMemoryPath(repoA, sid));
  });

  test("文件名就是会话 id，可直接归因到某次会话", () => {
    const p = getSessionMemoryPath(repoA, "20260906-101010-aaaaaaaa");
    expect(basename(p)).toBe("20260906-101010-aaaaaaaa.md");
  });

  test("getSessionMemoryDir 是这些文件的父目录（供清理与枚举）", () => {
    const p = getSessionMemoryPath(repoA, "20260906-101010-aaaaaaaa");
    expect(dirname(p)).toBe(getSessionMemoryDir(repoA));
  });

  test("会话 id 里的路径穿越字符被收敛，不会写出目录之外", () => {
    const evil = getSessionMemoryPath(repoA, "../../../../etc/passwd");
    // 关键：结果仍在 session-memory/ 里，且不含 `..` 段
    expect(dirname(evil)).toBe(getSessionMemoryDir(repoA));
    expect(evil.split(/[\\/]/)).not.toContain("..");
    expect(evil.endsWith(".md")).toBe(true);
  });

  test("不传 sessionId 时回退旧的项目级单文件（兼容存量，非推荐用法）", () => {
    const legacy = getSessionMemoryPath(repoA);
    expect(basename(legacy)).toBe(".session_memory.md");
    // 回退路径与新路径确实不同——这正是它「跨会话共享」的原因
    expect(legacy).not.toBe(getSessionMemoryPath(repoA, "some-session"));
  });

  test("空 / 全非法 sessionId 走回退，而不是拼出一个空文件名", () => {
    for (const bad of ["", "   ", "///", "..."]) {
      const p = getSessionMemoryPath(repoA, bad);
      expect(basename(p)).toBe(".session_memory.md");
      expect(existsSync(dirname(p)) || true).toBe(true); // 只断言路径形态，不落盘
    }
  });
});

/**
 * 接线层反漂移：路径函数支持按会话分文件，不代表接线真的传了 sessionId。
 *
 * 这条读的是 app.ts 的源码文本 —— 判据只能是「生产调用点传了第二个参数」，
 * 光测纯函数只修到第一层：函数改对了、调用方仍传旧参数时上面那些用例照样全绿，
 * 而线上仍在共用一个文件（仓库教训：门禁只测提纯函数，没证明它接进生产路径）。
 */
describe("接线层：app.ts 必须把会话 id 传进 getSessionMemoryPath", () => {
  test("生产调用点带 sessionId 参数，且 initSessionMemory 也收到它", async () => {
    const appPath = join(import.meta.dir, "../../../cli/src/app.ts");
    const src = await Bun.file(appPath).text();

    // ⚠️ 用 includes() 转成布尔再断言，**不要**直接 expect(src).toContain(...)：
    // app.ts 有 40 万字符，toContain 失败时会把整个文件打进测试输出（实测 440KB），
    // 真正有用的那一行信息反而被埋掉。
    const has = (needle: string) => src.includes(needle);

    // 调用点必须是两参形式（cwd + 会话 id），不能退回裸 getSessionMemoryPath(process.cwd())
    expect(has("getSessionMemoryPath(process.cwd(), sessionMemorySessionId)")).toBe(true);
    expect(has("getSessionMemoryPath(process.cwd())")).toBe(false);

    // 且 handle 也要拿到同一个 id（否则 session-memory.ts 内部仍走回退路径并 warn）
    expect(has("sessionId: sessionMemorySessionId")).toBe(true);

    // id 取自逻辑会话 id：resume 要拿回同一份笔记，不能用本进程新 id
    expect(has("const sessionMemorySessionId = this.getLogicalSessionId()")).toBe(true);
  });
});
