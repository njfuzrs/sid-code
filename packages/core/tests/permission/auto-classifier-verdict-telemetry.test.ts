/**
 * PR0（C1 / C2 的落盘前半段）：auto 档每条决策都带分类器结论、耗时、风险与理由。
 *
 * ## 修的是什么
 *
 * 触发会话（`20261117-134629-f2956b40`）的两次 auto 档确认，轨迹里只有
 * `auto_classifier=unsafe` 一个枚举、审计里只有 `"reason":"用户批准"`：
 * 「分类器为什么判 unsafe」在两条链上都查不到。两个根因各自独立：
 *
 * 1. **放行那条路径根本不带 metadata**（`allowed: true` 直接 return）——
 *    于是「auto 档自动放行了多少次」在盘上没有分子，只能靠「没弹窗」反推，
 *    而反推分不出「分类器批的」与「规则直放的」；
 * 2. 回退路径虽然落了一个枚举，但没有耗时 / 风险 / 理由。
 *
 * ## 判据口径（改之前先读，否则很容易写出恒绿的断言）
 *
 * - `fast-path`：零成本快速路径，**不带 `classifierMs`** —— 没发请求，
 *   填 0 会把「省了一次调用」记成「一次耗时 0ms 的调用」，与真的 0ms 返回混成一团；
 *   理由也不带（`reason` 是硬编码常量，工具名 + via 已完全确定结论）；
 * - `llm-safe` / `unsafe`：真调了一次模型，耗时 / 风险 / 理由三项都要有值；
 * - `unavailable`：带耗时与理由，但**不带 `classifierRisk`** —— 解析失败 / 超时 /
 *   不可用那几条路径的 `risk` 是硬编码占位值 `medium`，不是模型判的，
 *   落盘会变成「分类器说风险中等」这种没发生过的事实。
 *
 * 落盘目标经 `SID_CONFIG_DIR` 重定向到 tmpdir：`PermissionChecker` 构造时会建
 * `AuditLogger`（mkdir 到 sidPaths.logs()），不重定向就会写进真实的 `~/.sid-code/`。
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PermissionChecker } from "@sid-code/core/permission/checker.ts";
import { ToolClassifier } from "@sid-code/core/permission/tool-classifier.ts";
import { defaultConfig } from "@sid-code/core/config/config.ts";
import type { PermissionRule } from "@sid-code/core/permission/types.ts";
import type { Config } from "@sid-code/core/config/config.ts";

let configRoot: string;
let workspace: string;
let prevConfigDir: string | undefined;

beforeEach(() => {
  configRoot = mkdtempSync(join(tmpdir(), "sid-pr0-verdict-cfg-"));
  // realpathSync：macOS 的 /var → /private/var，不解析会让 pathVerdict 与断言口径不一致
  workspace = realpathSync(mkdtempSync(join(tmpdir(), "sid-pr0-verdict-ws-")));
  mkdirSync(join(workspace, "src"), { recursive: true });
  prevConfigDir = process.env.SID_CONFIG_DIR;
  process.env.SID_CONFIG_DIR = configRoot;
});

afterEach(() => {
  // 必须存/恢复原值：同批多文件跑在同一进程里，无条件 delete 会抹掉 preload 的兜底
  if (prevConfigDir === undefined) delete process.env.SID_CONFIG_DIR;
  else process.env.SID_CONFIG_DIR = prevConfigDir;
  rmSync(configRoot, { recursive: true, force: true });
  rmSync(workspace, { recursive: true, force: true });
});

/**
 * 真实 `ToolClassifier` + 假 provider。
 *
 * 刻意不用 `classifierUnavailable` 的手写 mock：`via` 是我们新加的字段，
 * mock 掉 `classify` 就等于「测自己写的那一行」，而真正要守的是
 * 「`fastPath` / LLM / 不可用三条返回路径各自标对了 via」。
 */
function classifierHarness(mode: "safe" | "unsafe" | "throw" | "timeout") {
  const clf = new ToolClassifier({ enabled: true });
  let llmCalls = 0;
  clf.setProvider({
    sendMessageNonStreaming: async () => {
      llmCalls++;
      if (mode === "throw") throw new Error("fixture: classifier down");
      if (mode === "timeout") {
        const err = new Error("fixture: timeout");
        err.name = "AbortError";
        throw err;
      }
      const text = JSON.stringify({
        safe: mode === "safe",
        risk: mode === "safe" ? "low" : "high",
        reason: mode === "safe" ? "工作区内只读" : "试图写入工作区外的凭证目录",
      });
      return { content: [{ type: "text", text }] };
    },
  } as never);
  return {
    clf,
    get llmCalls() {
      return llmCalls;
    },
  };
}

function checker(rules?: PermissionRule, over: Partial<Config> = {}) {
  return new PermissionChecker(
    { ...defaultConfig(), permissionMode: "auto", ...over },
    rules,
    workspace,
  );
}

