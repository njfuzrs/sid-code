/**
 * PR10 哨兵：超时阶梯的**谓词**与数值都不许退回同层复制
 *
 * ## 这个文件拦的是什么
 *
 * 改造前六个阈值默认全是 300s，其中三个（fallback 无进展上限 / watchdog /
 * fetchAbsolute）**谓词完全相同** —— 都是"从某个起点起的绝对计时"。
 * 三份同谓词副本的可靠性等于一层，而归因难度是一层的三倍。
 *
 * 所以这里有两类断言，**后者比前者重要**：
 *   · 数值哨兵：严格递增、无同值、相邻间距 ≥ 120s；
 *   · 谓词哨兵：每一档的判据必须仍然不同 —— 数值哨兵拦不住
 *     "三个绝对计时器错开成 240/480/600"这种伪阶梯。
 *
 * fix_type: case_design
 */

import { describe, test, expect, afterEach } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";
import {
  DEFAULTS,
  PROVIDER_STREAM_DEFAULTS,
  resolveProviderStreamTimeouts,
  resolveLoopTimeouts,
  registerNetworkTimeoutSettings,
  registerPerModelStreamTimeouts,
  __resetNetworkTimeoutSettingsForTest,
  __resetPerModelStreamTimeoutsForTest,
} from "@sid-code/core/config/network-profile.ts";
import { LIFECYCLE_PRESETS } from "@sid-code/core/llm/stream-lifecycle.ts";

const ENV_KEYS = [
  "SID_CODE_IDLE_TIMEOUT_MS",
  "SID_CODE_CONTENT_PROGRESS_TIMEOUT_MS",
  "SID_CODE_FETCH_ABSOLUTE_TIMEOUT_MS",
  "SID_CODE_OPENAI_OVERALL_TIMEOUT_MS",
] as const;

afterEach(() => {
  for (const k of ENV_KEYS) delete process.env[k];
  delete process.env.SID_CODE_FALLBACK_STREAM_TIMEOUT_MS;
  __resetNetworkTimeoutSettingsForTest();
  __resetPerModelStreamTimeoutsForTest();
});

