/**
 * 门禁 · 轨迹上传的退出路径接线
 *
 * 缺陷形态（2026-09-16 实测本机 52 个交互式会话）：
 *   - 上传成功 0/52，`.uploaded` 标记 0/52；
 *   - `events.jsonl` 里有 SessionEnd 的只有 13/52，且**全是 reason=error**（崩溃兜底路径）；
 *   - `messages.json`（handleSessionEnd 在上传**之前**写）0/52 —— 连上传前的落盘都没走到；
 *   - `heartbeat.txt`（SessionEnd 末尾会删）残留 52/52 —— 独立佐证收尾从未完成。
 *
 * 也就是说「退出时上传」这条唯一自动路径在日常交互里**基本不执行**。两个成因：
 *   1. **SIGHUP 完全没有处理**（修复前全仓检索 0 命中）：关终端 / SSH 断连时进程被默认
 *      处置直接终止，SessionEnd 一次都不触发，连那 1.2s 都没有；
 *   2. 各退出路径给 SessionEnd 的预算是 1.2s，而一次上传要 10s 量级 ——
 *      信号路径 race 完还主动 `process.exit()`，fetch 必然被杀在半路。
 *      而 collector 里那句「超时后上传继续在后台运行」在这些路径上是**假的**，
 *      它让排查者以为数据最终会传上去，是这个 bug 藏了这么久的原因之一。
 *
 * 修法不是放宽超时（那是用体验换正确性，且挡不住 kill -9），而是：
 *   退出路径只保证**本地落盘**（实测 ~30ms：traj 重建 7.5ms + digest 18ms），
 *   上传交给下次启动的补传（backfill.ts，判据是 `.uploaded` 缺失，与退出路径解耦）。
 *
 * 本文件是静态门禁：拦「有人把 SIGHUP 删掉」「有人把某条退出路径的预算声明去掉」。
 * 行为层由 packages/core/tests/trace/{backfill,uploader-queue}.test.ts 覆盖。
 */

import { describe, test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const APP_SRC = readFileSync(join(import.meta.dir, "../../src/app.ts"), "utf-8");
const CLI_SRC = readFileSync(join(import.meta.dir, "../../src/cli.ts"), "utf-8");
const COLLECTOR_SRC = readFileSync(
  join(import.meta.dir, "../../../core/src/trace/collector.ts"),
  "utf-8",
);
const INIT_HELPERS_SRC = readFileSync(
  join(import.meta.dir, "../../../core/src/query/init-helpers.ts"),
  "utf-8",
);

describe("SIGHUP 必须被处理（关终端 / SSH 断连）", () => {
  test("app.ts 注册了 SIGHUP 处理器", () => {
    expect(APP_SRC).toContain('process.once("SIGHUP"');
  });

  test("SIGHUP 走的是与 SIGINT/SIGTERM 同一个 onSignal（而不是另写一份会漂移的逻辑）", () => {
    expect(APP_SRC).toContain('void onSignal("SIGHUP")');
  });

  test("SIGHUP 有自己的退出码 129（128+signum 惯例），不与 SIGTERM 的 143 混用", () => {
    expect(APP_SRC).toMatch(/signal === "SIGHUP" \? 129/);
  });
});

describe("每条退出路径都必须显式声明上传预算", () => {
  test("四条退出路径各有一次 setUploadBudgetMs（信号 / quit×2 / 正常退出）", () => {
    const hits = APP_SRC.match(/setUploadBudgetMs\?\.\(/g) ?? [];
    // 精确锁 4：少于 4 说明有路径漏了预算声明（会退回"等 10s 却被 1.2s 杀掉"的老问题）；
    // 多于 4 说明新增了退出路径 —— 那也需要人来确认它的预算取值是否正确。
    expect(hits).toHaveLength(4);
  });

  test("headless / 评测路径**不**归零预算：那是唯一一直上传成功的路径，不能被这次修复弄坏", () => {
    // runHeadless / runHeadlessSDK 的 fireSessionEndEvent 前后不应出现预算归零。
    for (const marker of [
      "[runHeadless] SessionEnd hook 失败",
      "[runHeadlessSDK] SessionEnd hook 失败",
    ]) {
      const idx = APP_SRC.indexOf(marker);
      expect(idx).toBeGreaterThan(0);
      // 往前 1200 字符内不得有归零调用
      const before = APP_SRC.slice(Math.max(0, idx - 1200), idx);
      expect(before).not.toContain("setUploadBudgetMs");
    }
  });
});

describe("collector 的上传预算与那句误导性注释", () => {
  test("上传等待用的是可配预算，不再是硬编码 10_000", () => {
    expect(COLLECTOR_SRC).toContain("const budgetMs = this.uploadBudgetMs");
    // 原实现：setTimeout(() => resolve(null), 10_000)
    expect(COLLECTOR_SRC).not.toMatch(/resolve\(null\)\), 10_000\)/);
  });

  test("预算为 0 时不发起上传（发了也会被 process.exit 杀在半路，只是白建连接）", () => {
    expect(COLLECTOR_SRC).toContain("退出路径不等待上传，已交由下次启动补传");
  });

  test("那句在退出路径上不成立的注释不再作为事实陈述存在", () => {
    // ⚠️ 判据必须锁**原注释整行**，不能只搜「超时后上传继续在后台运行」这个短语 ——
    // 修复后的注释刻意引用了这句话来说明它是假的（"注释还写着…在信号路径上那句话是假的"），
    // 只搜短语会把这段"辟谣"文本误判成缺陷本体，于是门禁逼着人删掉解释。
    expect(COLLECTOR_SRC).not.toContain("// 最多等 10 秒，超时后上传继续在后台运行");
    // 反向锁：必须留有说明它为何不成立的文字，否则下一个人会把它当真
    expect(COLLECTOR_SRC).toContain("在信号/退出路径上那句话是假的");
  });

  test("setUploadBudgetMs 对非法值归一到 0（不接受 NaN/负数把预算变成永久等待）", () => {
    expect(COLLECTOR_SRC).toContain("Number.isFinite(ms) && ms > 0 ? ms : 0");
  });
});

