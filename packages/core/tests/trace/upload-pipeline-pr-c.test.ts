/**
 * PR-C：补传自身的根治（U1–U4）。
 *
 * - U1 流式压缩：逐行变换与整份变换逐字节相同；压缩产物可解回；缓存命中 / 源文件变了失效
 * - U2 成本重算：sidecar 让第二次只 stat；巨型非 AfterModelRaw 行不进 parse；结果与整份解析一致
 * - U3 multipart：手拼的流式请求体能被标准解析器还原
 * - U4 持久化退避与终态：失败记账 → 退避跳过 → 达上限写终态 → 手动命令无视 → 成功清理
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  closeSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { prepareUploadFile, clearUploadCache } from "@sid-code/core/trace/upload-compress.ts";
import { redactHomeDir } from "@sid-code/core/trace/redact-home.ts";
import {
  buildStreamingMultipart,
  stripLocalOnlyEventFields,
} from "@sid-code/core/trace/uploader.ts";
import {
  backfillTrajCost,
  iterateAfterModelRawLines,
  recomputeCostFromEvents,
  COST_RECOMPUTED_SIDECAR,
} from "@sid-code/core/trace/cost-recompute.ts";
import {
  MAX_AUTO_ATTEMPTS,
  UPLOAD_FAILED_FILE,
  backoffMs,
  isInBackoff,
  readUploadAttempts,
  recordUploadFailure,
} from "@sid-code/core/trace/upload-attempts.ts";
import { runBackfill, scanPendingUploads } from "@sid-code/core/trace/backfill.ts";

let tmp: string;
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "sid-prc-"));
});
afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

const HOME = "/Users/alice";

describe("U1 流式变换 + 压缩缓存", () => {
  // 刻意让行跨 1MB 的 chunk 边界、含家目录与只留本地字段、末尾无换行
  function fixture(): { path: string; text: string } {
    const lines: string[] = [];
    for (let i = 0; i < 3000; i++) {
      lines.push(
        JSON.stringify({
          event: "PostToolUseFailure",
          data: { error_head: `boom ${i}`, error_kind: "x", cwd: `${HOME}/proj/${i}` },
          pad: "y".repeat(i % 700),
        }),
      );
    }
    lines.push(JSON.stringify({ event: "Big", path: `${HOME}/a`, blob: "z".repeat(2_500_000) }));
    const text = lines.join("\n"); // 无尾换行
    const path = join(tmp, "events.jsonl");
    writeFileSync(path, text);
    return { path, text };
  }

  test("逐行变换与整份变换逐字节相同（家目录脱敏 + 只留本地字段）", async () => {
    const { path, text } = fixture();
    const expected = redactHomeDir(stripLocalOnlyEventFields(text), HOME);
    const p = await prepareUploadFile(path, {
      compress: false,
      redactHomeDir: true,
      stripLocalOnly: stripLocalOnlyEventFields,
      home: HOME,
    });
    expect(readFileSync(p.path, "utf-8")).toBe(expected);
    expect(expected).not.toContain("error_head");
    expect(expected).not.toContain(HOME);
  });

  test("压缩产物解压后等于变换结果，sha256 对压缩后字节算", async () => {
    const { path, text } = fixture();
    const p = await prepareUploadFile(path, { compress: true, redactHomeDir: true, home: HOME });
    const gz = new Uint8Array(readFileSync(p.path));
    expect(new TextDecoder().decode(Bun.gunzipSync(gz))).toBe(redactHomeDir(text, HOME));
    const h = new Bun.CryptoHasher("sha256");
    h.update(gz);
    expect(p.sha256).toBe(h.digest("hex"));
    expect(p.bytes).toBe(gz.byteLength);
  });

  test("第二次命中缓存（不重压）；源文件变了缓存失效；clearUploadCache 删干净", async () => {
    const { path } = fixture();
    const a = await prepareUploadFile(path, { compress: true, redactHomeDir: false });
    expect(a.cacheHit).toBe(false);
    const b = await prepareUploadFile(path, { compress: true, redactHomeDir: false });
    expect(b.cacheHit).toBe(true);
    expect(b.sha256).toBe(a.sha256);
    // 选项变了也算失效
    const c = await prepareUploadFile(path, { compress: true, redactHomeDir: true, home: HOME });
    expect(c.cacheHit).toBe(false);

    writeFileSync(path, "changed\n");
    const d = await prepareUploadFile(path, { compress: true, redactHomeDir: true, home: HOME });
    expect(d.cacheHit).toBe(false);
    expect(new TextDecoder().decode(Bun.gunzipSync(readFileSync(d.path)))).toBe("changed\n");

    clearUploadCache(tmp);
    expect(existsSync(join(tmp, ".upload-cache"))).toBe(false);
  });
});

describe("U3 流式 multipart", () => {
  test("标准解析器能还原字段与文件字节", async () => {
    const f = join(tmp, "x.bin");
    const bytes = new Uint8Array(3 * 1024 * 1024).map((_, i) => (i * 31) & 0xff);
    writeFileSync(f, bytes);
    const m = buildStreamingMultipart(
      [
        ["session_id", "s1"],
        ["file_type", "traj"],
      ],
      {
        name: "file",
        filename: "session.traj.gz",
        contentType: "application/gzip",
        path: f,
        size: bytes.length,
      },
    );
    const body = await new Response(m.body as any).arrayBuffer();
    expect(body.byteLength).toBe(m.length); // Content-Length 必须与实际字节一致
    const fd = await new Response(body, { headers: { "content-type": m.contentType } }).formData();
    expect(fd.get("session_id")).toBe("s1");
    expect(fd.get("file_type")).toBe("traj");
    const file = fd.get("file") as File;
    expect(file.name).toBe("session.traj.gz");
    expect(new Uint8Array(await file.arrayBuffer())).toEqual(bytes);
  });
});

describe("U2 成本重算", () => {
  function raw(i: number, model = "claude-sonnet-4-5"): string {
    return JSON.stringify({
      event: "AfterModelRaw",
      timestamp: "2026-10-01T00:00:00.000Z",
      data: { index: i, model, usage: { input_tokens: 1000, output_tokens: 100 } },
    });
  }

  /** events.jsonl：几条 AfterModelRaw 夹着一条 3MB 的巨型行（正文里也出现了 "AfterModelRaw" 字样） */
  function writeEvents(dir: string): string {
    mkdirSync(dir, { recursive: true });
    const p = join(dir, "events.jsonl");
    const fd = openSync(p, "w");
    writeSync(fd, raw(1) + "\n");
    writeSync(fd, '{"event":"UserPromptSubmit","data":{"prompt":"');
    const chunk = Buffer.from("x".repeat(1024 * 1024));
    for (let i = 0; i < 3; i++) writeSync(fd, chunk);
    writeSync(fd, '\\"AfterModelRaw\\""}}\n');
    writeSync(fd, raw(2) + "\n");
    writeSync(fd, "not json\n");
    writeSync(fd, raw(3)); // 无尾换行
    closeSync(fd);
    return p;
  }

  test("巨型非目标行被字节层丢弃；产出的行全是 AfterModelRaw", () => {
    const p = writeEvents(join(tmp, "s"));
    const lines = [...iterateAfterModelRawLines(p)];
    expect(lines).toHaveLength(3);
    for (const l of lines) expect(JSON.parse(l).event).toBe("AfterModelRaw");
  });

  test("重算结果与整份解析口径一致（3 次调用）", () => {
    const dir = join(tmp, "s");
    writeEvents(dir);
    const r = recomputeCostFromEvents(dir);
    expect(r?.apiCalls).toBe(3);
    expect(r?.cumulativeInputTokens).toBe(3000);
    expect(r?.totalOutputTokens).toBe(300);
  });

  test("sidecar：第二次不再读 traj；events 变了重判", () => {
    const dir = join(tmp, "s");
    writeEvents(dir);
    writeFileSync(
      join(dir, "session.traj"),
      JSON.stringify({ metadata: { total_cost_usd: 999 }, info: {} }),
    );
    const first = backfillTrajCost(dir);
    expect(first.trajCorrupt).toBe(false); // 第一次真的读了 traj
    expect(existsSync(join(dir, COST_RECOMPUTED_SIDECAR))).toBe(true);

    // 把 traj 换成坏文件：若第二次还在 parse，会走损坏分支
    writeFileSync(join(dir, "session.traj"), "{broken");
    const second = backfillTrajCost(dir);
    expect(second.reason).toContain("sidecar");
    expect(second.trajCorrupt).toBeUndefined();

    // events 追加 → 指纹变 → 重判（这回 traj 损坏会被发现）
    const later = new Date(Date.now() + 5000);
    writeFileSync(
      join(dir, "events.jsonl"),
      readFileSync(join(dir, "events.jsonl"), "utf-8") + "\n" + raw(4),
    );
    utimesSync(join(dir, "events.jsonl"), later, later);
    const third = backfillTrajCost(dir);
    expect(third.trajCorrupt).toBe(true);
  });
});

