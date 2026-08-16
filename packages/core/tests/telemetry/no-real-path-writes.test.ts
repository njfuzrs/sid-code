/**
 * 遥测隔离防复发哨兵（C1）
 *
 * 背景：`recordCacheBreak()` 除了推内存环形缓冲，还会**同步落盘**到
 * ~/.sid-code/cache-breaks.jsonl（src/api/cache-detection.ts:428）。落盘是
 * fire-and-forget 且吞异常，所以调它的测试不做隔离时——测试全绿、断言全过、
 * 数据静静灌进用户真实文件。实测污染 6 万余行假数据（ts=1700000000 等测试字面量），
 * 把 `/cache --history` 冲成"尾部 20 条里一条真记录都看不到"。
 *
 * 靠"下一个人记得设环境变量"是靠不住的：机制存在（SID_CODE_CACHE_BREAKS 早在
 * cache-telemetry.ts:15 的文件头注释里写明"测试隔离用"），但三个写入方测试里
 * 只有一个用了。本哨兵把这条判据从"人记住"变成"门禁挡住"。
 *
 * 两道防线：
 *  1. 运行时契约：未设环境变量时 cacheBreaksPath() 落在配置根目录下（默认路径没被改坏），
 *     设了则严格采纳——即隔离机制本身有效。
 *  2. 静态扫描（核心）：扫 tests/ 下所有 import 了落盘类导出的文件，断言每个都声明了
 *     隔离（SID_CODE_CACHE_BREAKS 或 SID_CONFIG_DIR）。新增测试漏设 → 本测试失败并点名文件。
 *
 * ## 本门禁抓不到什么（别误以为它覆盖了全部落盘）
 *
 * 静态扫描的判据是「测试源码里 import 了落盘导出」，所以对**间接**落盘结构性无效：
 * 一个只调 `mgr.addMessage(...)` 的测试，源码里既没有 `.sid-code` 字样、也没 import
 * 任何落盘导出，但 `Manager.addMessage` 内部会对超大 tool_result 调 `persistLargeOutput`
 * 写 `sidPaths.trajectories()`。这类污染只能靠**观察副作用**抓 ——
 * 见 `tests/build/no-real-trajectory-writes-runtime.test.ts`（重定向 HOME 跑子进程，
 * 再看那个假家目录有没有被写）。两道门禁互补，不要拿一个去替代另一个。
 *
 * 2026-08-16 补充的一条反例，说明「加白名单」这个动作本身的局限：
 * `MemoryStore` / `CheckpointManager` 被补进 WRITING_EXPORTS 之后，静态扫描能抓到
 * 「测试 import 了它们却没声明隔离」，但抓不到「某个上层 API 内部 new 了它们」。
 * 白名单是**穷举式**防线，每漏一个类就多一个缺口；运行时门禁是**判据式**防线，
 * 不依赖穷举。所以扩白名单只是补当下这两个已知洞，
 * 真正的结构性覆盖靠 `tests/build/no-real-trajectory-writes-runtime.test.ts`
 * 的 SCOPE 数组（已把 memory/ 与 checkpoint/ 纳入）。
 *
 * 判据（源自 docs/bugfixes/todo/20260803-单测污染用户遥测数据-隔离缺口根治方案.md §2.4）：
 *   只要一个函数除返回值外还有「写用户家目录」这种进程外副作用，
 *   调它的测试就必须显式隔离。
 */

import { describe, test, expect, afterEach } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { cacheBreaksPath } from "@sid-code/core/telemetry/cache-telemetry.ts";
import { getSidHome } from "@sid-code/core/config/paths.ts";

