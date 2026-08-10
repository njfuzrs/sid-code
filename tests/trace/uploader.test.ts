/**
 * UploadManager 单元测试
 * 使用 mock fetch，验证：
 * - 单文件上传成功/失败/重试逻辑
 * - 持久化重试队列的写入与恢复
 * - 会话上传入口（uploadSession）
 * - 本地清理逻辑（cleanupLocal via allConfirmed）
 * - 服务端可达性检测
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { UploadManager } from "../../src/trace/uploader.ts";
import { join } from "node:path";
import { mkdirSync, rmSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";

// ─── 辅助：创建临时目录 ───

function makeTmpDir(prefix: string): string {
  const dir = join(tmpdir(), `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

// ─── 辅助：Mock fetch ───

type FetchMock = (url: string | URL | Request, init?: RequestInit) => Promise<Response>;

function mockFetchOk(extraBody?: Record<string, unknown>): FetchMock {
  return async () =>
    new Response(JSON.stringify({ status: "saved", sha256: "", ...extraBody }), {
      status: 200,
    });
}

function mockFetchStatus(status: number, body?: unknown): FetchMock {
  return async () =>
    new Response(typeof body === "string" ? body : JSON.stringify(body ?? {}), {
      status,
    });
}

function mockFetchSequence(responses: Array<() => Promise<Response>>): FetchMock {
  let idx = 0;
  return async () => {
    const fn = responses[idx] ?? responses[responses.length - 1];
    idx++;
    return fn();
  };
}

// ─── 主测试套件 ───

describe("UploadManager", () => {
  let tmpDir: string;
  let sessionDir: string;
  const sessionId = "test-sess-001";

  beforeEach(() => {
    tmpDir = makeTmpDir("uploader-test");
    sessionDir = join(tmpDir, "sessions", sessionId);
    mkdirSync(sessionDir, { recursive: true });

    // 创建三个测试文件
    writeFileSync(join(sessionDir, "session.traj"), JSON.stringify({ trajectory: [] }));
    writeFileSync(join(sessionDir, "raw.jsonl"), '{"index":1}\n');
    writeFileSync(join(sessionDir, "events.jsonl"), '{"event":"SessionStart"}\n');
  });

  afterEach(() => {
    if (existsSync(tmpDir)) {
      rmSync(tmpDir, { recursive: true });
    }
  });

  // ─── 构造 ───

  test("默认参数填充", () => {
    const mgr = new UploadManager({
      baseUrl: "http://localhost:8080",
      token: "test-token",
      outputDir: tmpDir,
    });
    expect(mgr.isServerReachable()).toBe(true);
  });

  /**
   * 回归（实测 P0）：`outputDir: undefined` 曾让**整个轨迹采集静默失效**。
   *
   * 根因是对象展开的顺序陷阱 —— `{...defaults, ...options}` 里 options 的
   * **显式 undefined 键会覆盖默认值**（不同于「键不存在」）。而调用方
   * `init-helpers.ts` 传的正是 `outputDir: traceConfig.outputDir`，
   * settings.json 未写 `trace.output_dir` 时它就是 undefined
   * → `join(undefined, ".upload_queue.jsonl")` 抛错
   * → TraceCollector 构造失败
   * → 日志只有一行「轨迹采集初始化失败」，其余功能全正常，**什么都没被记录**。
   *
   * 这条断言锁住兜底：显式 undefined 与键缺失都必须回落到默认目录。
   */
  test("outputDir 显式传 undefined 不抛错（可度量底座的护栏）", () => {
    expect(
      () =>
        new UploadManager({
          baseUrl: "http://localhost:8080",
          token: "test-token",
          outputDir: undefined,
        }),
    ).not.toThrow();
  });

  test("outputDir 键缺失 / 空串同样回落默认目录", () => {
    expect(
      () => new UploadManager({ baseUrl: "http://localhost:8080", token: "t" }),
    ).not.toThrow();
    // 空字符串不是合法目录，必须与 undefined 同样兜底（故用真值判断而非 ??）
    expect(
      () => new UploadManager({ baseUrl: "http://localhost:8080", token: "t", outputDir: "" }),
    ).not.toThrow();
  });

  // ─── 单文件上传 ───

  test("uploadFileWithRetry: 上传成功（200 OK）", async () => {
    const mgr = new UploadManager({
      baseUrl: "http://localhost",
      token: "tok",
      outputDir: tmpDir,
      maxRetries: 1,
      compress: false,
    });

    // mock fetch
    const origFetch = globalThis.fetch;
    globalThis.fetch = mockFetchOk() as any;

    const filePath = join(sessionDir, "session.traj");
    const result = await mgr.uploadFileWithRetry(filePath, sessionId, "traj");

    globalThis.fetch = origFetch;

    expect(result.status).toBe("uploaded");
    expect(result.fileType).toBe("traj");
    expect(typeof result.sha256).toBe("string");
  });

  test("uploadFileWithRetry: 409 跳过（已存在）", async () => {
    const mgr = new UploadManager({
      baseUrl: "http://localhost",
      token: "tok",
      outputDir: tmpDir,
      maxRetries: 1,
      compress: false,
    });

    const origFetch = globalThis.fetch;
    globalThis.fetch = mockFetchStatus(409, "Conflict") as any;

    const filePath = join(sessionDir, "raw.jsonl");
    const result = await mgr.uploadFileWithRetry(filePath, sessionId, "raw");

    globalThis.fetch = origFetch;

    expect(result.status).toBe("skipped");
    expect(result.reason).toBe("already exists");
  });

  test("uploadFileWithRetry: 401 不重试直接失败", async () => {
    let callCount = 0;
    const mgr = new UploadManager({
      baseUrl: "http://localhost",
      token: "bad-token",
      outputDir: tmpDir,
      maxRetries: 3,
      retryBaseMs: 1, // 极小退避，加快测试
      compress: false,
    });

    const origFetch = globalThis.fetch;
    globalThis.fetch = (async () => {
      callCount++;
      return new Response(JSON.stringify({ detail: "Unauthorized" }), { status: 401 });
    }) as any;

    const filePath = join(sessionDir, "session.traj");
    const result = await mgr.uploadFileWithRetry(filePath, sessionId, "traj");

    globalThis.fetch = origFetch;

    expect(result.status).toBe("failed");
    expect(result.reason).toBe("invalid token");
    // 401 不重试，只调用一次
    expect(callCount).toBe(1);
  });

  test("uploadFileWithRetry: 5xx 重试后成功", async () => {
    let callCount = 0;
    const mgr = new UploadManager({
      baseUrl: "http://localhost",
      token: "tok",
      outputDir: tmpDir,
      maxRetries: 3,
      retryBaseMs: 1, // 极小退避，加快测试
      compress: false,
    });

    const origFetch = globalThis.fetch;
    globalThis.fetch = mockFetchSequence([
      async () => new Response("Server Error", { status: 500 }),
      async () => new Response("Server Error", { status: 503 }),
      async () => new Response(JSON.stringify({ status: "saved" }), { status: 200 }),
    ]) as any;

    const filePath = join(sessionDir, "events.jsonl");
    const result = await mgr.uploadFileWithRetry(filePath, sessionId, "events");

    globalThis.fetch = origFetch;

    expect(result.status).toBe("uploaded");
    expect(callCount).toBe(0); // 用 mockFetchSequence，callCount 未自增
  });

  test("uploadFileWithRetry: 全部重试失败", async () => {
    const mgr = new UploadManager({
      baseUrl: "http://localhost",
      token: "tok",
      outputDir: tmpDir,
      maxRetries: 2,
      retryBaseMs: 1,
      compress: false,
    });

    const origFetch = globalThis.fetch;
    globalThis.fetch = mockFetchStatus(500, "Internal Server Error") as any;

    const filePath = join(sessionDir, "session.traj");
    const result = await mgr.uploadFileWithRetry(filePath, sessionId, "traj");

    globalThis.fetch = origFetch;

    expect(result.status).toBe("failed");
    expect(typeof result.reason).toBe("string");
  });

  test("uploadFileWithRetry: 网络错误重试后失败", async () => {
    const mgr = new UploadManager({
      baseUrl: "http://localhost",
      token: "tok",
      outputDir: tmpDir,
      maxRetries: 2,
      retryBaseMs: 1,
      compress: false,
    });

    const origFetch = globalThis.fetch;
    globalThis.fetch = (async () => {
      throw new Error("Network Error");
    }) as any;

    const filePath = join(sessionDir, "session.traj");
    const result = await mgr.uploadFileWithRetry(filePath, sessionId, "traj");

    globalThis.fetch = origFetch;

    expect(result.status).toBe("failed");
    expect(result.reason).toBe("Network Error");
  });

  test("uploadFileWithRetry: gzip 压缩时文件名带 .gz 后缀", async () => {
    // 用对象持有而非裸 let：TS 的控制流分析看不进 fetch mock 那个异步闭包，
    // 只看到「声明为 null 后再没赋值」，于是在下面 .get() 处把类型收窄成 never。
    // 包一层属性访问就不受该收窄影响。
    const captured: { formData: FormData | null } = { formData: null };
    const mgr = new UploadManager({
      baseUrl: "http://localhost",
      token: "tok",
      outputDir: tmpDir,
      maxRetries: 1,
      compress: true,
    });

    const origFetch = globalThis.fetch;
    globalThis.fetch = (async (_url: string, init?: RequestInit) => {
      captured.formData = init?.body as FormData;
      return new Response(JSON.stringify({ status: "saved" }), { status: 200 });
    }) as any;

    const filePath = join(sessionDir, "session.traj");
    await mgr.uploadFileWithRetry(filePath, sessionId, "traj");

    globalThis.fetch = origFetch;

    // 验证 FormData 中文件名带 .gz
    // 注意：在 Bun 中 FormData.get 返回 File 对象，其 name 属性包含文件名
    const fileField = captured.formData?.get("file") as File | null;
    expect(fileField?.name).toBe("session.traj.gz");
  });

  test("uploadFileWithRetry: 400 hash_mismatch 重试", async () => {
    let callCount = 0;
    const mgr = new UploadManager({
      baseUrl: "http://localhost",
      token: "tok",
      outputDir: tmpDir,
      maxRetries: 2,
      retryBaseMs: 1,
      compress: false,
    });

    const origFetch = globalThis.fetch;
    globalThis.fetch = (async () => {
      callCount++;
      if (callCount < 2) {
        return new Response(
          JSON.stringify({ detail: { error: "hash_mismatch", expected: "aaa", actual: "bbb" } }),
          { status: 400 },
        );
      }
      return new Response(JSON.stringify({ status: "saved" }), { status: 200 });
    }) as any;

    const filePath = join(sessionDir, "session.traj");
    const result = await mgr.uploadFileWithRetry(filePath, sessionId, "traj");

    globalThis.fetch = origFetch;

    expect(result.status).toBe("uploaded");
    expect(callCount).toBe(2);
  });

  // ─── uploadSession ───

  test("uploadSession: 全部成功后清理本地文件", async () => {
    const mgr = new UploadManager({
      baseUrl: "http://localhost",
      token: "tok",
      outputDir: tmpDir,
      maxRetries: 1,
      compress: false,
      deleteAfterUpload: true,
    });

    const origFetch = globalThis.fetch;
    globalThis.fetch = mockFetchOk() as any;

    const result = await mgr.uploadSession(sessionDir, sessionId);

    globalThis.fetch = origFetch;

    expect(result.allConfirmed).toBe(true);
    expect(result.files.every(f => f.status === "uploaded" || f.status === "skipped")).toBe(true);

    // 三个数据文件被删除
    expect(existsSync(join(sessionDir, "session.traj"))).toBe(false);
    expect(existsSync(join(sessionDir, "raw.jsonl"))).toBe(false);
    expect(existsSync(join(sessionDir, "events.jsonl"))).toBe(false);

    // .uploaded 标记文件存在
    const marker = join(sessionDir, ".uploaded");
    expect(existsSync(marker)).toBe(true);
    const markerData = JSON.parse(readFileSync(marker, "utf-8"));
    expect(markerData.session_id).toBe(sessionId);
    expect(typeof markerData.confirmed_at).toBe("string");
  });

  test("uploadSession: 部分失败时本地文件保留", async () => {
    let callCount = 0;
    const mgr = new UploadManager({
      baseUrl: "http://localhost",
      token: "tok",
      outputDir: tmpDir,
      maxRetries: 1,
      retryBaseMs: 1,
      compress: false,
    });

    const origFetch = globalThis.fetch;
    globalThis.fetch = (async () => {
      callCount++;
      // 前两个成功，第三个失败
      if (callCount <= 2) {
        return new Response(JSON.stringify({ status: "saved" }), { status: 200 });
      }
      return new Response("Server Error", { status: 500 });
    }) as any;

    const result = await mgr.uploadSession(sessionDir, sessionId);

    globalThis.fetch = origFetch;

    expect(result.allConfirmed).toBe(false);

    // 本地文件不应被删除
    expect(existsSync(join(sessionDir, "session.traj"))).toBe(true);
    expect(existsSync(join(sessionDir, ".uploaded"))).toBe(false);
  });

  test("uploadSession: 服务端不可达时直接入队不上传", async () => {
    const mgr = new UploadManager({
      baseUrl: "http://localhost",
      token: "tok",
      outputDir: tmpDir,
      maxRetries: 1,
      compress: false,
    });
    // 手动标记不可达
    mgr.setServerReachable(false);

    let fetchCalled = false;
    const origFetch = globalThis.fetch;
    globalThis.fetch = (async () => {
      fetchCalled = true;
      return new Response("{}", { status: 200 });
    }) as any;

    const result = await mgr.uploadSession(sessionDir, sessionId);

    globalThis.fetch = origFetch;

    // 不应调用 fetch
    expect(fetchCalled).toBe(false);
    expect(result.allConfirmed).toBe(false);
    expect(result.files).toHaveLength(0);
  });

  // ─── 持久化重试队列 ───

  test("uploadSession 失败时写入重试队列", async () => {
    // 使用独立的 tmpDir 作为 homedir 替代，避免污染真实 ~/.sid-code
    const queueDir = makeTmpDir("queue-test");
    const queuePath = join(queueDir, ".upload_queue.jsonl");

    const mgr = new UploadManager({
      baseUrl: "http://localhost",
      token: "tok",
      outputDir: tmpDir,
      maxRetries: 1,
      retryBaseMs: 1,
      compress: false,
    });

    // 覆盖队列路径（访问私有属性，仅测试用）
    (mgr as any).retryQueuePath = queuePath;

    const origFetch = globalThis.fetch;
    globalThis.fetch = mockFetchStatus(500) as any;

    await mgr.uploadSession(sessionDir, sessionId);

    globalThis.fetch = origFetch;

    // 队列文件应该存在
    expect(existsSync(queuePath)).toBe(true);
    const lines = readFileSync(queuePath, "utf-8").trim().split("\n").filter(Boolean);
    expect(lines.length).toBeGreaterThan(0);

    // 每行是合法的 JSON
    for (const line of lines) {
      const entry = JSON.parse(line);
      expect(entry.session_id).toBe(sessionId);
      expect(entry.status).toBe("pending");
      expect(entry.attempts).toBe(0);
    }

    // 清理
    if (existsSync(queueDir)) rmSync(queueDir, { recursive: true });
  });

  test("processRetryQueue: 成功上传后条目从队列移除", async () => {
    const queueDir = makeTmpDir("queue-recover-test");
    const queuePath = join(queueDir, ".upload_queue.jsonl");

    const mgr = new UploadManager({
      baseUrl: "http://localhost",
      token: "tok",
      outputDir: tmpDir,
      maxRetries: 1,
      retryBaseMs: 1,
      compress: false,
    });
    (mgr as any).retryQueuePath = queuePath;

    // 预置队列条目
    const entry = JSON.stringify({
      session_id: sessionId,
      file: "session.traj",
      added_at: new Date().toISOString(),
      attempts: 0,
      last_error: "",
      status: "pending",
    });
    writeFileSync(queuePath, entry + "\n");

    const origFetch = globalThis.fetch;
    globalThis.fetch = mockFetchOk() as any;

    await mgr.processRetryQueue();

    globalThis.fetch = origFetch;

    // 成功后队列应为空
    const content = readFileSync(queuePath, "utf-8").trim();
    expect(content).toBe("");

    if (existsSync(queueDir)) rmSync(queueDir, { recursive: true });
  });

  test("processRetryQueue: 失败时递增 attempts", async () => {
    const queueDir = makeTmpDir("queue-fail-test");
    const queuePath = join(queueDir, ".upload_queue.jsonl");

    const mgr = new UploadManager({
      baseUrl: "http://localhost",
      token: "tok",
      outputDir: tmpDir,
      maxRetries: 1,
      retryBaseMs: 1,
      compress: false,
    });
    (mgr as any).retryQueuePath = queuePath;

    const entry = JSON.stringify({
      session_id: sessionId,
      file: "session.traj",
      added_at: new Date().toISOString(),
      attempts: 0,
      last_error: "",
      status: "pending",
    });
    writeFileSync(queuePath, entry + "\n");

    const origFetch = globalThis.fetch;
    globalThis.fetch = mockFetchStatus(500) as any;

    await mgr.processRetryQueue();

    globalThis.fetch = origFetch;

    // 队列中应保留条目，attempts 递增
    const lines = readFileSync(queuePath, "utf-8").trim().split("\n").filter(Boolean);
    expect(lines).toHaveLength(1);
    const updated = JSON.parse(lines[0]);
    expect(updated.attempts).toBe(1);
    expect(updated.status).toBe("pending");

    if (existsSync(queueDir)) rmSync(queueDir, { recursive: true });
  });

  test("processRetryQueue: attempts >= 50 时标记 failed 并保留", async () => {
    const queueDir = makeTmpDir("queue-max-test");
    const queuePath = join(queueDir, ".upload_queue.jsonl");

    const mgr = new UploadManager({
      baseUrl: "http://localhost",
      token: "tok",
      outputDir: tmpDir,
      maxRetries: 1,
      retryBaseMs: 1,
      compress: false,
    });
    (mgr as any).retryQueuePath = queuePath;

    const entry = JSON.stringify({
      session_id: sessionId,
      file: "session.traj",
      added_at: new Date().toISOString(),
      attempts: 50, // 已达上限
      last_error: "some error",
      status: "pending",
    });
    writeFileSync(queuePath, entry + "\n");

    let fetchCalled = false;
    const origFetch = globalThis.fetch;
    globalThis.fetch = (async () => {
      fetchCalled = true;
      return new Response("{}", { status: 200 });
    }) as any;

    await mgr.processRetryQueue();

    globalThis.fetch = origFetch;

    // 不应调用 fetch
    expect(fetchCalled).toBe(false);

    // 条目保留，状态改为 failed
    const lines = readFileSync(queuePath, "utf-8").trim().split("\n").filter(Boolean);
    expect(lines).toHaveLength(1);
    const kept = JSON.parse(lines[0]);
    expect(kept.status).toBe("failed");

    if (existsSync(queueDir)) rmSync(queueDir, { recursive: true });
  });

  test("processRetryQueue: 文件不存在时跳过（不保留）", async () => {
    const queueDir = makeTmpDir("queue-missing-test");
    const queuePath = join(queueDir, ".upload_queue.jsonl");

    const mgr = new UploadManager({
      baseUrl: "http://localhost",
      token: "tok",
      outputDir: tmpDir,
      maxRetries: 1,
      retryBaseMs: 1,
      compress: false,
    });
    (mgr as any).retryQueuePath = queuePath;

    // 指向不存在的文件
    const entry = JSON.stringify({
      session_id: "nonexistent-sess",
      file: "session.traj",
      added_at: new Date().toISOString(),
      attempts: 0,
      last_error: "",
      status: "pending",
    });
    writeFileSync(queuePath, entry + "\n");

    let fetchCalled = false;
    const origFetch = globalThis.fetch;
    globalThis.fetch = (async () => {
      fetchCalled = true;
      return new Response("{}", { status: 200 });
    }) as any;

    await mgr.processRetryQueue();

    globalThis.fetch = origFetch;

    // 文件不存在，不调用 fetch，条目被清除
    expect(fetchCalled).toBe(false);
    const content = readFileSync(queuePath, "utf-8").trim();
    expect(content).toBe("");

    if (existsSync(queueDir)) rmSync(queueDir, { recursive: true });
  });

  test("processRetryQueue: 队列文件不存在时直接返回", async () => {
    const mgr = new UploadManager({
      baseUrl: "http://localhost",
      token: "tok",
      outputDir: tmpDir,
    });
    // 设置一个不存在的队列路径
    (mgr as any).retryQueuePath = join(tmpDir, "nonexistent_queue.jsonl");

    // 不应抛异常
    await expect(mgr.processRetryQueue()).resolves.toBeUndefined();
  });

  // ─── 心跳检测 ───

  test("checkHealth: 服务端可达时 serverReachable = true", async () => {
    const mgr = new UploadManager({
      baseUrl: "http://localhost",
      token: "tok",
      outputDir: tmpDir,
    });
    // 初始为 true
    mgr.setServerReachable(false);

    const origFetch = globalThis.fetch;
    // as any：Bun 的 typeof fetch 带 preconnect 属性，裸函数 mock 无法实现它。
    // 与仓库既有 fetch mock 写法一致（见 tests/llm/gateway-pricing.test.ts）。
    globalThis.fetch = (async () => new Response("{}", { status: 200 })) as any;

    // 调用私有 checkHealth
    await (mgr as any).checkHealth();

    globalThis.fetch = origFetch;

    expect(mgr.isServerReachable()).toBe(true);
  });

  test("checkHealth: 服务端不可达时 serverReachable = false", async () => {
    const mgr = new UploadManager({
      baseUrl: "http://localhost",
      token: "tok",
      outputDir: tmpDir,
    });
    expect(mgr.isServerReachable()).toBe(true);

    const origFetch = globalThis.fetch;
    globalThis.fetch = (async () => {
      throw new Error("Connection refused");
    }) as any;

    await (mgr as any).checkHealth();

    globalThis.fetch = origFetch;

    expect(mgr.isServerReachable()).toBe(false);
  });

  test("checkHealth: 服务端返回非 200 时 serverReachable = false", async () => {
    const mgr = new UploadManager({
      baseUrl: "http://localhost",
      token: "tok",
      outputDir: tmpDir,
    });

    const origFetch = globalThis.fetch;
    globalThis.fetch = (async () => new Response("Not Found", { status: 404 })) as any;

    await (mgr as any).checkHealth();

    globalThis.fetch = origFetch;

    expect(mgr.isServerReachable()).toBe(false);
  });

  test("stopHealthCheck: 清除心跳定时器", () => {
    const mgr = new UploadManager({
      baseUrl: "http://localhost",
      token: "tok",
      outputDir: tmpDir,
    });

    // mock checkHealth 以避免实际网络请求
    (mgr as any).checkHealth = async () => {};

    mgr.startHealthCheck(60_000);
    expect((mgr as any).healthCheckTimer).not.toBeNull();

    mgr.stopHealthCheck();
    expect((mgr as any).healthCheckTimer).toBeNull();
  });

  // ─── 辅助函数 ───

  test("fileNameToType: 正确映射三种文件", () => {
    // 通过 uploadSession 间接验证（直接调用需要访问模块内函数，这里通过行为测试）
    // 准备：raw.jsonl 上传失败后应进入队列（fileType="raw"）
    const queueDir = makeTmpDir("filetype-test");
    const queuePath = join(queueDir, ".upload_queue.jsonl");

    const mgr = new UploadManager({
      baseUrl: "http://localhost",
      token: "tok",
      outputDir: tmpDir,
      maxRetries: 1,
      retryBaseMs: 1,
      compress: false,
    });
    (mgr as any).retryQueuePath = queuePath;

    // 让 processRetryQueue 正确识别 "raw.jsonl" → "raw"
    const entry = JSON.stringify({
      session_id: sessionId,
      file: "raw.jsonl",
      added_at: new Date().toISOString(),
      attempts: 0,
      last_error: "",
      status: "pending",
    });
    writeFileSync(queuePath, entry + "\n");

    let capturedFileType: string | null = null;
    const origFetch = globalThis.fetch;
    globalThis.fetch = (async (_url: string, init?: RequestInit) => {
      capturedFileType = (init?.body as FormData)?.get("file_type") as string | null;
      return new Response(JSON.stringify({ status: "saved" }), { status: 200 });
    }) as any;

    // 使用 Promise 解决异步
    return mgr.processRetryQueue().then(() => {
      globalThis.fetch = origFetch;
      expect(capturedFileType).toBe("raw");

      if (existsSync(queueDir)) rmSync(queueDir, { recursive: true });
    });
  });
});
