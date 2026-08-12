/**
 * 埋点接线防复发哨兵（缺陷清单 P0-1 验收判据第 3 条）
 *
 * 背景：这块债的成因不是「代码写错」，而是**代码完整、测试通过、调用点为零**。
 * `src/analytics/` 1113 行（零依赖事件 API、五阶段过滤 Sink、三个 exporter、
 * 磁盘缓存、退避重试、隐私双通道、采样、killswitch、元数据富化、用户分桶）
 * 长期只服务 1 个埋点（app.ts 的 startup_timing）；`sanitize.ts` 三个脱敏函数、
 * `privacy.ts` 的「提取/检测」两半、`isEssentialTrafficOnly` 全部零消费者。
 *
 * 单测全绿也发现不了这件事——**没有调用点不是断言能失败的形态**。所以补埋点必须
 * 同时装门禁，否则半年后重演（项目里已有两笔同构的债：「四环防线建好零触发」、
 * 「团队记忆能写不能读」）。
 *
 * 四道防线，每道针对一个具体的退化路径：
 *  1. 事件名双向对账：EVENT_NAMES 里的名字必须有生产调用点（防死代码），
 *     生产调用点用的名字必须在表里（防绕过常量表硬编码字符串）。
 *  2. 埋点密度下限：五条核心漏斗的门面调用点总数不得低于阈值（防被整批删回去）。
 *  3. 脱敏强制：业务代码不得绕过门面直调 logEvent（绕过 = 工具名与路径裸传）。
 *  4. 脱敏与门控函数非零消费者：sanitize.ts / privacy.ts / privacy-level.ts 的
 *     关键导出必须真的有人调（这是它们当初变成死代码的那个形态）。
 *
 * 判据参照 tests/telemetry/no-real-path-writes.test.ts：静态扫描型门禁必须
 * 自证「扫描面非空」，否则目录漂移会让门禁静默退化成永远通过的绿灯。
 */

import { describe, test, expect } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { EVENT_NAMES } from "@sid-code/core/analytics/events.ts";

/**
 * 生产源码根目录（P2-2 分包后是 4 个包，不再是单一 `src/`）。
 *
 * **tui-renderer 刻意不在列**：它是 vendor 进来的 ink fork（原 `src/ink`），
 * 不参与埋点约定 —— 与分包前 `collectSourceFiles` 跳过 `ink` 目录等价。
 *
 * ⚠️ 这个清单漏一个包 = 门禁少扫一片代码，且**不会报错**。
 * 下面 `expect(sources.length).toBeGreaterThan(200)` 就是为此存在的防空转断言：
 * 分包时它真的红了一次（`src/` 被搬空后只剩 1 个文件），逼出了这处修正。
 * 加包时记得同步这里。
 */
const PKG_SRC_ROOTS = ["shared", "core", "cli"].map((p) =>
  join(import.meta.dir, "..", "..", "..", "..", "packages", p, "src"),
);

/** 门面模块自身——扫生产调用点时要排除，它是定义方不是消费方 */
const FACADE_REL = join("analytics", "events.ts");

/** 递归收集某个包 src/ 下所有 .ts */
function collectSourceFiles(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) {
      collectSourceFiles(full, acc);
    } else if (entry.endsWith(".ts")) {
      acc.push(full);
    }
  }
  return acc;
}

/**
 * 读取全部生产源码文本。
 *
 * `rel` 相对**各包自己的 src/**（如 `analytics/events.ts`），与分包前口径一致 ——
 * 这样 FACADE_REL / CONTRACTS.owner 这些「模块内相对路径」的比较无需改动。
 *
 * ⚠️ 必须用 readFileSync 而非 grep/rg：app.ts 含 NUL 字节，会让 grep 把整个文件
 * 判成 binary 并**静默跳过**（记忆「app.ts 含 NUL 字节致 grep 静默漏报」）。
 * 门禁若靠 shell grep 实现，会在这个文件上假阴性。
 */