/**
 * 会触发落盘的导出。import 了其中任意一个的测试文件都必须声明隔离。
 *
 * - recordCacheBreak：内存缓冲 + 落盘（cache-detection.ts:421-432）
 * - emitCacheBreakTelemetry：直接落盘（cache-telemetry.ts:50）
 * - appendUsageLedger / upsertUsageLedger / pruneUsageLedger：直接写
 *   ~/.sid-code/usage-ledger.jsonl（P3-1，2026-08-08 补齐）。此前门禁只覆盖
 *   cache-breaks，而账本是"缓存命中率/成本"的唯一跨会话事实源，被污染的后果
 *   更严重：cache-breaks 被灌假数据只是让归因视图失效，账本被灌假会让
 *   `/cache`、trace-digest、博客里所有百分比全部失真。
 *
 * - upsertSessionIndex / pruneSessionIndex：直接写 ~/.sid-code/session-index.jsonl
 *   （P0-2，2026-08-15 新增）。这个 sink 的污染后果**比账本更严重**：它存在的
 *   唯一理由是"轨迹被 LRU 删掉后指标还在"，即它是设计上**永不自动清理**的长期
 *   趋势底座。灌进去的假行会永久留在里面，且正是 release-over-release 曲线的输入。
 *
 * - MemoryStore / CheckpointManager / getCheckpointManager：**构造即落盘**的类
 *   （2026-08-16 新增）。它们与上面 7 个函数形态不同——不是"名字里带 write 的函数"，
 *   而是构造函数深处派生出真实家目录路径：
 *     · `new MemoryStore(projectRoot)` → `store.ts:298 getAutoMemPath(projectRoot)`
 *       → `memory/paths.ts:157 join(projectsRoot(), sanitizeProjectKey(root), "memory")`。
 *       注意 `projectsRoot()` 读 SID_CONFIG_DIR，**与传入的 projectRoot 无关** ——
 *       所以"把 projectRoot 指向 tmpdir"看着像隔离，实际只是把 tmpdir 路径当作项目
 *       标识哈希成目录名，照样写进真实 `~/.sid-code/projects/`。
 *     · `new CheckpointManager(sessionId)` → 写 `sidPaths.checkpoints(sessionId)`。
 *
 *   实测存量后果：`~/.sid-code/projects/` 下 2962 个 `…-sid-mem-test-<rand>` 目录、
 *   `checkpoints/` 下 4545 个 `test-session-<ts>-<rand>` 目录（约 40MB）。
 *   目录名里那串被 sanitize 的 tmpdir 路径，本身就是"测试以为自己在 tmpdir、
 *   实际写在家目录"的物证。
 *
 *   ⚠ 这两个是**按名字**能抓到的最外层入口，不代表静态扫描覆盖了它们的全部落盘路径。
 *   真正的兜底是运行时门禁（见下方"本门禁抓不到什么"）。
 *
 * 注：checkResponseForCacheBreak 刻意**不在**此列——它只做检测与归因，
 * 落盘由主循环（query/loop.ts:2453）另行调 recordCacheBreak 完成，
 * 实测调它不写盘。把它加进来会制造假阳性。
 * 同理 readUsageLedger / dedupeBySession / readSessionIndex 是纯读，不在此列；
 * buildSessionIndexEntry 是纯函数（只组装对象、不落盘），也不在此列。
 */
const WRITING_EXPORTS = [
  "recordCacheBreak",
  "emitCacheBreakTelemetry",
  "appendUsageLedger",
  "upsertUsageLedger",
  "pruneUsageLedger",
  "upsertSessionIndex",
  "pruneSessionIndex",
  "MemoryStore",
  "CheckpointManager",
  "getCheckpointManager",
] as const;

/**
 * 认可的隔离手段：专用重定向，或整体改写配置根目录。
 *
 * 注意这里是**按标记名扫描**而非按 sink 精确配对：一个测试若用了 usage-ledger
 * 的写入导出、却只设了 SID_CODE_CACHE_BREAKS，本门禁会放过它。做精确配对需要
 * 把"哪个导出对应哪个环境变量"再写一份映射，而 SID_CONFIG_DIR 同时覆盖两者，
 * 映射会立刻变成三态。当前取舍：宽判据 + preload 兜底
 *（tests/preload-isolate-sid-home.ts 把 SID_CONFIG_DIR 默认指向临时目录）。
 */
const ISOLATION_MARKERS = [
  "SID_CODE_CACHE_BREAKS",
  "SID_CODE_USAGE_LEDGER",
  "SID_CODE_SESSION_INDEX",
  "SID_CONFIG_DIR",
] as const;

describe("cacheBreaksPath 隔离契约", () => {
  const saved = process.env.SID_CODE_CACHE_BREAKS;
  afterEach(() => {
    if (saved === undefined) delete process.env.SID_CODE_CACHE_BREAKS;
    else process.env.SID_CODE_CACHE_BREAKS = saved;
  });

  test("未设环境变量时落在配置根目录下（默认路径未被改坏）", () => {
    delete process.env.SID_CODE_CACHE_BREAKS;
    const p = cacheBreaksPath();
    expect(p.startsWith(getSidHome())).toBe(true);
    expect(p.endsWith("cache-breaks.jsonl")).toBe(true);
  });

  test("设了环境变量则严格采纳（重定向真的生效）", () => {
    process.env.SID_CODE_CACHE_BREAKS = "/tmp/sentinel-probe/cache-breaks.jsonl";
    expect(cacheBreaksPath()).toBe("/tmp/sentinel-probe/cache-breaks.jsonl");
  });

  test("空串 / 纯空白视为未设置，回落默认路径（避免误重定向到空路径）", () => {
    process.env.SID_CODE_CACHE_BREAKS = "   ";
    expect(cacheBreaksPath().startsWith(getSidHome())).toBe(true);
  });
});

