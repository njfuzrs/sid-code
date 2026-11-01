/**
 * 大数据启动门禁（G1，PR-A 立、PR-B 起生效）。
 *
 * ## 不变量
 *
 * TUI 进程在首帧前和交互期间，主线程不做任何耗时随 `~/.sid-code/` 数据量增长的工作。
 *
 * ## 判据为什么是「差值」而不是绝对阈值
 *
 * 同一份二进制在**空配置目录**和**大数据配置目录**下各起一次 TUI，比两次的
 * `first_frame` 与 `max_loop_block_before_interactive`。不变量说的就是「与数据量无关」，
 * 差值正好量它；绝对值里混着模块编译、工具注册这类常数项，慢 runner 上会整体抬高，
 * 拿绝对阈值卡会变成 flake（本机空目录已有 ~140ms 的常数阻塞）。绝对值只设一道宽的兜底。
 *
 * 修复前实测（同一套 fixture）：会话清理全量读 + parse 200MB 单行、collector 构造扫几百个
 * 轨迹目录，阻塞是秒级——差值门禁一眼可见。
 *
 * ## 取数源
 *
 * `SID_CODE_PROFILE_STARTUP_DUMP` 落的 JSON（shared/utils/startup-profiler.ts）：
 * 首帧后 3s 窗口结束时写一次，不依赖 TUI 退出路径。
 *
 * ## 补传（U1–U4，PR-C 起生效）
 *
 * 另起一个配了上传地址的目录：一个 ≥200MB、无 `.uploaded` 的 traj 会话，上传地址指向本进程里
 * 一个只挂住不响应的 server。修复前补传在 TUI 进程里 gzipSync 整份 traj（3s 级阻塞），
 * 修复后整条补传在维护子进程里跑，同样按「与空目录的差值」断言。
 */
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
  openSync,
  writeSync,
  closeSync,
} from "node:fs";

const BOOTSTRAP = join(import.meta.dir, "..", "..", "src", "entrypoints", "bootstrap.ts");
/** 巨型会话 jsonl 的体积（复现 10-22 那份 222MB 会话的形态：一条 user_message 单行巨大） */
const BIG_SESSION_BYTES = 200 * 1024 * 1024;
/** 轨迹目录数（本机 579 个） */
const TRACE_DIRS = 1500;
/** 每个轨迹目录 tool-outputs 下的文件数（dirBytes 递归 stat 的规模） */
const TRACE_FILES_PER_DIR = 20;
/** 会话文件数（本机 768 个） */
const SESSION_FILES = 300;

interface Profile {
  checkpoints: Array<{ name: string; ms: number }>;
  metrics: Record<string, number>;
}

const homes: string[] = [];

function makeHome(extra: Record<string, unknown> = {}): string {
  const home = mkdtempSync(join(tmpdir(), "sid-startup-gate-"));
  homes.push(home);
  writeFileSync(
    join(home, "settings.json"),
    JSON.stringify({
      ...extra,
      model: "m",
      availableModels: [
        { name: "m", provider: "openai", api_key: "sk-test", base_url: "http://127.0.0.1:9/v1" },
      ],
      // debugLogFile 默认是字面量 ~/.sid-code/debug.log，不走 SID_CONFIG_DIR，显式改指隔离目录
      debug_log_file: join(home, "debug.log"),
    }),
  );
  return home;
}

/**
 * fixture 的时间口径：**会被扫描、但不会被删**。
 * 30 天前 = 过了 minRetention(1d)、没到 maxAge(365d)。门禁要跑多次启动取中位数，
 * 第一版用 400 天前的数据，第一轮启动（或变异版的主线程清理）就把巨型会话删了，
 * 后几轮量的是空目录——C1 放回主线程的变异因此没能让门禁变红。
 */
const SCANNED = new Date(Date.now() - 30 * 24 * 3600_000);
/** 只给「确实过期、该被子进程删掉」的那一个探针会话用 */
const EXPIRED = new Date(Date.UTC(2024, 0, 1));

