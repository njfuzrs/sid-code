/**
 * PR0（C1 / C2 的落盘后半段）：分类器结论必须**真的到达 `events.jsonl`**，
 * 且外发遥测只出「枚举 + 数字」两个安全形状。
 *
 * ## 为什么断言不能只打在 `Decision.metadata` 上
 *
 * 本仓库踩过一次这个形态：B11 的 `confirm_via` 上游带了字段、门面也透传了，
 * 唯独 collector 没映射，于是轨迹里恒无该字段，而当时的单测只断言到「观察者入参」，
 * 全绿。§4.1.3 把它写成一条硬要求：门禁必须从 `check()` 一路走到落盘行。
 *
 * 所以这里的链路是完整的：真实 checker（auto 模式）→ `logPermissionAllow`
 * （带 `decisionFactsOf`）→ 真实 collector → 读 `events.jsonl` 原文。
 *
 * 每个用例同时钉「该有值时有值」与「不该有值时没有」——只断言前者的话，
 * 恒落一个字面量也能让测试变绿。
 *
 * 落盘目标经 `SID_CONFIG_DIR` 重定向到 tmpdir，不触碰真实 `~/.sid-code`。
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TraceCollector } from "@sid-code/core/trace/collector.ts";
import { PermissionChecker } from "@sid-code/core/permission/checker.ts";
import { ToolClassifier } from "@sid-code/core/permission/tool-classifier.ts";
import { defaultConfig } from "@sid-code/core/config/config.ts";
import { logPermissionAllow } from "@sid-code/core/analytics/events.ts";
import {
  decisionFactsOf,
  setPermissionDecisionObserver,
} from "@sid-code/core/permission/decision-telemetry.ts";
import {
  __resetAnalyticsForTest,
  attachAnalyticsSink,
  type EventMetadata,
} from "@sid-code/core/analytics/index.ts";
import { stripLocalOnlyEventFields } from "@sid-code/core/trace/uploader.ts";

let dir: string;
let workspace: string;
const saved = {
  config: process.env.SID_CONFIG_DIR,
  index: process.env.SID_CODE_SESSION_INDEX,
};

beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), "sid-pr0-verdict-land-")));
  workspace = realpathSync(mkdtempSync(join(tmpdir(), "sid-pr0-verdict-land-ws-")));
  process.env.SID_CONFIG_DIR = join(dir, "cfg");
  process.env.SID_CODE_SESSION_INDEX = join(dir, "session-index.jsonl");
  __resetAnalyticsForTest();
});

afterEach(() => {
  setPermissionDecisionObserver(null);
  __resetAnalyticsForTest();
  for (const [k, v] of [
    ["SID_CONFIG_DIR", saved.config],
    ["SID_CODE_SESSION_INDEX", saved.index],
  ] as const) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  rmSync(dir, { recursive: true, force: true });
  rmSync(workspace, { recursive: true, force: true });
});

/**
 * 起一个真 collector 并读回 events.jsonl。
 *
 * 必须跑一轮模型：否则整个会话是空的，SessionEnd 的 `cleanupIfBlankSession`
 * 会把轨迹目录删掉（表现为 `sessions/` 存在但其下没有会话目录，readFileSync ENOENT
 * —— 不是落盘失败，是目录被主动清理了）。
 */
async function withCollector(
  sessionId: string,
  fn: (hooks: import("@sid-code/core/hook/system.ts").HookSystem) => Promise<void>,
): Promise<Array<{ event: string; data: Record<string, unknown> }>> {
  const { HookSystem } = await import("@sid-code/core/hook/system.ts");
  const hooks = new HookSystem();
  hooks.setSessionId(sessionId);
  hooks.setCwd(dir);
  const trajDir = join(dir, "trajectories");
  new TraceCollector({ outputDir: trajDir }).registerHooks(hooks);
  await hooks.fireSessionStartEvent("startup", { model: "claude-test" });
  await hooks.fireBeforeModelEvent({
    model: "claude-test",
    messages: [{ role: "user", content: "hi" }],
    raw_messages: [{ role: "user", content: "hi" }],
  });
  await hooks.fireAfterModelEvent(
    { model: "claude-test", messages: [], raw_messages: [{ role: "user", content: "hi" }] },
    {
      content_blocks: [{ type: "text", text: "ok" }],
      stop_reason: "end_turn",
      usage: {
        inputTokens: 1,
        outputTokens: 1,
        cacheReadInputTokens: 0,
        cacheCreationInputTokens: 0,
      },
    } as never,
  );
  await fn(hooks);
  await hooks.fireSessionEndEvent("exit");
  return readFileSync(join(trajDir, "sessions", sessionId, "events.jsonl"), "utf-8")
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l));
}

/** 真实分类器 + 假 provider：让 `via` / `latencyMs` 都由真实代码产生，不是 mock 写死的 */
function classifier(mode: "safe" | "unsafe") {
  const clf = new ToolClassifier({ enabled: true });
  clf.setProvider({
    sendMessageNonStreaming: async () => ({
      content: [
        {
          type: "text",
          text: JSON.stringify({
            safe: mode === "safe",
            risk: mode === "safe" ? "low" : "high",
            reason: mode === "safe" ? "工作区内文件编辑" : "试图写入工作区外的凭证目录",
          }),
        },
      ],
    }),
  } as never);
  return clf;
}

function autoChecker() {
  return new PermissionChecker({ ...defaultConfig(), permissionMode: "auto" }, {}, workspace);
}