describe("PR10 数值哨兵 — 阶梯严格递增、间距足够", () => {
  test("档① < 档② < overall < 档③（单轮硬顶），且相邻间距 ≥ 120s", () => {
    // PR14：`fallback` 与 `watchdog` 两档补进这张表。
    //
    // ⚠️ 它们此前**不在**表里，而那正是缺陷能活下来的原因：两层同为 720s 且同谓词，
    // 而"严格递增 + 间距 ≥120s"这个自检结构性地看不到没被列入的层。
    // 教训是通用的 —— 这类防漂移哨兵红了要**补清单，而不是删断言**。
    const ladder = [
      ["idle（档①字节级）", PROVIDER_STREAM_DEFAULTS.idleTimeoutMs],
      ["content-progress（档②事件级）", PROVIDER_STREAM_DEFAULTS.contentProgressTimeoutMs],
      ["fallback 无进展上限（attempt 级）", DEFAULTS.fallbackStreamTimeoutMs],
      ["watchdog 无进展上限（外层复核）", DEFAULTS.watchdogNoProgressMs],
      ["overall（②的请求级软兜底）", PROVIDER_STREAM_DEFAULTS.overallTimeoutMs],
      ["maxTurnDuration（档③单轮硬顶）", DEFAULTS.maxTurnDurationMs],
    ] as const;
    for (let i = 1; i < ladder.length; i++) {
      const [prevName, prev] = ladder[i - 1];
      const [name, cur] = ladder[i];
      // 同值 = 伪阶梯（这正是改造前的形态：六项默认全 300s）。
      expect(cur, `${name} 必须严格大于 ${prevName}`).toBeGreaterThan(prev);
      // 120s 下限：间距太小时两档会在同一次故障里几乎同时开枪，
      // 归因退化成"看得见的那层背锅"（实测过一次 70ms 间隔的掩盖）。
      expect(cur - prev, `${name} 与 ${prevName} 间距应 ≥ 120s`).toBeGreaterThanOrEqual(120_000);
    }
  });

  test("外层 watchdog 比 provider 层档② 更宽（信息更少的一层不该更激进）", () => {
    // watchdog 是远端观察者，读的是 provider 广播的快照，掌握的信息严格更少。
    // 它更激进就会抢在 provider 判定前开枪，且它的记录里没有"哪一档、哪个阈值"。
    expect(DEFAULTS.watchdogNoProgressMs).toBeGreaterThan(
      PROVIDER_STREAM_DEFAULTS.contentProgressTimeoutMs,
    );
  });

  test("PR14：fallback 层与 watchdog 层不同值（此前同为 720s 且同谓词）", () => {
    // 这是 PR14 的核心断言。两层在 PR2 之后**谓词相同**（都读"距上次内容进展多久"），
    // 同值时会几乎同时开枪 —— 先到的那层背全部锅，而"先到"只是几十毫秒的偶然。
    // 实测过一次 70ms 间隔的掩盖，直接把上一轮排查方向带偏。
    expect(
      DEFAULTS.fallbackStreamTimeoutMs,
      "fallback 与 watchdog 同值即回退到伪阶梯（PR14 拆开的正是这一对）",
    ).not.toBe(DEFAULTS.watchdogNoProgressMs);
    // 方向也要钉住：内层（信息更多）先判，外层复核后判。
    expect(DEFAULTS.watchdogNoProgressMs).toBeGreaterThan(DEFAULTS.fallbackStreamTimeoutMs);
  });

  test("PR14：fallback 那层能被独立调，不随 watchdog 一起动", () => {
    // 回落 watchdogNoProgressMs 会让"用户只调了 watchdog"变成"两层一起动"，
    // 同值同谓词的老形态就悄悄回来了 —— 且没有任何报错。
    registerNetworkTimeoutSettings({ watchdogNoProgressMs: 999_000 });
    const t = resolveLoopTimeouts({ network: { watchdogNoProgressMs: 999_000 } });
    expect(t.watchdogNoProgressMs).toBe(999_000);
    expect(t.fallbackStreamTimeoutMs, "只调 watchdog 时 fallback 那层不该跟着变").toBe(
      DEFAULTS.fallbackStreamTimeoutMs,
    );
  });

  test("PR14：fallback.ts 的兜底常量也指向新字段（未注入路径不能留旧形态）", () => {
    // 生产路径由 app.ts 注入，但直接 `new ModelFallback()`（测试 / SDK）走兜底常量。
    // 只改注入点会让兜底路径仍是旧的同值形态 —— 那正是回归最容易漏掉的地方。
    const src = readFileSync(join(import.meta.dir, "../../src/llm/fallback.ts"), "utf8");
    expect(src).toContain("NETWORK_DEFAULTS.fallbackStreamTimeoutMs");
    expect(src).not.toContain("DEFAULT_STREAM_TIMEOUT_MS = NETWORK_DEFAULTS.watchdogNoProgressMs");
  });

  test("PR14：app.ts 注入的是独立字段，不是 watchdog", () => {
    const src = readFileSync(join(import.meta.dir, "../../../cli/src/app.ts"), "utf8");
    expect(src).toContain("streamTimeoutMs: fallbackNetTimeouts.fallbackStreamTimeoutMs");
  });

  test("单轮硬顶容得下若干次跑满窗口的重试（否则放宽超时反而把重试关死）", () => {
    // fallback 的 S3 判据：剩余预算 <= 退避 + MIN_USEFUL_ATTEMPT 时停止重试。
    // 所以档②/watchdog 一放宽，**每次 attempt 能烧掉的时间上限**跟着涨，
    // 单轮硬顶不动就会在第 N 次退避前把重试预算判死 —— 放宽超时是为了保成功，
    // 结果把保成功的另一半（重试）关掉了。
    //
    // 判据取 3 次 attempt 而不是 `maxTimeoutRetries + 1`：
    // 后者（11 次跑满 720s ≈ 152min）不是要保障的目标 —— S3 在预算不足时
    // 停止重试并转非流式降级/换模型是**设计行为**，不是缺陷。真正要防的是
    // "连头几次重试都塞不进单轮预算"，那才叫阶梯被架空。
    const ATTEMPTS_TO_FIT = 3;
    const needed =
      ATTEMPTS_TO_FIT * DEFAULTS.watchdogNoProgressMs +
      (ATTEMPTS_TO_FIT - 1) * DEFAULTS.retryBackoffMaxMs;
    expect(
      DEFAULTS.maxTurnDurationMs,
      `单轮硬顶 ${DEFAULTS.maxTurnDurationMs}ms 装不下 ${ATTEMPTS_TO_FIT} 次跑满窗口的 attempt` +
        `（需 ${needed}ms）—— 放宽了超时却把重试预算判死，等于只做了一半`,
    ).toBeGreaterThan(needed);
  });
});