/** 流式写一个巨型会话 jsonl：session_start + 一条 BIG 字节的 user_message（不在内存里拼巨串） */
function writeBigSession(dir: string, id: string): string {
  const file = join(dir, `${id}.jsonl`);
  const fd = openSync(file, "w");
  const t = SCANNED.toISOString();
  writeSync(
    fd,
    JSON.stringify({
      type: "session_start",
      sessionId: id,
      model: "m",
      provider: "p",
      cwd: "/",
      timestamp: t,
    }) + "\n",
  );
  writeSync(fd, '{"type":"user_message","message":{"role":"user","content":"');
  // 正文取「二进制被内联进消息」的真实形态：大量 \uXXXX / \n / \" 转义。
  // 纯 "aaaa" 的 JSON.parse 快一个量级，第一版 fixture 用它，C1 放回主线程的变异只多阻塞 58ms，没能变红。
  const unit = '\\u0000\\u0001ELF\\n\\t\\"\\\\\\u00ff\\ufffd';
  const chunk = Buffer.from(unit.repeat(Math.ceil((8 * 1024 * 1024) / unit.length)));
  for (let n = 0; n < BIG_SESSION_BYTES; n += chunk.length) writeSync(fd, chunk);
  writeSync(fd, `"},"timestamp":"${t}"}\n`);
  closeSync(fd);
  utimesSync(file, SCANNED, SCANNED);
  return file;
}

function writeSmallSession(dir: string, id: string, when: Date): string {
  const f = join(dir, `${id}.jsonl`);
  const t = when.toISOString();
  writeFileSync(
    f,
    [
      { type: "session_start", sessionId: id, model: "m", provider: "p", cwd: "/", timestamp: t },
      { type: "user_message", message: { role: "user", content: "hi" }, timestamp: t },
      { type: "assistant_message", message: { role: "assistant", content: "yo" }, timestamp: t },
    ]
      .map((r) => JSON.stringify(r))
      .join("\n") + "\n",
  );
  utimesSync(f, when, when);
  return f;
}

function populateLargeHome(home: string): { bigSession: string; expiredProbe: string } {
  const projDir = join(home, "sessions", "proj");
  mkdirSync(projDir, { recursive: true });
  for (let i = 0; i < SESSION_FILES; i++) {
    writeSmallSession(projDir, `20261001-000000-${String(i).padStart(8, "0")}`, SCANNED);
  }
  const expiredProbe = writeSmallSession(projDir, "20240101-000000-expired0", EXPIRED);
  const bigSession = writeBigSession(projDir, "20261001-000000-bigbigbi");

  // 轨迹目录取真实形态：有数据（不会被当空壳删）、带终态上传标记、tool-outputs 下一堆小文件。
  // T1 的成本在 hasFinalUploadMarker 的 readFileSync + dirBytes 递归 stat，只放一个小文件的
  // 空壳目录测不出它（第一版 fixture 就是这样，T1 放回构造函数的变异没能让门禁变红）。
  // mtime 取「现在」：在 minRetention 窗口内，淘汰不会删它们，每次启动都要扫一遍。
  const traceRoot = join(home, "trajectories", "sessions");
  for (let i = 0; i < TRACE_DIRS; i++) {
    const d = join(traceRoot, `20240101-000000-t${String(i).padStart(7, "0")}`);
    const outputs = join(d, "tool-outputs");
    mkdirSync(outputs, { recursive: true });
    writeFileSync(join(d, "events.jsonl"), JSON.stringify({ event: "AfterModelRaw" }) + "\n");
    writeFileSync(join(d, "session.traj"), "{}");
    writeFileSync(join(d, ".uploaded"), JSON.stringify({ final: true }));
    for (let k = 0; k < TRACE_FILES_PER_DIR; k++) writeFileSync(join(outputs, `o${k}.txt`), "x");
  }
  return { bigSession, expiredProbe };
}

/** traj 体积：复现 10-22 那份 445MB traj 的形态（同样大量转义） */
const BIG_TRAJ_BYTES = 200 * 1024 * 1024;