describe("启动补传的触发点", () => {
  test("由 collector 在 SessionStart 触发（那里才有 resume 归一后的权威 session id）", () => {
    expect(COLLECTOR_SRC).toContain(
      "backfillPendingSessions({ currentSessionId: traceSessionId })",
    );
  });

  test("init-helpers 刻意不触发补传，并写明了原因（避免有人拿进程 id 当护栏）", () => {
    expect(INIT_HELPERS_SRC).not.toContain("backfillPendingSessions(");
    expect(INIT_HELPERS_SRC).toContain("权威 trace session id");
  });

  test("补传是 fire-and-forget 且带 catch：绝不阻塞或炸掉会话启动", () => {
    const idx = COLLECTOR_SRC.indexOf("backfillPendingSessions({ currentSessionId");
    expect(idx).toBeGreaterThan(0);
    // 判据是「.catch 出现在 .then 之后、且在同一条链上」，不锁字符距离 ——
    // 原来卡 700 字符，加了积压 WARN 的注释就红了，而那是内容变化不是缺陷。
    const thenAt = COLLECTOR_SRC.indexOf(".then(", idx);
    const catchAt = COLLECTOR_SRC.indexOf(".catch(", idx);
    expect(thenAt).toBeGreaterThan(idx);
    expect(catchAt).toBeGreaterThan(thenAt);
    // 链条中间不应出现下一个语句的分号收尾（粗略确认仍是同一条 Promise 链）
    expect(COLLECTOR_SRC.slice(catchAt, catchAt + 120)).toContain("getLogger().warn");
    expect(COLLECTOR_SRC.slice(Math.max(0, idx - 200), idx)).toContain("void this.uploader");
  });
});

describe("两个死配置必须真的接上", () => {
  test("queueScanIntervalMs → startQueueScan", () => {
    expect(INIT_HELPERS_SRC).toContain("startQueueScan(traceConfig.upload.queueScanIntervalMs");
  });

  test("maxQueueRetries 透传给 UploadManager（uploader 侧不再硬编码 50）", () => {
    expect(INIT_HELPERS_SRC).toContain("maxQueueRetries: traceConfig.upload.maxQueueRetries");
    expect(CLI_SRC).toContain("maxQueueRetries: traceUpload.maxQueueRetries");
  });
});

describe("--upload-traces 必须说真话", () => {
  test("不再只打印「处理完成」，而是输出三类实际计数", () => {
    expect(CLI_SRC).not.toMatch(/console\.log\("处理完成"\)/);
    expect(CLI_SRC).toContain("formatQueueResult");
  });

  test("除队列外还跑一次补传扫描（队列为空≠没有待传会话）", () => {
    expect(CLI_SRC).toContain("正在扫描未上传的历史会话");
    expect(CLI_SRC).toContain("backfillPendingSessions(");
  });

  test("因目录已清理而丢弃的条目会被明确点出（这是本地+云端双丢的唯一可见信号）", () => {
    expect(CLI_SRC).toContain("droppedMissingFile");
  });
});