describe("PR10 谓词哨兵 — 各档判据必须不同（数值哨兵拦不住的那类退化）", () => {
  const openaiSrc = readFileSync(join(import.meta.dir, "../../src/llm/openai.ts"), "utf8");
  const lifecycleSrc = readFileSync(
    join(import.meta.dir, "../../src/llm/stream-lifecycle.ts"),
    "utf8",
  );
  const fallbackSrc = readFileSync(join(import.meta.dir, "../../src/llm/fallback.ts"), "utf8");

  test("档①的判据是「reader 是否 settle」——字节级，不是挂钟", () => {
    // 形态：idle 定时器与 reader.read() 竞速；read 一回来就 clear。
    expect(openaiSrc).toContain("const readPromise = reader.read()");
    expect(openaiSrc).toContain("Promise.race(racers)");
  });

  test("档②的判据是「有没有有效内容」——reasoning 计入进展", () => {
    // 这一条是整轮排查的支点：GLM 长思考只吐 reasoning_content，
    // 若它不计入进展，健康的长思考流会被档② 杀掉。
    expect(openaiSrc).toContain("hasContent || hasToolCalls || hasReasoning || finishReason");
    // lifecycle 侧的等价物：由 provider 传入的 isContentProgress 回调决定。
    expect(lifecycleSrc).toContain("isContentProgress");
  });

  test("fallback 那层的判据是「距上次内容进展多久」，不是「这次 attempt 跑了多久」", () => {
    // 回归拦截：PR2 把这层从绝对计时改成感知进展。若有人改回
    // "attempt 边界才重排"，本断言不一定能拦住——所以同时钉住"续命时不重建 controller"
    // 这个结构事实（renewStreamTimeout 只 clear+start，不 new AbortController）。
    const renewIdx = fallbackSrc.indexOf("const renewStreamTimeout");
    expect(renewIdx).toBeGreaterThan(-1);
    const renewBody = fallbackSrc.slice(renewIdx, renewIdx + 500);
    expect(renewBody).not.toContain("new AbortController()");
  });

  test("overall 层是唯一「不因事件重置」的一档（其余各档都必须可续命）", () => {
    expect(lifecycleSrc).toContain("不因任何事件重置");
    // 且它仍然扣休眠：绝对上限说的是业务时间的上限，机器睡觉不是业务时间。
    expect(lifecycleSrc).toContain("overallDeadline");
  });

  test("已默认关闭的第四层不再无条件装 signal", () => {
    // 形态断言：`AbortSignal.timeout` 必须在"未配置就不装"的守卫之内。
    //
    // PR11 把守卫从 openai.ts 的 `if (FETCH_ABSOLUTE_TIMEOUT_MS !== undefined)`
    // 下沉进了 `makeFetchAbsoluteTimeoutSignal`（那里 `if (timeoutMs === undefined)
    // return undefined`），所以断言跟着改到新落点 —— **要守的不变量没变**：
    // 不配置就不装这个 signal。
    //
    // 顺带钉住"两条流式路径不许再出现裸 `AbortSignal.timeout(FETCH_ABSOLUTE_TIMEOUT_MS)`" ——
    // 那是绕过留痕的唯一途径，绕过了就又隐身了（§4.5 的原缺陷）。
    //
    // 注意**不能**断言整个文件里没有 `AbortSignal.timeout(` ——
    // `probeModelCapability` 的一次性能力探测（10s、非流式、不进重试漏斗）也用它，
    // 那个用法与本档无关，连坐它只会逼后来人删断言。
    const observerSrc = readFileSync(
      join(import.meta.dir, "../../src/trace/stream-observer.ts"),
      "utf8",
    );
    expect(observerSrc).toContain("if (timeoutMs === undefined) return undefined");
    expect(openaiSrc).not.toContain("AbortSignal.timeout(FETCH_ABSOLUTE_TIMEOUT_MS)");
    // 两条流式路径各一处
    expect(openaiSrc.match(/makeFetchAbsoluteTimeoutSignal\(/g)?.length).toBe(2);
    // 两处都必须 disarm。漏一处的后果不是"少留痕"而是"**多记假超时**"：
    // AbortSignal.timeout 到点一定 abort，成功的流会在阈值到点落一条从未发生的超时，
    // 且噪声量正比于成功请求数（越健康的部署数据越脏）。
    expect(openaiSrc.match(/fetchAbs\?\.disarm\(\)/g)?.length, "两条流式路径都要 disarm").toBe(2);
  });
});

describe("PR10 分级解耦 — 子代理/side-call 档不随 BASE 放大", () => {
  test("sideCall 仍是激进档（overall ≤ 60s），不随主循环放宽而漂移", () => {
    // 改造前三档全按倍率派生：BASE 从 300s 抬到 720s 会把 sideCall.overall
    // 60s → 144s 一起放大，**方向与设计意图相反**（旁路调用本该更早放弃）。
    expect(LIFECYCLE_PRESETS.sideCall.overallTimeoutMs).toBeLessThanOrEqual(60_000);
    expect(LIFECYCLE_PRESETS.sideCall.idleTimeoutMs).toBeLessThanOrEqual(30_000);
  });

  test("subAgent 档介于 sideCall 与 mainLoop 之间", () => {
    expect(LIFECYCLE_PRESETS.subAgent.overallTimeoutMs).toBeGreaterThan(
      LIFECYCLE_PRESETS.sideCall.overallTimeoutMs,
    );
    expect(LIFECYCLE_PRESETS.subAgent.overallTimeoutMs).toBeLessThan(
      LIFECYCLE_PRESETS.mainLoop.overallTimeoutMs,
    );
  });

  test("三档与 BASE 的耦合关系：只有 mainLoop 跟随", () => {
    // 这条断言的作用是**留证**：mainLoop 与 watchdog 同源是刻意的（同一条主链路），
    // 后两档解耦也是刻意的。谁想改回全派生，会先撞到这里。
    expect(LIFECYCLE_PRESETS.mainLoop.contentProgressTimeoutMs).toBe(DEFAULTS.watchdogNoProgressMs);
    expect(LIFECYCLE_PRESETS.subAgent.overallTimeoutMs).not.toBe(
      DEFAULTS.watchdogNoProgressMs * 0.6,
    );
  });
});

describe("PR10 settings 打通 — 四项不再是 env-only 的伪配置", () => {
  test("settings.network 能改动四项（此前只认 env）", () => {
    registerNetworkTimeoutSettings({
      idleTimeoutMs: 111_000,
      contentProgressTimeoutMs: 222_000,
      fetchAbsoluteTimeoutMs: 333_000,
      overallTimeoutMs: 444_000,
    });
    const t = resolveProviderStreamTimeouts({ providerKind: "openai" });
    expect(t.idleTimeoutMs).toBe(111_000);
    expect(t.contentProgressTimeoutMs).toBe(222_000);
    expect(t.fetchAbsoluteTimeoutMs).toBe(333_000);
    expect(t.overallTimeoutMs).toBe(444_000);
  });

  test("优先级：env > settings > 默认", () => {
    registerNetworkTimeoutSettings({ idleTimeoutMs: 111_000 });
    process.env.SID_CODE_IDLE_TIMEOUT_MS = "99000";
    expect(resolveProviderStreamTimeouts({ providerKind: "openai" }).idleTimeoutMs).toBe(99_000);
  });

  test("settings 里显式写 0 = 关闭 fetch 硬顶（不是非法值）", () => {
    registerNetworkTimeoutSettings({ fetchAbsoluteTimeoutMs: 0 });
    expect(
      resolveProviderStreamTimeouts({ providerKind: "openai" }).fetchAbsoluteTimeoutMs,
    ).toBeUndefined();
  });

  test("显式传入的 network 优先于注册快照（不依赖注册时序）", () => {
    registerNetworkTimeoutSettings({ idleTimeoutMs: 111_000 });
    const t = resolveProviderStreamTimeouts({
      providerKind: "openai",
      network: { idleTimeoutMs: 222_000 },
    });
    expect(t.idleTimeoutMs).toBe(222_000);
  });

  test("未注册时行为不变（回退 env > 默认）", () => {
    __resetNetworkTimeoutSettingsForTest();
    const t = resolveProviderStreamTimeouts({ providerKind: "openai" });
    expect(t.idleTimeoutMs).toBe(PROVIDER_STREAM_DEFAULTS.idleTimeoutMs);
    expect(t.overallTimeoutMs).toBe(PROVIDER_STREAM_DEFAULTS.overallTimeoutMs);
  });
});

describe("PR12 per-model 覆盖 — 慢是模型属性，不该靠抬全局默认解决", () => {
  test("配了覆盖的模型生效，没配的模型仍走全局默认", () => {
    registerPerModelStreamTimeouts([
      { name: "glm-5.3", streamTimeouts: { contentProgressTimeoutMs: 700_000 } },
      { name: "fast-model" },
    ]);
    expect(
      resolveProviderStreamTimeouts({ providerKind: "openai", modelName: "glm-5.3" })
        .contentProgressTimeoutMs,
    ).toBe(700_000);
    // 这条是本机制存在的**全部理由**：放宽的代价只落在真正需要的模型上。
    // 若它跟着变了，就等于退化成"全局抬阈值"，per-model 这层白加。
    expect(
      resolveProviderStreamTimeouts({ providerKind: "openai", modelName: "fast-model" })
        .contentProgressTimeoutMs,
    ).toBe(PROVIDER_STREAM_DEFAULTS.contentProgressTimeoutMs);
    // 不传 modelName 时行为与 PR12 之前逐字节相同。
    expect(resolveProviderStreamTimeouts({ providerKind: "openai" }).contentProgressTimeoutMs).toBe(
      PROVIDER_STREAM_DEFAULTS.contentProgressTimeoutMs,
    );
  });

  test("优先级链：调用方 options > env > per-model > settings > 默认", () => {
    registerPerModelStreamTimeouts([{ name: "m", streamTimeouts: { idleTimeoutMs: 400_000 } }]);
    // 只有 per-model：它生效
    expect(
      resolveProviderStreamTimeouts({ providerKind: "openai", modelName: "m" }).idleTimeoutMs,
    ).toBe(400_000);
    // per-model 压过全局 settings（范围更窄的赢）。
    // ⚠️ 反过来排会让 per-model 几乎永不生效：用户只要碰过一次全局 idleTimeoutMs，
    // 模型级覆盖就彻底失效且不报错 —— 那就是一层死配置。
    registerNetworkTimeoutSettings({ idleTimeoutMs: 300_000 });
    expect(
      resolveProviderStreamTimeouts({ providerKind: "openai", modelName: "m" }).idleTimeoutMs,
      "per-model 必须压过全局 settings，否则这一层等于死配置",
    ).toBe(400_000);
    // 没有 per-model 覆盖的模型仍吃全局 settings
    expect(
      resolveProviderStreamTimeouts({ providerKind: "openai", modelName: "other" }).idleTimeoutMs,
    ).toBe(300_000);
    // env 压过一切配置文件（运维/测试的一次性注入，多个现存用例依赖这条）
    process.env.SID_CODE_IDLE_TIMEOUT_MS = "200000";
    expect(
      resolveProviderStreamTimeouts({ providerKind: "openai", modelName: "m" }).idleTimeoutMs,
    ).toBe(200_000);
    // 调用方 options 最强
    expect(
      resolveProviderStreamTimeouts({
        providerKind: "openai",
        modelName: "m",
        timeouts: { idleTimeoutMs: 100_000 },
      }).idleTimeoutMs,
    ).toBe(100_000);
  });

  test("空表/清空后必须真的不生效（残留会让新配置按旧阈值跑且不报错）", () => {
    registerPerModelStreamTimeouts([{ name: "m", streamTimeouts: { idleTimeoutMs: 400_000 } }]);
    // 与 setModelCompat 同一条硬要求：切到"没有任何覆盖"时必须真清掉。
    registerPerModelStreamTimeouts([]);
    expect(
      resolveProviderStreamTimeouts({ providerKind: "openai", modelName: "m" }).idleTimeoutMs,
    ).toBe(PROVIDER_STREAM_DEFAULTS.idleTimeoutMs);
    registerPerModelStreamTimeouts([{ name: "m", streamTimeouts: { idleTimeoutMs: 400_000 } }]);
    registerPerModelStreamTimeouts(undefined);
    expect(
      resolveProviderStreamTimeouts({ providerKind: "openai", modelName: "m" }).idleTimeoutMs,
    ).toBe(PROVIDER_STREAM_DEFAULTS.idleTimeoutMs);
  });

  test("非法值一律丢弃而不是抛（本函数在 loadConfig 链上，抛出即进程起不来）", () => {
    registerPerModelStreamTimeouts([
      {
        name: "m",
        // 字符串数字 / 0 / 负数 / NaN 全部是配错，不是"一种意图"。
        // 尤其 0：把 idle 闸门关掉会退回半开连接永久挂起的 0 层状态。
        streamTimeouts: {
          idleTimeoutMs: "300000",
          contentProgressTimeoutMs: 0,
          overallTimeoutMs: -1,
        } as never,
      },
    ]);
    const t = resolveProviderStreamTimeouts({ providerKind: "openai", modelName: "m" });
    expect(t.idleTimeoutMs).toBe(PROVIDER_STREAM_DEFAULTS.idleTimeoutMs);
    expect(t.contentProgressTimeoutMs).toBe(PROVIDER_STREAM_DEFAULTS.contentProgressTimeoutMs);
    expect(t.overallTimeoutMs).toBe(PROVIDER_STREAM_DEFAULTS.overallTimeoutMs);
  });

  test("snake_case 与 camelCase 两种风格都认（用户手写 settings.json 两种都会写）", () => {
    registerPerModelStreamTimeouts([
      { name: "m", streamTimeouts: { content_progress_timeout_ms: 650_000 } as never },
    ]);
    expect(
      resolveProviderStreamTimeouts({ providerKind: "openai", modelName: "m" })
        .contentProgressTimeoutMs,
    ).toBe(650_000);
  });

  test("fetchAbsolute 刻意不接 per-model（不给应当关掉的层加旋钮）", () => {
    registerPerModelStreamTimeouts([
      { name: "m", streamTimeouts: { fetchAbsoluteTimeoutMs: 900_000 } as never },
    ]);
    expect(
      resolveProviderStreamTimeouts({ providerKind: "openai", modelName: "m" })
        .fetchAbsoluteTimeoutMs,
      "PR7 已判定这层应默认关闭，per-model 给它续命等于推翻那个结论",
    ).toBeUndefined();
  });

  test("四条 provider 路径都接了 per-model（只接一条等于把另一族留在旧行为里）", () => {
    // 机械核对接线，而不是只测解析函数：解析对了但 provider 没传 modelName，
    // 就是本仓记过的"死能力"形态（字段加了、没有生产调用方）。
    const openaiSrc = readFileSync(join(import.meta.dir, "../../src/llm/openai.ts"), "utf8");
    const anthropicSrc = readFileSync(join(import.meta.dir, "../../src/llm/anthropic.ts"), "utf8");
    // openai 三处：Chat Completions fetch/lifecycle、Responses、parseSSE 字节级两档
    const openaiWired = openaiSrc.match(/resolveProviderStreamTimeouts\(\{[^}]*modelName/gs) ?? [];
    expect(openaiWired.length, "openai.ts 的三处解析点都要传 modelName").toBe(3);
    expect(anthropicSrc).toMatch(/resolveProviderStreamTimeouts\(\{[^}]*modelName/s);
  });
});
