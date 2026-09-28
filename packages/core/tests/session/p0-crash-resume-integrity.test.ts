/**
 * 会话持久化 P0 门禁：崩溃 / resume / --session-id 复用三条路径下的历史完整性。
 *
 * 覆盖 2026-09-27 那轮核查里的三条 P0（同源于「一个 jsonl 文件 = 一条 uuid 链」这个契约
 * 在异常路径上被破坏）：
 *
 *   - N1  链中任意一行损坏 ⇒ 整份会话读成 null，且被自动清理**当成损坏文件删除**
 *   - N9  续写不保证文件以 \n 结尾 ⇒ resume 后写的第一条消息与崩溃半行粘连、被静默吞掉
 *   - N15 `--session-id` 复用同一 id ⇒ 多段会话堆进一个文件，恢复只拿回最后一段
 *
 * 这三条的共同点是**用户完全无感**：界面一切正常、命令返回成功，数据在磁盘上消失。
 * 所以每条用例都断言"能捞回多少条真实消息"，而不只断言"没抛错"。
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import {
  SessionStore,
  parseSessionJsonl,
  hasParsableMessageRecords,
  currentProjectSessionDir,
} from "@sid-code/core/session/store.ts";
import { join } from "path";
import { mkdirSync, rmSync, existsSync, readFileSync, writeFileSync } from "fs";
import { tmpdir } from "os";

/** 造一条合法的链式记录行。 */
function recLine(rec: Record<string, unknown>): string {
  return JSON.stringify(rec);
}

/** 造一份「健康的 N 条消息会话」的行数组（session_start + N 条 user_message，链完整）。 */
function healthyLines(sessionId: string, messageCount: number): string[] {
  const lines = [
    recLine({
      type: "session_start",
      version: "3.0",
      sessionId,
      model: "m",
      provider: "p",
      cwd: "/tmp",
      timestamp: "2026-01-01T00:00:00.000Z",
      uuid: "u0",
      parentUuid: null,
    }),
  ];
  for (let i = 1; i <= messageCount; i++) {
    lines.push(
      recLine({
        type: "user_message",
        message: { role: "user", content: [{ type: "text", text: `消息${i}` }] },
        timestamp: "2026-01-01T00:00:00.000Z",
        uuid: `u${i}`,
        parentUuid: `u${i - 1}`,
      }),
    );
  }
  return lines;
}