describe("防复发哨兵：扫描 tests/ 下所有落盘调用方", () => {
  /** 递归收集 tests/ 下所有 .test.ts（排除本哨兵自身——它 import 的是路径函数不是落盘函数） */
  function collectTestFiles(dir: string, acc: string[] = []): string[] {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      const st = statSync(full);
      if (st.isDirectory()) collectTestFiles(full, acc);
      else if (entry.endsWith(".test.ts") && !full.endsWith("no-real-path-writes.test.ts")) {
        acc.push(full);
      }
    }
    return acc;
  }

  test("每个 import 了落盘类导出的测试文件都声明了隔离", () => {
    // P1-2 分包后测试不再只有一个根：各 package 内 tests/ + 仓库级根 tests/。
    // 这里必须扫**全部**测试根，否则哨兵只覆盖本包，新增的越界调用方在别的包里
    // 会静默漏过 —— 而 files.length 断言仍然通过（本包文件数就够 100），
    // 正是本文件下方警告的"目录结构变动导致门禁静默变成永远通过"。
    const repoRoot = join(import.meta.dir, "..", "..", "..", "..");
    const testRoots = [
      join(repoRoot, "packages", "core", "tests"),
      join(repoRoot, "packages", "cli", "tests"),
      join(repoRoot, "packages", "shared", "tests"),
      join(repoRoot, "packages", "tui-renderer", "tests"),
      join(repoRoot, "tests"),
    ];
    const files = testRoots.flatMap((r) => collectTestFiles(r));
    // 断言扫描面非空——目录结构变动导致空扫时，这条门禁会静默变成"永远通过"
    expect(files.length).toBeGreaterThan(100);

    const violations: Array<{ file: string; usedExport: string }> = [];
    let scanned = 0;

    for (const file of files) {
      const text = readFileSync(file, "utf-8");
      const used = WRITING_EXPORTS.find((name) => new RegExp(`\\b${name}\\b`).test(text));
      if (!used) continue;
      scanned++;
      // 判据必须是「真的碰了 process.env.<MARKER>」，不能是「文本里出现过这个名字」。
      // 反向验证实测：把某文件的隔离赋值全部改名后，本门禁**仍然通过** —— 因为该文件
      // 的注释里提到了变量名，`text.includes(marker)` 就命中了。注释不隔离任何东西，
      // 而恰恰是"讲解隔离规则"的文件最容易在注释里写下变量名，形成系统性假阴性。
      const isolated = ISOLATION_MARKERS.some((marker) =>
        new RegExp(`process\\.env\\.${marker}\\b`).test(text),
      );
      if (!isolated) {
        violations.push({ file: file.replace(repoRoot + "/", ""), usedExport: used });
      }
    }

    // 已知调用方至少 8 个（cache-detection / clear-resets-cache-state /
    // cache-telemetry-rotation / usage-ledger 四个遥测类，
    // + memory/store、tool/memory、checkpoint/manager、checkpoint/eviction 等构造即落盘类）。
    // 若正则或导出名漂移导致一个都匹配不上，这条会先失败，而不是让门禁空转成绿灯。
    //
    // ⚠ 这个下限**刻意低于实测值**（实测 11）：写成精确相等会让「新增一个已正确隔离的
    // 测试」也把门禁弄红，逼人来改数字，最后被人干脆删掉这条断言。它要防的只是
    // "一个都没匹配上"这种空转成绿灯，不是锁定当前文件数。
    expect(scanned).toBeGreaterThanOrEqual(8);

    if (violations.length > 0) {
      const detail = violations
        .map((v) => {
          // 按用到的导出指出**对应的**落盘文件与环境变量。写死 cache-breaks 会让
          // 账本类违规拿到一条误导的修复指引（改错变量名，门禁照样红）。
          // 三个 sink 各有自己的环境变量，指错一个的后果是"照着提示改完门禁照样红"
          const sinkAndMarker = v.usedExport.includes("UsageLedger")
            ? ["usage-ledger.jsonl", "SID_CODE_USAGE_LEDGER"]
            : v.usedExport.includes("SessionIndex")
              ? ["session-index.jsonl", "SID_CODE_SESSION_INDEX"]
              : // MemoryStore / Checkpoint 两类没有专用重定向变量，只能整体改配置根目录。
                // 指一个不存在的 SID_CODE_MEMORY_DIR 会让人白改一轮、门禁照样红。
                v.usedExport === "MemoryStore"
                ? ["projects/<项目哈希>/memory/", "SID_CONFIG_DIR"]
                : v.usedExport.includes("Checkpoint")
                  ? ["checkpoints/<sessionId>/", "SID_CONFIG_DIR"]
                  : ["cache-breaks.jsonl", "SID_CODE_CACHE_BREAKS"];
          const [sink, marker] = sinkAndMarker;
          // 专用变量与 SID_CONFIG_DIR 相同时不重复印两遍（"需设 SID_CONFIG_DIR 或
          // SID_CONFIG_DIR" 读起来像提示自身出了 bug，会让人怀疑整条指引的可信度）。
          const how = marker === "SID_CONFIG_DIR" ? marker : `${marker} 或 SID_CONFIG_DIR`;
          return `  - ${v.file}（用了 ${v.usedExport} → 写 ~/.sid-code/${sink}，需设 ${how}）`;
        })
        .join("\n");
      throw new Error(
        `以下测试会往用户真实的 ~/.sid-code/ 遥测文件写数据：\n${detail}\n\n` +
          `修法：在 beforeEach/beforeAll 里把对应环境变量指向 mkdtempSync 的临时目录，` +
          `afterEach/afterAll **存/恢复原值**（不要无条件 delete——bun test 同进程跑多文件，` +
          `delete 会把别的文件或 preload 的兜底一起抹掉）。\n` +
          `参考 tests/telemetry/cache-telemetry-rotation.test.ts:38 与 usage-ledger.test.ts。`,
      );
    }
  });
});