function readAllSources(): Array<{ rel: string; text: string }> {
  return PKG_SRC_ROOTS.flatMap((root) =>
    collectSourceFiles(root).map((full) => ({
      rel: full.slice(root.length + 1),
      text: readFileSync(full, "utf-8"),
    })),
  );
}

/** 门面导出的 emit 函数名——生产埋点只允许经由它们 */
const FACADE_EMITTERS = [
  "logToolCall",
  "logToolSuccess",
  "logToolFailure",
  "logPermissionPrompt",
  "logPermissionAllow",
  "logPermissionDeny",
  "logContextCompact",
  "logContextCompactSkipped",
  "logCommandInvoke",
  "logCommandRejected",
  "logError",
] as const;

describe("埋点接线哨兵：事件名双向对账", () => {
  test("EVENT_NAMES 里每个事件名都有对应的门面 emit 函数（无孤立常量）", () => {
    // 门面在 core 包（analytics 归 core）。走 readAllSources 取而不是拼绝对路径：
    // 包归属将来若变动，这里自动跟着走，不会再指向一个不存在的目录。
    const facadeEntry = readAllSources().find((s) => s.rel === FACADE_REL);
    if (!facadeEntry) throw new Error(`未找到埋点门面模块 ${FACADE_REL}（分包路径是否变了？）`);
    const facade = facadeEntry.text;
    const orphans: string[] = [];
    for (const [key, name] of Object.entries(EVENT_NAMES)) {
      // 常量必须在门面里被 emit(...) 消费，而不是只定义不用
      if (!new RegExp(`EVENT_NAMES\\.${key}\\b`).test(facade)) {
        orphans.push(`${key} ("${name}")`);
      }
    }
    expect(orphans).toEqual([]);
  });

  test("门面的每个 emit 函数都有生产调用点（防再次退化成死代码）", () => {
    const sources = readAllSources();
    expect(sources.length).toBeGreaterThan(200); // 扫描面自证非空

    const uncalled: string[] = [];
    for (const fn of FACADE_EMITTERS) {
      const called = sources.some(
        ({ rel, text }) => rel !== FACADE_REL && new RegExp(`\\b${fn}\\(`).test(text),
      );
      if (!called) uncalled.push(fn);
    }

    // 这正是本批修复之前的状态：函数写好了、类型对了、没人调。
    expect(uncalled).toEqual([]);
  });

  test("五条核心漏斗各自都有生产调用点", () => {
    const sources = readAllSources().filter(({ rel }) => rel !== FACADE_REL);
    const funnels: Record<string, readonly string[]> = {
      工具: ["logToolCall", "logToolSuccess", "logToolFailure"],
      权限: ["logPermissionPrompt", "logPermissionAllow", "logPermissionDeny"],
      上下文: ["logContextCompact", "logContextCompactSkipped"],
      命令: ["logCommandInvoke", "logCommandRejected"],
      错误: ["logError"],
    };

    const missing: string[] = [];
    for (const [funnel, fns] of Object.entries(funnels)) {
      const anyCalled = fns.some((fn) =>
        sources.some(({ text }) => new RegExp(`\\b${fn}\\(`).test(text)),
      );
      if (!anyCalled) missing.push(funnel);
    }
    expect(missing).toEqual([]);
  });
});

describe("埋点接线哨兵：密度下限", () => {
  test("门面调用点总数不低于 30（缺陷清单验收判据 1 的等价形态）", () => {
    const sources = readAllSources().filter(({ rel }) => rel !== FACADE_REL);
    let total = 0;
    for (const { text } of sources) {
      for (const fn of FACADE_EMITTERS) {
        total += text.match(new RegExp(`\\b${fn}\\(`, "g"))?.length ?? 0;
      }
    }

    // 文档原文写的是 `rg -a -c "logEvent\\(" src/ ≥ 30`。本实现刻意不让业务代码直调
    // logEvent（那样脱敏就无法强制，见门面顶部注释），所以按字面跑那条命令数字很低，
    // 但埋点密度这个**意图**不变，在此以门面调用点计数落地同一条判据。
    expect(total).toBeGreaterThanOrEqual(30);
  });
});