/** 一个待补传的巨型轨迹会话：traj ≥200MB、events 在、无 .uploaded、目录静置够久 */
function populateUploadHome(home: string): string {
  const id = "20261001-000000-upupupup";
  const d = join(home, "trajectories", "sessions", id);
  mkdirSync(d, { recursive: true });
  const traj = join(d, "session.traj");
  const fd = openSync(traj, "w");
  writeSync(fd, '{"metadata":{"session_id":"' + id + '","total_cost_usd":1},"history":["');
  const unit = '\\u0000\\u0001ELF\\n\\t\\"\\\\\\u00ff\\ufffd';
  const chunk = Buffer.from(unit.repeat(Math.ceil((8 * 1024 * 1024) / unit.length)));
  for (let n = 0; n < BIG_TRAJ_BYTES; n += chunk.length) writeSync(fd, chunk);
  writeSync(fd, '"]}');
  closeSync(fd);
  // 必须带 AfterModelRaw：没有可重算事件时 backfillTrajCost 提前返回、根本不读 traj，
  // U2（整份 parse 200MB traj，真实数据上最大的阻塞源）就没被覆盖——第一版就是这样空转的。
  writeFileSync(
    join(d, "events.jsonl"),
    [
      { event: "SessionStart", timestamp: SCANNED.toISOString() },
      {
        event: "AfterModelRaw",
        timestamp: SCANNED.toISOString(),
        data: { index: 1, model: "m", usage: { input_tokens: 1000, output_tokens: 100 } },
      },
    ]
      .map((e) => JSON.stringify(e))
      .join("\n") + "\n",
  );
  utimesSync(traj, SCANNED, SCANNED);
  utimesSync(d, SCANNED, SCANNED);
  return d;
}

/**
 * 每轮带上传的启动前，把上一轮补传留下的记账清掉，让每一轮都真的去做补传。
 *
 * 不清的话只有第一轮干活：之后压缩缓存命中、`.upload-attempts` 在退避里、trace-upload 的
 * 1h 维护水位线未到期，三轮取中位数会把唯一那轮吸收掉（变异自证时发现门禁空转才加的）。
 * 删的都是本测试在自己 tmp 目录里造出来的产物。
 */
/**
 * 等本目录的维护子进程跑完（锁释放）。两个用处：
 * - 它还持有锁时，下一轮的子进程会整轮跳过补传；
 * - 它在后台压 200MB 时会和下一轮 empty/large 的启动抢 CPU，把那两组的首帧差值抬高
 *   （实测 large 组 +250ms 假阳性，就是这个原因）。
 */
async function waitMaintenanceIdle(home: string): Promise<void> {
  const lock = join(home, "state", "maintenance.lock");
  // 子进程在首帧后才 fork，给它一点时间把锁建起来
  await Bun.sleep(500);
  const deadline = performance.now() + 90_000;
  while (existsSync(lock) && performance.now() < deadline) await Bun.sleep(200);
}

function resetUploadState(home: string, sessionDir: string): void {
  for (const f of [".upload-cache", ".upload-attempts", ".upload-failed", ".cost-recomputed"]) {
    rmSync(join(sessionDir, f), { recursive: true, force: true });
  }
  rmSync(join(sessionDir, ".uploaded"), { force: true });
  rmSync(join(home, "state", "maintenance-watermarks.json"), { force: true });
  utimesSync(sessionDir, SCANNED, SCANNED);
}

/** 在 pty 里起一次 TUI，等剖析 dump 落盘后杀掉 */
async function startOnce(home: string): Promise<Profile> {
  const dump = join(home, `profile-${Date.now()}.json`);
  const term = new Bun.Terminal({ cols: 120, rows: 40, data() {} });
  const proc = Bun.spawn(["bun", BOOTSTRAP], {
    terminal: term,
    cwd: home,
    env: {
      ...process.env,
      SID_CONFIG_DIR: home,
      SID_CODE_DISABLE_PROJECT_RULES: "1",
      SID_CODE_PROFILE_STARTUP: "1",
      SID_CODE_PROFILE_STARTUP_DUMP: dump,
      TERM: "xterm-256color",
    },
  });
  try {
    const deadline = performance.now() + 45_000;
    while (!existsSync(dump) && performance.now() < deadline) await Bun.sleep(100);
    if (!existsSync(dump)) throw new Error("45s 内没拿到启动剖析 dump（TUI 没起来或首帧没出）");
    return JSON.parse(readFileSync(dump, "utf-8")) as Profile;
  } finally {
    proc.kill();
    await proc.exited;
    term.close();
  }
}

/** 每种配置的启动次数（取中位数） */
const RUNS = 3;

function median(xs: number[]): number {
  const a = [...xs].sort((x, y) => x - y);
  return a[Math.floor(a.length / 2)];
}