describe("会话持久化 P0：崩溃/resume/id 复用下的历史完整性", () => {
  let testDir: string;
  let origHome: string | undefined;
  let origConfigDir: string | undefined;

  beforeEach(() => {
    testDir = join(tmpdir(), `sid-p0-session-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(join(testDir, ".sid-code", "sessions"), { recursive: true });
    origHome = process.env.HOME;
    process.env.HOME = testDir;
    origConfigDir = process.env.SID_CONFIG_DIR;
    process.env.SID_CONFIG_DIR = join(testDir, ".sid-code");
  });

  afterEach(() => {
    process.env.HOME = origHome;
    if (origConfigDir === undefined) delete process.env.SID_CONFIG_DIR;
    else process.env.SID_CONFIG_DIR = origConfigDir;
    if (existsSync(testDir)) rmSync(testDir, { recursive: true, force: true });
  });

  // ───────────────────────────────────────────────────────────
  // N1：链断 ⇒ 不许全损
  // ───────────────────────────────────────────────────────────
  describe("N1：链中一行损坏不再让整份会话读成 null", () => {
    test("中间坏一行：仍能解析出会话 id 与两侧的全部消息", () => {
      const lines = healthyLines("S-MID", 10);
      // 弄坏第 5 条消息那一行（模拟一次 flush 只落了半行）。
      lines[5] = '{"type":"user_message","message":{"rol';
      const data = parseSessionJsonl(lines.join("\n") + "\n");

      expect(data).not.toBeNull();
      expect(data!.id).toBe("S-MID");
      // 10 条里坏掉 1 条 ⇒ 其余 9 条都要捞回来（修复前是 0 条、整份 null）。
      expect(data!.messages.length).toBe(9);
    });

    test("首行（session_start）坏掉：解析仍返回 null，但内容可被识别为「还在」", () => {
      const lines = healthyLines("S-HEAD", 5);
      lines[0] = "{ 这行原本是 session_start，坏了";
      const content = lines.join("\n") + "\n";

      // 拿不到 sessionId ⇒ 组装不出 SessionData，这是预期（不臆造 id）。
      expect(parseSessionJsonl(content)).toBeNull();
      // 但文件里的真实消息都还在 ⇒ 清理侧必须据此判为不可删（见 cleanup.test.ts 的 N1 用例）。
      expect(hasParsableMessageRecords(content)).toBe(true);
    });

    test("真垃圾文件：没有任何可解析记录 ⇒ 仍判为不可恢复（反向自证判据没放水）", () => {
      expect(hasParsableMessageRecords("}{ 全是乱码\n\x00\x01\n")).toBe(false);
      // 只有 session_start 没有消息，也不算"有真实对话内容"。
      expect(
        hasParsableMessageRecords(
          recLine({ type: "session_start", sessionId: "x", uuid: "u0", parentUuid: null }),
        ),
      ).toBe(false);
    });

    test("链完整时不走线性回退：交叉写入的外部分支记录仍被排除", () => {
      const lines = healthyLines("S-CLEAN", 3);
      // 插入一条不在链上的"外部分支"记录（模拟多进程物理交叉写入）。
      lines.splice(
        2,
        0,
        recLine({
          type: "user_message",
          message: { role: "user", content: [{ type: "text", text: "别的进程写的" }] },
          timestamp: "2026-01-01T00:00:00.000Z",
          uuid: "x1",
          parentUuid: "x0",
        }),
      );
      const data = parseSessionJsonl(lines.join("\n") + "\n");

      expect(data).not.toBeNull();
      // 链是完整的（走到了 parentUuid=null），所以不该退化成线性解析把外部分支收进来。
      expect(data!.messages.length).toBe(3);
      const texts = JSON.stringify(data!.messages);
      expect(texts).not.toContain("别的进程写的");
    });
  });

  // ───────────────────────────────────────────────────────────
  // N9：续写不与崩溃半行粘连
  // ───────────────────────────────────────────────────────────
  describe("N9：resume 续写前补齐行尾换行符", () => {
    test("崩溃留下无换行符的半行 ⇒ 续写的消息不再被静默吞掉", async () => {
      const sessionId = "S-N9";
      const dir = currentProjectSessionDir();
      mkdirSync(dir, { recursive: true });
      const file = join(dir, `${sessionId}.jsonl`);

      // 造一个"崩溃现场"：3 条完整行 + 一条**没有换行符结尾**的半行。
      const lines = healthyLines(sessionId, 2);
      writeFileSync(file, lines.join("\n") + "\n" + '{"type":"user_mess');

      const store = new SessionStore();
      store.resumeSession(sessionId, "m", "p", "/tmp");
      store.appendMessage({ role: "user", content: [{ type: "text", text: "续写的第一条" }] });
      SessionStore.flushPendingWrites();

      const raw = readFileSync(file, "utf-8");
      // 半行与新记录之间必须有换行符隔开（否则两个 JSON 挤成一行、双双解析失败）。
      expect(raw).not.toContain('{"type":"user_mess{');

      const data = parseSessionJsonl(raw);
      expect(data).not.toBeNull();
      // 崩溃前的 2 条 + 续写的 1 条 = 3 条；修复前续写那条会随半行一起消失。
      expect(data!.messages.length).toBe(3);
      expect(JSON.stringify(data!.messages)).toContain("续写的第一条");
    });

    test("文件已以 \\n 结尾时不重复补写（不制造空行噪音）", async () => {
      const sessionId = "S-N9-OK";
      const dir = currentProjectSessionDir();
      mkdirSync(dir, { recursive: true });
      const file = join(dir, `${sessionId}.jsonl`);
      const original = healthyLines(sessionId, 1).join("\n") + "\n";
      writeFileSync(file, original);

      const store = new SessionStore();
      store.resumeSession(sessionId, "m", "p", "/tmp");
      SessionStore.flushPendingWrites();

      expect(readFileSync(file, "utf-8")).toBe(original);
    });
  });

  // ───────────────────────────────────────────────────────────
  // N15：--session-id 复用不再堆成多段链
  // ───────────────────────────────────────────────────────────
  describe("N15：startSession 对已存在的会话文件转续写", () => {
    test("同一 id 连续三段会话：全部历史都能恢复，只有一条 session_start", async () => {
      const sessionId = "S-N15";

      // 第 1 段。
      const s1 = new SessionStore();
      s1.startSession(sessionId, "m", "p", "/tmp");
      s1.appendMessage({ role: "user", content: [{ type: "text", text: "第1段" }] });
      SessionStore.flushPendingWrites();

      // 第 2 段：同一个 --session-id 再跑一次（独立进程 ⇒ 新 SessionStore 实例）。
      const s2 = new SessionStore();
      s2.startSession(sessionId, "m", "p", "/tmp");
      s2.appendMessage({ role: "user", content: [{ type: "text", text: "第2段" }] });
      SessionStore.flushPendingWrites();

      // 第 3 段。
      const s3 = new SessionStore();
      s3.startSession(sessionId, "m", "p", "/tmp");
      s3.appendMessage({ role: "user", content: [{ type: "text", text: "第3段" }] });
      SessionStore.flushPendingWrites();

      const file = join(currentProjectSessionDir(), `${sessionId}.jsonl`);
      const raw = readFileSync(file, "utf-8");

      // 不变量①：一个文件只有一条 session_start（修复前是 3 条 ⇒ 3 条互不相连的链）。
      const startCount = raw
        .split("\n")
        .filter((l) => l.trim())
        .filter((l) => {
          try {
            return JSON.parse(l).type === "session_start";
          } catch {
            return false;
          }
        }).length;
      expect(startCount).toBe(1);

      // 不变量②：三段消息全部可恢复（修复前只拿回最后一段）。
      const data = parseSessionJsonl(raw);
      expect(data).not.toBeNull();
      expect(data!.id).toBe(sessionId);
      expect(data!.messages.length).toBe(3);
      const texts = JSON.stringify(data!.messages);
      expect(texts).toContain("第1段");
      expect(texts).toContain("第2段");
      expect(texts).toContain("第3段");
    });

    test("目标文件不存在 ⇒ 仍按新会话起写（不影响正常路径）", async () => {
      const store = new SessionStore();
      store.startSession("S-N15-NEW", "m", "p", "/tmp");
      store.appendMessage({ role: "user", content: [{ type: "text", text: "新会话" }] });
      SessionStore.flushPendingWrites();

      const data = parseSessionJsonl(
        readFileSync(join(currentProjectSessionDir(), "S-N15-NEW.jsonl"), "utf-8"),
      );
      expect(data).not.toBeNull();
      expect(data!.id).toBe("S-N15-NEW");
      expect(data!.messages.length).toBe(1);
    });

    test("空文件（materialize 建了壳但没落记录）⇒ 按新会话起写，仍写 session_start", async () => {
      const dir = currentProjectSessionDir();
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "S-N15-EMPTY.jsonl"), "");

      const store = new SessionStore();
      store.startSession("S-N15-EMPTY", "m", "p", "/tmp");
      store.appendMessage({ role: "user", content: [{ type: "text", text: "内容" }] });
      SessionStore.flushPendingWrites();

      const data = parseSessionJsonl(readFileSync(join(dir, "S-N15-EMPTY.jsonl"), "utf-8"));
      expect(data).not.toBeNull();
      expect(data!.id).toBe("S-N15-EMPTY");
    });
  });
});