const write = (filePath: string) => ({ toolName: "write", input: { file_path: filePath } });

describe("§4.1.2：auto 分支的 metadata —— 放行也要留痕", () => {
  test("快速路径放行 → autoClassifier=fast-path，不带耗时/风险/理由", async () => {
    const h = classifierHarness("safe");
    const c = checker();
    c.setToolClassifier(h.clf as never);

    const r = await c.check(write(join(workspace, "src", "a.ts")));

    expect(r.allowed).toBe(true);
    // 原行为不变（原则 5）：决策成因与 step 不动，只补 metadata
    expect(r.decisionReason).toMatchObject({ type: "mode", mode: "auto" });
    expect(r.step).toBe("auto");
    expect(r.metadata?.autoClassifier).toBe("fast-path");
    // 零成本：没发请求就不该有耗时（填 0 会被读成「一次 0ms 的调用」）
    expect(r.metadata?.classifierMs).toBeUndefined();
    expect(r.metadata?.classifierRisk).toBeUndefined();
    expect(r.metadata?.classifierReason).toBeUndefined();
    expect(h.llmCalls).toBe(0);
  });

  test("LLM 判安全 → autoClassifier=llm-safe，三项都有值", async () => {
    const h = classifierHarness("safe");
    const c = checker();
    c.setToolClassifier(h.clf as never);

    // 工作区外写入：fastPath 的 Level 2 要求 pathVerdict=inside，拿不到就交给 LLM
    const r = await c.check(write(join(workspace, "..", "outside.ts")));

    expect(r.allowed).toBe(true);
    expect(r.metadata?.autoClassifier).toBe("llm-safe");
    expect(typeof r.metadata?.classifierMs).toBe("number");
    expect(r.metadata?.classifierRisk).toBe("low");
    expect(r.metadata?.classifierReason).toBe("工作区内只读");
    expect(h.llmCalls).toBe(1);
  });

  test("LLM 判不安全 → autoClassifier=unsafe，理由与耗时都落", async () => {
    const h = classifierHarness("unsafe");
    const c = checker();
    c.setToolClassifier(h.clf as never);

    const r = await c.check(write(join(workspace, "..", "outside.ts")));

    expect(r.allowed).toBe(false);
    expect(r.needsConfirmation).toBe(true);
    expect(r.metadata?.autoClassifier).toBe("unsafe");
    expect(typeof r.metadata?.classifierMs).toBe("number");
    expect(r.metadata?.classifierRisk).toBe("high");
    // 这条正是 C2 的核心：`unsafe` 只说"判了不安全"回答不了"它觉得哪里不安全"
    expect(r.metadata?.classifierReason).toBe("试图写入工作区外的凭证目录");
  });

  test("分类器超时 → unavailable，带耗时与理由，但不带占位风险值", async () => {
    const h = classifierHarness("timeout");
    const c = checker();
    c.setToolClassifier(h.clf as never);

    const r = await c.check(write(join(workspace, "..", "outside.ts")));

    expect(r.needsConfirmation).toBe(true);
    expect(r.metadata?.autoClassifier).toBe("unavailable");
    expect(typeof r.metadata?.classifierMs).toBe("number");
    expect(r.metadata?.classifierReason).toContain("分类器异常");
    // risk 在这些路径上是硬编码 medium 占位值，落盘就不是「分类器的判断」了
    expect(r.metadata?.classifierRisk).toBeUndefined();
  });

  test("用户 ask 规则命中（分类器没说话）→ ask-rule，三项都不落", async () => {
    const h = classifierHarness("safe"); // 分类器本来会放行
    const c = checker({ ask: ["Write(**/*.lock)"] });
    c.setToolClassifier(h.clf as never);

    const r = await c.check(write(join(workspace, "bun.lock")));

    expect(r.allowed).toBe(false);
    expect(r.needsConfirmation).toBe(true);
    expect(r.decisionReason).toMatchObject({ type: "rule", behavior: "ask" });
    expect(r.metadata?.autoClassifier).toBe("ask-rule");
    expect(r.metadata?.classifierMs).toBeUndefined();
    expect(r.metadata?.classifierRisk).toBeUndefined();
    expect(r.metadata?.classifierReason).toBeUndefined();
    // 分类器一次都没被调：ask 规则是「要人看」，不是「让分类器看」
    expect(h.llmCalls).toBe(0);
  });
});