/** 把多次启动收成一个「中位数 Profile」（只保留门禁用到的两个口径） */
function medianProfile(ps: Profile[]): Profile {
  return {
    checkpoints: [{ name: "first_frame", ms: median(ps.map(firstFrame)) }],
    metrics: { max_loop_block_before_interactive: median(ps.map(maxBlock)) },
  };
}

const firstFrame = (p: Profile) => p.checkpoints.find((c) => c.name === "first_frame")?.ms ?? NaN;
const maxBlock = (p: Profile) => p.metrics.max_loop_block_before_interactive ?? NaN;

// Windows 没有 pty（Bun.Terminal 仅 POSIX）；CI 只跑 ubuntu / macos
const describeGate = process.platform === "win32" ? describe.skip : describe;

describeGate("大数据启动门禁（首帧与事件循环阻塞不随数据量增长）", () => {
  let empty: Profile;
  let large: Profile;
  let bigSession: string;
  let expiredProbe: string;
  let largeHome: string;
  let upload: Profile;
  let uploadHome: string;
  let uploadSessionDir: string;
  /**
   * 收到请求立刻回 502（与 10-22 真实失败同一状态码）。
   *
   * 不用「只挂住不响应」：维护子进程会卡在 30s 超时上一直持有单实例锁，后几轮启动的子进程
   * 抢不到锁、整轮跳过补传，门禁因此空转（第一版就是这样）。要量的阻塞（整份压缩、整份 parse）
   * 都发生在 fetch 之前，与服务端多久回包无关。
   */
  let hangServer: ReturnType<typeof Bun.serve>;
  let hangHits = 0;

  beforeAll(async () => {
    hangServer = Bun.serve({
      port: 0,
      async fetch(req) {
        hangHits++;
        await req.arrayBuffer().catch(() => {});
        return new Response("bad gateway", { status: 502 });
      },
    });
    const emptyHome = makeHome();
    largeHome = makeHome();
    ({ bigSession, expiredProbe } = populateLargeHome(largeHome));
    uploadHome = makeHome({
      // 必须显式 enabled：用户写了 trace 对象就整体覆盖默认的 {enabled:true}，
      // 不写时采集与补传都不启用（与 initTraceCollector 同口径）——第一版漏了，补传用例空转。
      trace: {
        enabled: true,
        upload: { url: `http://127.0.0.1:${hangServer.port}/traj`, token: "tok", max_retries: 1 },
      },
    });
    uploadSessionDir = populateUploadHome(uploadHome);
    // 先热一次：bun 的转译缓存会让第一次启动整体偏慢，不热的话差值方向会反过来掩盖退化
    await startOnce(makeHome());
    // 交替各跑 RUNS 次取中位数：单次 first_frame 实测有 ~250ms 的偶发离群（机器抖动），
    // 单次差值会把它当成退化或把退化抵消掉。
    const e: Profile[] = [];
    const l: Profile[] = [];
    const u: Profile[] = [];
    for (let i = 0; i < RUNS; i++) {
      e.push(await startOnce(emptyHome));
      l.push(await startOnce(largeHome));
      resetUploadState(uploadHome, uploadSessionDir);
      u.push(await startOnce(uploadHome));
      // 最后一轮不等：防空转那条用例要在它跑的过程中观察缓存与请求
      if (i < RUNS - 1) await waitMaintenanceIdle(uploadHome);
    }
    empty = medianProfile(e);
    large = medianProfile(l);
    upload = medianProfile(u);
  }, 400_000);

  afterAll(() => {
    hangServer?.stop(true);
    for (const h of homes) rmSync(h, { recursive: true, force: true });
  });

  test("两次启动都拿到了口径（防门禁空转）", () => {
    expect(Number.isFinite(firstFrame(empty))).toBe(true);
    expect(Number.isFinite(firstFrame(large))).toBe(true);
    expect(Number.isFinite(maxBlock(empty))).toBe(true);
    expect(Number.isFinite(maxBlock(large))).toBe(true);
  });

  // max_loop_block 取的是**最大值**：一段 100ms 级的扫描与空目录本来就有的 ~90ms 常数阻塞
  // 取 max 后几乎看不出来（T1 放回 collector 构造的变异就是这样漏过去的），
  // 所以首帧差值才是「首帧前多做了多少活」的主口径，阈值必须收紧。
  // 标定：修复后 +18 ~ +142ms（单次离群已被中位数吸收），C1 变异 +698ms，T1/T2 变异 +353ms。
  test("首帧：大数据比空目录慢不超过 150ms（中位数）", () => {
    const delta = firstFrame(large) - firstFrame(empty);
    console.log(
      `[gate] first_frame 空=${firstFrame(empty)} 大=${firstFrame(large)} | max_block 空=${maxBlock(empty)} 大=${maxBlock(large)}`,
    );
    expect(delta, `first_frame 空=${firstFrame(empty)}ms 大=${firstFrame(large)}ms`).toBeLessThan(
      150,
    );
  });

  // 阈值标定（2026-11-01 本机，3 轮中位数）：修复后 max_block 差值 −13 ~ +15ms；
  // 变异自证：C1 全量会话清理放回主线程 +570ms，T1/T2 放回 collector 构造 +300ms。
  test("事件循环最大阻塞：大数据比空目录多不超过 100ms", () => {
    const delta = maxBlock(large) - maxBlock(empty);
    expect(delta, `max_loop_block 空=${maxBlock(empty)}ms 大=${maxBlock(large)}ms`).toBeLessThan(
      100,
    );
  });

  test("绝对兜底：首帧 < 3s", () => {
    expect(firstFrame(large)).toBeLessThan(3000);
  });

  test("维护任务确实在子进程里跑了（过期会话被删、结果文件落盘）", async () => {
    const result = join(largeHome, "state", "maintenance-result.json");
    const deadline = performance.now() + 60_000;
    while (!existsSync(result) && performance.now() < deadline) await Bun.sleep(200);
    expect(existsSync(result), "维护子进程 60s 内没写结果文件").toBe(true);
    const r = JSON.parse(readFileSync(result, "utf-8"));
    expect(r.tasks["session-cleanup"]?.ok).toBe(true);
    expect(r.tasks["trace-prune"]?.ok).toBe(true);
    // 过期探针被子进程删掉；30 天前的巨型会话在保留期内，必须还在（也保证多轮启动都扫到它）
    expect(existsSync(expiredProbe)).toBe(false);
    expect(existsSync(bigSession)).toBe(true);
  }, 70_000);

  // U1–U4：阈值与上面两条同一套（150ms / 100ms）。修复前补传在 SessionStart 里
  // fire-and-forget，gzipSync 200MB 是秒级同步阻塞，落在首帧前后 3s 窗口内。
  test("补传（U1–U4）不在 TUI 主线程：配了上传的大 traj 目录，首帧与最大阻塞不随它增长", () => {
    const dFrame = firstFrame(upload) - firstFrame(empty);
    const dBlock = maxBlock(upload) - maxBlock(empty);
    console.log(
      `[gate] upload first_frame=${firstFrame(upload)} max_block=${maxBlock(upload)} | Δframe=${dFrame} Δblock=${dBlock}`,
    );
    expect(
      dFrame,
      `first_frame 空=${firstFrame(empty)}ms 上传=${firstFrame(upload)}ms`,
    ).toBeLessThan(150);
    expect(
      dBlock,
      `max_loop_block 空=${maxBlock(empty)}ms 上传=${maxBlock(upload)}ms`,
    ).toBeLessThan(100);
  });

  // 防空转：补传确实在子进程里跑了——压缩缓存落盘、请求打到了挂起的 server。
  // 没有这条，「上传没配上 / 补传判据把会话跳过了」也会让上一条恒绿。
  test("补传确实在维护子进程里发生（压缩缓存落盘、请求到达 server、失败已记账）", async () => {
    const attempts = join(uploadSessionDir, ".upload-attempts");
    const cache = join(uploadSessionDir, ".upload-cache", "session.traj.gz");
    const deadline = performance.now() + 60_000;
    while (
      (!existsSync(cache) || hangHits === 0 || !existsSync(attempts)) &&
      performance.now() < deadline
    ) {
      await Bun.sleep(200);
    }
    expect(existsSync(cache), "60s 内没看到压缩缓存：补传没跑或没选中这个会话").toBe(true);
    expect(hangHits, "60s 内上传请求没到达 server").toBeGreaterThan(0);
    // U4：502 被记进会话目录（下次按退避跳过，不再每次启动重来）
    expect(existsSync(attempts), "失败没写 .upload-attempts").toBe(true);
  }, 70_000);
});