describe("U4 持久化退避与终态", () => {
  function sessionDir(id: string): string {
    const d = join(tmp, "sessions", id);
    mkdirSync(d, { recursive: true });
    writeFileSync(join(d, "session.traj"), "{}");
    writeFileSync(join(d, "events.jsonl"), "{}\n");
    const old = new Date(Date.now() - 3600_000);
    utimesSync(d, old, old);
    return d;
  }

  test("退避序列：1h 起翻倍，48h 封顶；上限次数后写终态", () => {
    expect(backoffMs(1)).toBe(3600_000);
    expect(backoffMs(2)).toBe(7200_000);
    expect(backoffMs(20)).toBe(48 * 3600_000);
    const d = sessionDir("20261001-000000-aaaaaaaa");
    for (let i = 1; i < MAX_AUTO_ATTEMPTS; i++)
      expect(recordUploadFailure(d, "HTTP 502")).toBe(false);
    expect(existsSync(join(d, UPLOAD_FAILED_FILE))).toBe(false);
    expect(recordUploadFailure(d, "HTTP 502")).toBe(true);
    expect(existsSync(join(d, UPLOAD_FAILED_FILE))).toBe(true);
    expect(readUploadAttempts(d)?.attempts).toBe(MAX_AUTO_ATTEMPTS);
  });

  test("失败记账 → 下次扫描在退避里跳过（单列计数）→ 手动命令无视退避", async () => {
    const id = "20261001-000000-bbbbbbbb";
    const d = sessionDir(id);
    let calls = 0;
    const failing = {
      uploadSession: async () => {
        calls++;
        return { allConfirmed: false, reason: "traj: HTTP 502" };
      },
    };
    const r1 = await runBackfill(failing, { outputDir: tmp });
    expect(r1.attempted).toBe(1);
    expect(readUploadAttempts(d)?.lastError).toBe("traj: HTTP 502");
    expect(isInBackoff(d)).toBe(true);

    // 第二轮：退避中，一次请求都不发
    const r2 = await runBackfill(failing, { outputDir: tmp });
    expect(calls).toBe(1);
    expect(r2.backoff).toBe(1);
    expect(r2.pending).toBe(0);

    // 手动（ignoreBackoff）照样传；成功清掉退避文件
    const ok = { uploadSession: async () => ({ allConfirmed: true }) };
    const r3 = await runBackfill(ok, { outputDir: tmp, ignoreBackoff: true });
    expect(r3.uploaded).toBe(1);
    expect(readUploadAttempts(d)).toBeNull();
  });

  test("终态会话不再自动补传，单列在 uploadFailed；受保护 id 计入 live", () => {
    const d = sessionDir("20261001-000000-cccccccc");
    for (let i = 0; i < MAX_AUTO_ATTEMPTS; i++) recordUploadFailure(d, "e", 0); // 很久以前，退避已过期
    sessionDir("20261001-000000-dddddddd");
    const { pending, stats } = scanPendingUploads({
      outputDir: tmp,
      protectedSessionIds: ["20261001-000000-dddddddd"],
    });
    expect(pending).toHaveLength(0);
    expect(stats.uploadFailed).toBe(1);
    expect(stats.live).toBe(1);
  });

  test("被中止的那次不算失败（退出不等于传不上）", async () => {
    const d = sessionDir("20261001-000000-eeeeeeee");
    const ac = new AbortController();
    const up = {
      uploadSession: async () => {
        ac.abort();
        return { allConfirmed: false, reason: "aborted" };
      },
    };
    await runBackfill(up, { outputDir: tmp, signal: ac.signal });
    expect(readUploadAttempts(d)).toBeNull();
  });
});