describe("ToolClassifyResult.via：三条返回路径都必须表态", () => {
  const base = { toolName: "read", input: { file_path: "a.ts" }, cwd: "/ws" };

  test("fastPath 的 Level 1（只读工具）→ via=fast-path，无 latencyMs", () => {
    const clf = new ToolClassifier({ enabled: true });
    const r = clf.fastPath({ ...base, pathVerdict: "inside" });
    expect(r?.via).toBe("fast-path");
    expect(r?.latencyMs).toBeUndefined();
  });

  test("fastPath 的 Level 0（工具自报无安全关联）→ via=fast-path", () => {
    const clf = new ToolClassifier({ enabled: true });
    const r = clf.fastPath({ ...base, classifierInput: "" });
    expect(r?.via).toBe("fast-path");
  });

  test("fastPath 的 Level 2（工作区内 write）→ via=fast-path", () => {
    const clf = new ToolClassifier({ enabled: true });
    const r = clf.fastPath({
      toolName: "write",
      input: { file_path: "a.ts" },
      cwd: "/ws",
      pathVerdict: "inside",
    });
    expect(r?.via).toBe("fast-path");
    expect(r?.risk).toBe("low");
  });

  test("分类器不可用（没 provider）→ via=none，且没有 latencyMs", async () => {
    const clf = new ToolClassifier({ enabled: true });
    const r = await clf.classify({ ...base });
    expect(r.via).toBe("none");
    expect(r.classifierUnavailable).toBe(true);
    expect(r.latencyMs).toBeUndefined();
  });

  test("LLM 成功 → via=llm，带 latencyMs", async () => {
    const clf = new ToolClassifier({ enabled: true });
    clf.setProvider({
      sendMessageNonStreaming: async () => ({
        content: [{ type: "text", text: '{"safe":true,"risk":"low","reason":"ok"}' }],
      }),
    } as never);
    const r = await clf.classify({ ...base });
    expect(r.via).toBe("llm");
    expect(typeof r.latencyMs).toBe("number");
  });

  test("LLM 解析失败 → 仍标 via=llm（花掉了一次请求，只是没拿到答案）", async () => {
    const clf = new ToolClassifier({ enabled: true });
    clf.setProvider({
      sendMessageNonStreaming: async () => ({ content: [{ type: "text", text: "不是 JSON" }] }),
    } as never);
    const r = await clf.classify({ ...base });
    expect(r.via).toBe("llm");
    expect(r.classifierUnavailable).toBe(true);
    expect(typeof r.latencyMs).toBe("number");
  });

  test("LLM 抛错 → via=llm + latencyMs", async () => {
    const h = classifierHarness("throw");
    const r = await h.clf.classify({ ...base });
    expect(r.via).toBe("llm");
    expect(typeof r.latencyMs).toBe("number");
  });
});

describe("C2：审计终局行带上分类器结论", () => {
  test("用户批准/拒绝那一行带 auto_classifier 与 classifier_reason", () => {
    const c = checker();
    const req = { toolName: "bash", input: { command: "git push origin feat/x" } };

    c.auditConfirmationOutcome(req, {
      allowed: true,
      source: "user",
      reason: "用户批准",
      metadata: {
        autoClassifier: "unsafe",
        classifierReason: "推送功能分支但分类器只看命令形状，判为对外副作用",
        classifierMs: 812,
      },
    });

    const line = readFileSync(join(configRoot, "logs", "permissions-audit.log"), "utf-8")
      .trim()
      .split("\n")
      .pop()!;
    const entry = JSON.parse(line);
    expect(entry.auto_classifier).toBe("unsafe");
    expect(entry.classifier_reason).toBe("推送功能分支但分类器只看命令形状，判为对外副作用");
    // 审计只取枚举与理由两项，不落耗时、也不落整个 metadata
    expect(entry.classifier_ms).toBeUndefined();
    expect(entry.classifierReason).toBeUndefined();
  });

  test("老调用点不传 metadata → 两个字段都不出现（与旧数据同形）", () => {
    const c = checker();
    c.auditConfirmationOutcome(
      { toolName: "bash", input: { command: "ls" } },
      { allowed: true, source: "user", reason: "用户批准" },
    );

    const line = readFileSync(join(configRoot, "logs", "permissions-audit.log"), "utf-8")
      .trim()
      .split("\n")
      .pop()!;
    const entry = JSON.parse(line);
    expect(entry.auto_classifier).toBeUndefined();
    expect(entry.classifier_reason).toBeUndefined();
  });
});

describe("理由截断：模型输出长度无上界", () => {
  test("超过 200 字的理由被截断并加省略号", async () => {
    const clf = new ToolClassifier({ enabled: true });
    clf.setProvider({
      sendMessageNonStreaming: async () => ({
        content: [
          {
            type: "text",
            text: JSON.stringify({ safe: false, risk: "high", reason: "长".repeat(400) }),
          },
        ],
      }),
    } as never);
    const c = checker();
    c.setToolClassifier(clf as never);

    const r = await c.check(write(join(workspace, "..", "outside.ts")));

    const reason = r.metadata?.classifierReason as string;
    expect(reason.length).toBe(201); // 200 字 + 一个省略号
    expect(reason.endsWith("…")).toBe(true);
  });
});