describe("埋点接线哨兵：脱敏不可绕过", () => {
  test("业务代码不得直调 logEvent（必须走门面以强制脱敏）", () => {
    const sources = readAllSources();

    /**
     * 允许直调 logEvent 的白名单：
     *  - analytics/index.ts：logEvent 的定义方
     *  - analytics/sink.ts：AnalyticsSink 接口的方法名恰好也叫 logEvent
     *  - analytics/events.ts：门面自身，唯一合法的调用方
     *  - app.ts：历史遗留的 startup_timing（纯数字 duration_ms，不含工具名/路径，
     *    无脱敏风险）。保留它而非强行搬进门面，是因为它不属于五条漏斗中任何一条，
     *    搬进去反而会让门面的语义变成"什么都收"。
     */
    const ALLOWED = [
      join("analytics", "index.ts"),
      join("analytics", "sink.ts"),
      FACADE_REL,
      "app.ts",
    ];

    const violations: string[] = [];
    for (const { rel, text } of sources) {
      if (ALLOWED.includes(rel)) continue;
      if (/\blogEvent\(/.test(text)) violations.push(rel);
    }

    if (violations.length > 0) {
      throw new Error(
        `以下文件直调了 logEvent，绕过了 analytics/events.ts 的强制脱敏：\n` +
          violations.map((f) => `  - src/${f}`).join("\n") +
          `\n\n工具名含用户私有 MCP 服务名、文件路径含用户目录结构，裸传即泄露。` +
          `\n请改用门面函数（logToolCall / logCommandInvoke / …），` +
          `或在门面里新增一个已接好脱敏的 emit 函数。`,
      );
    }
  });
});

describe("埋点接线哨兵：脱敏与隐私门控函数非零消费者", () => {
  /**
   * 这三组导出当初全部是「写好了没人调」。清单里 P1-6 / P1-7 / P1-8 就是它们。
   * 逐个断言有外部消费者——退化回零调用时本测试点名失败。
   */
  const CONTRACTS: Array<{ owner: string; exports: readonly string[]; why: string }> = [
    {
      owner: join("analytics", "sanitize.ts"),
      exports: ["sanitizeToolName", "safeFileExtension", "mcpToolDetailsForAnalytics"],
      why: "P1-6：工具名/路径脱敏。零消费者时补埋点会把工具名和路径裸传出去。",
    },
    {
      owner: join("analytics", "privacy.ts"),
      exports: ["stripProtectedFields", "extractProtectedFields", "hasProtectedFields"],
      why: "P1-7：_PROTECTED_ 双通道。此前只有「剥离」半边在用，「提取/检测」空转。",
    },
    {
      owner: join("analytics", "privacy-level.ts"),
      exports: ["isTelemetryDisabled", "isEssentialTrafficOnly", "shouldLoadRemoteConfig"],
      why: "P1-8：三级隐私。essential-traffic 的判定函数此前零调用，绕过 sink 的外发通道不受门控。",
    },
  ];

  for (const { owner, exports, why } of CONTRACTS) {
    test(`${owner} 的关键导出都有外部消费者`, () => {
      const sources = readAllSources();
      expect(sources.length).toBeGreaterThan(200);

      const dead: string[] = [];
      for (const name of exports) {
        const consumed = sources.some(
          ({ rel, text }) => rel !== owner && new RegExp(`\\b${name}\\b`).test(text),
        );
        if (!consumed) dead.push(name);
      }

      if (dead.length > 0) {
        throw new Error(`src/${owner} 的以下导出退回零消费者：${dead.join(", ")}\n${why}`);
      }
    });
  }
});