const writeOutside = () => ({
  toolName: "write",
  input: { file_path: join(workspace, "..", "outside.ts") },
});
const writeInside = () => ({
  toolName: "write",
  input: { file_path: join(workspace, "a.ts") },
});

describe("C1/C2：分类器结论落进 events.jsonl", () => {
  test("llm-safe：auto_classifier / classifier_ms / classifier_risk / classifier_reason 四项都有值", async () => {
    const c = autoChecker();
    c.setToolClassifier(classifier("safe") as never);
    const d = await c.check(writeOutside());
    expect(d.allowed).toBe(true);
    expect(d.metadata?.autoClassifier).toBe("llm-safe");

    const events = await withCollector("pr0-llm-safe", async () => {
      logPermissionAllow("write", {
        source: "rule",
        needsPrompt: false,
        context: "main",
        reasonType: d.decisionReason?.type,
        step: d.step,
        mode: d.mode,
        ...decisionFactsOf(d),
      });
    });

    const decision = events.find((e) => e.event === "PermissionDecision");
    expect(decision?.data.auto_classifier).toBe("llm-safe");
    // 数字类型：写成字符串会让下游求和无声变成字符串拼接
    expect(typeof decision?.data.classifier_ms).toBe("number");
    expect(decision?.data.classifier_risk).toBe("low");
    expect(decision?.data.classifier_reason).toBe("工作区内文件编辑");
  });

  test("fast-path：只落枚举，不落 classifier_ms（零成本不是 0 毫秒）", async () => {
    const c = autoChecker();
    c.setToolClassifier(classifier("safe") as never);
    const d = await c.check(writeInside());
    expect(d.allowed).toBe(true);
    expect(d.metadata?.autoClassifier).toBe("fast-path");

    const events = await withCollector("pr0-fast-path", async () => {
      logPermissionAllow("write", {
        source: "rule",
        needsPrompt: false,
        context: "main",
        reasonType: d.decisionReason?.type,
        step: d.step,
        mode: d.mode,
        ...decisionFactsOf(d),
      });
    });

    const decision = events.find((e) => e.event === "PermissionDecision");
    expect(decision?.data.auto_classifier).toBe("fast-path");
    // 关键判据：填 0 会让「快速路径」与「一次真的 0ms 调用」在盘上同形
    expect(decision?.data.classifier_ms).toBeUndefined();
    expect(decision?.data.classifier_risk).toBeUndefined();
    expect(decision?.data.classifier_reason).toBeUndefined();
  });

  test("unsafe 回退：理由落在轨迹里（审计之外的第二条可查链）", async () => {
    const c = autoChecker();
    c.setToolClassifier(classifier("unsafe") as never);
    const d = await c.check(writeOutside());
    expect(d.needsConfirmation).toBe(true);

    const events = await withCollector("pr0-unsafe", async () => {
      logPermissionAllow("write", {
        source: "rule",
        needsPrompt: false,
        context: "main",
        reasonType: d.decisionReason?.type,
        step: d.step,
        mode: d.mode,
        ...decisionFactsOf(d),
      });
    });

    const decision = events.find((e) => e.event === "PermissionDecision");
    expect(decision?.data.auto_classifier).toBe("unsafe");
    expect(decision?.data.classifier_risk).toBe("high");
    expect(decision?.data.classifier_reason).toBe("试图写入工作区外的凭证目录");
  });
});

describe("隐私：外发遥测只出枚举与数字", () => {
  test("permission_allow 的 payload 有 auto_classifier / classifier_ms，没有 classifier_reason", async () => {
    const c = autoChecker();
    c.setToolClassifier(classifier("safe") as never);
    const d = await c.check(writeOutside());

    const sent: Array<{ event: string; metadata: EventMetadata }> = [];
    attachAnalyticsSink({
      logEvent(event: string, metadata: EventMetadata) {
        sent.push({ event, metadata });
      },
    });

    logPermissionAllow("write", {
      source: "rule",
      needsPrompt: false,
      context: "main",
      reasonType: d.decisionReason?.type,
      step: d.step,
      mode: d.mode,
      ...decisionFactsOf(d),
    });

    const allow = sent.find((e) => e.event === "permission_allow");
    expect(allow).toBeDefined();
    // String() 包一层：EventMetadataValue 是 branded 类型，裸 string 不进去（本仓刻意如此）
    expect(String(allow?.metadata.auto_classifier)).toBe("llm-safe");
    expect(typeof allow?.metadata.classifier_ms).toBe("number");
    // 隐私断言（0-5）：理由可能含路径或命令片段，绝不能进外发通道
    expect(allow?.metadata.classifier_reason).toBeUndefined();
    expect(allow?.metadata.classifier_risk).toBeUndefined();
  });

  test("上传前剥离：events.jsonl 里的 classifier_reason / classifier_risk 被删掉，classifier_ms 保留", () => {
    const line = JSON.stringify({
      event: "PermissionDecision",
      data: {
        auto_classifier: "llm-safe",
        classifier_ms: 812,
        classifier_risk: "low",
        classifier_reason: "试图写入 /Users/someone/.ssh/id_rsa",
      },
    });

    const stripped = JSON.parse(stripLocalOnlyEventFields(line));
    expect(stripped.data.classifier_ms).toBe(812);
    expect(stripped.data.auto_classifier).toBe("llm-safe");
    expect(stripped.data.classifier_reason).toBeUndefined();
    expect(stripped.data.classifier_risk).toBeUndefined();
  });
});
