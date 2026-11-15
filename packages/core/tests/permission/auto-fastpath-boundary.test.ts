/**
 * M1 / M1b：auto 模式快速路径的「工作区边界」与「用户 ask 规则」回归。
 *
 * 用例编号与 20261112 方案 §6.1 的验收表一一对应（PR-1）。
 *
 * 修前两条绕过（§4.1）：
 * 1. `ToolClassifier.fastPath` 自己写路径判断：Level 1 只按工具名放行（read 越界也过），
 *    Level 2 用 `filePath.startsWith(cwd)`（`/ws-evil/x`、`/ws/../x` 都能过）；
 * 2. 用户显式写的 `ask` 规则命中后，auto 仍把请求交给分类器，分类器同意即放行——
 *    等于把用户规则静默降级成 allow。
 *
 * 夹具要点（§6.1 明确规定）：
 * - **真实 `ToolClassifier`**，只把 provider 换成假的。不许用 `alwaysSafeClassifier()` mock——
 *   那样 `classify` 是一行假实现，`fastPath` 根本不参与，「修 M1 的测试绕开了 M1 的代码」；
 * - provider 的 `llmCalls` 计数用来区分「快速路径放行（0）」与「LLM 放行（1）」；
 * - `fastPathCalls` spy 真实 `fastPath`，锁住 checker 传进来的 `pathVerdict` / `skipFastPath`；
 * - 工作区用 `realpathSync(mkdtempSync(...))`，兄弟目录建在同一父目录下。
 *
 * ⚠️ 落盘隔离：PermissionChecker 构造 AuditLogger（mkdirSync 到 sidPaths.logs()），
 * 必须重定向 SID_CONFIG_DIR；恢复时存/恢复原值而非无条件 delete。
 * ⚠️ 工作区用真实 tmpdir：仓库路径含 `.claude/`，safetyCheck 会在规则判定之前命中。
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PermissionChecker } from "@sid-code/core/permission/checker.ts";
import { ToolClassifier } from "@sid-code/core/permission/tool-classifier.ts";
import { defaultConfig } from "@sid-code/core/config/config.ts";
import type { PermissionRule } from "@sid-code/core/permission/types.ts";
import type { Config } from "@sid-code/core/config/config.ts";

let configRoot: string;
let parentDir: string;
let workspace: string;
let addDir: string;
let prevConfigDir: string | undefined;

beforeEach(() => {
  configRoot = mkdtempSync(join(tmpdir(), "sid-auto-fp-cfg-"));
  // realpathSync：macOS 的 /var → /private/var，不解析会让 pathVerdict 与断言口径不一致
  parentDir = realpathSync(mkdtempSync(join(tmpdir(), "sid-auto-fp-")));
  workspace = join(parentDir, "repo");
  addDir = join(parentDir, "extra");
  mkdirSync(join(workspace, "src"), { recursive: true });
  mkdirSync(join(workspace, ".git"), { recursive: true });
  mkdirSync(join(workspace, ".vscode"), { recursive: true });
  mkdirSync(join(parentDir, "repo-evil"), { recursive: true });
  mkdirSync(addDir, { recursive: true });
  writeFileSync(join(workspace, "README.md"), "# fixture\n");
  prevConfigDir = process.env.SID_CONFIG_DIR;
  process.env.SID_CONFIG_DIR = configRoot;
});

afterEach(() => {
  if (prevConfigDir === undefined) delete process.env.SID_CONFIG_DIR;
  else process.env.SID_CONFIG_DIR = prevConfigDir;
  rmSync(configRoot, { recursive: true, force: true });
  rmSync(parentDir, { recursive: true, force: true });
});

/** fastPath 的入参（只取本文件断言的那些字段） */
interface FastPathCall {
  toolName: string;
  pathVerdict?: string;
  skipFastPath?: boolean;
}

/**
 * 分类器夹具：真实 `ToolClassifier` + 假 provider。
 *
 * - `throw`：provider 抛错 → `classifierUnavailable` → 回退人工确认（验收表 2–6 的期望）
 * - `safe`：LLM 判安全 → 放行（用例 11，证明修复后没有矫枉过正）
 * - `unsafe`：LLM 判不安全 → 回退人工确认
 */
function classifierHarness(opts: { mode: "throw" | "safe" | "unsafe" }) {
  const clf = new ToolClassifier({ enabled: true });
  const fastPathCalls: FastPathCall[] = [];
  let llmCalls = 0;

  const originalFastPath = clf.fastPath.bind(clf);
  (clf as unknown as { fastPath: typeof clf.fastPath }).fastPath = (req) => {
    fastPathCalls.push({
      toolName: req.toolName,
      pathVerdict: req.pathVerdict,
      skipFastPath: req.skipFastPath,
    });
    return originalFastPath(req);
  };

  clf.setProvider({
    sendMessageNonStreaming: async () => {
      llmCalls++;
      if (opts.mode === "throw") throw new Error("fixture: classifier down");
      const text = JSON.stringify({
        safe: opts.mode === "safe",
        risk: opts.mode === "safe" ? "low" : "high",
        reason: "fixture-classifier",
      });
      return { content: [{ type: "text", text }] };
    },
  } as never);

  return {
    clf,
    fastPathCalls,
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
const read = (filePath: string) => ({ toolName: "read", input: { file_path: filePath } });

describe("§6.1 验收表 1–8：工作区边界", () => {
  test("1. write <ws>/src/a.ts → allowed，快速路径保留（0 次 LLM）", async () => {
    const h = classifierHarness({ mode: "throw" });
    const c = checker();
    c.setToolClassifier(h.clf as never);

    const r = await c.check(write(join(workspace, "src", "a.ts")));

    expect(r.allowed).toBe(true);
    expect(r.decisionReason).toMatchObject({ type: "mode", mode: "auto" });
    expect(h.fastPathCalls[0].pathVerdict).toBe("inside");
    expect(h.llmCalls).toBe(0);
  });

  test("2. write <父目录>/repo-evil/a.ts → 同前缀兄弟目录不放行（1 次 LLM）", async () => {
    const h = classifierHarness({ mode: "throw" });
    const c = checker();
    c.setToolClassifier(h.clf as never);

    const r = await c.check(write(join(parentDir, "repo-evil", "a.ts")));

    expect(r.allowed).toBe(false);
    expect(r.needsConfirmation).toBe(true);
    expect(r.metadata?.autoClassifier).toBe("unavailable");
    expect(h.fastPathCalls[0].pathVerdict).toBe("outside");
    expect(h.llmCalls).toBe(1);
  });

  test("3. write <ws>/../.zshrc → `..` 穿越不放行（1 次 LLM）", async () => {
    const h = classifierHarness({ mode: "throw" });
    const c = checker();
    c.setToolClassifier(h.clf as never);

    // 保留字面 `..`：不能用 path.join（会被规范化掉）
    const r = await c.check(write(`${workspace}/../.zshrc`));

    expect(r.needsConfirmation).toBe(true);
    expect(h.fastPathCalls[0].pathVerdict).toBe("outside");
    expect(h.llmCalls).toBe(1);
  });

  test("4. write <ws>/.git/config → classifierApprovable:true 必须调 LLM（1 次）", async () => {
    const h = classifierHarness({ mode: "throw" });
    const c = checker();
    c.setToolClassifier(h.clf as never);

    const r = await c.check(write(join(workspace, ".git", "config")));

    expect(r.step).toBe("6");
    expect(r.metadata).toMatchObject({ classifierApprovable: true });
    expect(h.fastPathCalls[0].pathVerdict).toBe("inside");
    // safetyCheck 且可批准 → fastPath 退场，交给 LLM 看上下文
    expect(h.fastPathCalls[0].skipFastPath).toBe(true);
    expect(h.llmCalls).toBe(1);
    expect(r.needsConfirmation).toBe(true);
  });

  test("5. write <ws>/.vscode/settings.json → 受保护配置目录同样必须调 LLM（1 次）", async () => {
    const h = classifierHarness({ mode: "throw" });
    const c = checker();
    c.setToolClassifier(h.clf as never);

    const r = await c.check(write(join(workspace, ".vscode", "settings.json")));

    expect(r.step).toBe("6");
    expect(h.fastPathCalls[0].skipFastPath).toBe(true);
    expect(h.llmCalls).toBe(1);
    expect(r.needsConfirmation).toBe(true);
  });

  test("6. read /etc/hosts → 读工具不再按工具名放行（1 次 LLM）", async () => {
    const h = classifierHarness({ mode: "throw" });
    const c = checker();
    c.setToolClassifier(h.clf as never);

    const r = await c.check(read("/etc/hosts"));

    expect(r.needsConfirmation).toBe(true);
    expect(h.fastPathCalls[0].pathVerdict).toBe("outside");
    expect(h.fastPathCalls[0].skipFastPath).toBe(true);
    expect(h.llmCalls).toBe(1);
  });

  test("7. read <ws>/README.md → 工作区内只读照常放行（0 次 LLM）", async () => {
    const h = classifierHarness({ mode: "throw" });
    const c = checker();
    c.setToolClassifier(h.clf as never);

    const r = await c.check(read(join(workspace, "README.md")));

    expect(r.allowed).toBe(true);
    expect(h.llmCalls).toBe(0);
  });

  test("8. read <--add-dir>/x → 授权目录视同工作区（0 次 LLM）", async () => {
    const h = classifierHarness({ mode: "throw" });
    const c = checker(undefined, { allowedDirectories: [addDir] });
    c.setToolClassifier(h.clf as never);

    const r = await c.check(read(join(addDir, "x")));
    expect(r.allowed).toBe(true);
    expect(h.llmCalls).toBe(0);
  });

  test("8b. write <--add-dir>/x → 白名单目录在 pathVerdict 里也是 inside（0 次 LLM）", async () => {
    // read 版本走 Step 10 只读放行，证明不了 pathVerdict 认得白名单；写入才走 fastPath Level 2
    const h = classifierHarness({ mode: "throw" });
    const c = checker(undefined, { allowedDirectories: [addDir] });
    c.setToolClassifier(h.clf as never);

    const r = await c.check(write(join(addDir, "x")));

    expect(r.allowed).toBe(true);
    expect(h.fastPathCalls[0].pathVerdict).toBe("inside");
    expect(h.llmCalls).toBe(0);
  });
});

describe("§6.1 验收表 9–10：用户 ask 规则", () => {
  test("9. ask `Write(**/*.lock)` + write <ws>/bun.lock → ask-rule，0 次 LLM", async () => {
    const h = classifierHarness({ mode: "safe" }); // 分类器本来会放行
    const c = checker({ ask: ["Write(**/*.lock)"] });
    c.setToolClassifier(h.clf as never);

    const r = await c.check(write(join(workspace, "bun.lock")));

    expect(r.allowed).toBe(false);
    expect(r.needsConfirmation).toBe(true);
    expect(r.decisionReason).toMatchObject({ type: "rule", behavior: "ask" });
    expect(r.metadata?.autoClassifier).toBe("ask-rule");
    // 不进 classify：fastPath 与 LLM 都不该被调用
    expect(h.fastPathCalls.length).toBe(0);
    expect(h.llmCalls).toBe(0);
  });

  test("10. ask `Bash(git push*)` + 永远 safe 的分类器 → ask-rule，0 次 LLM", async () => {
    const h = classifierHarness({ mode: "safe" });
    const c = checker({ ask: ["Bash(git push*)"] });
    c.setToolClassifier(h.clf as never);

    const r = await c.check({ toolName: "bash", input: { command: "git push origin main" } });

    expect(r.needsConfirmation).toBe(true);
    expect(r.metadata?.autoClassifier).toBe("ask-rule");
    expect(h.llmCalls).toBe(0);
  });
});

describe("§6.1 验收表 11：LLM 判 safe 时仍然放行（没有矫枉过正）", () => {
  test("2–6 换成「LLM 判 safe」：越界请求经分类器同意后照常放行", async () => {
    const cases = [
      write(join(parentDir, "repo-evil", "a.ts")),
      write(`${workspace}/../.zshrc`),
      write(join(workspace, ".git", "config")),
      write(join(workspace, ".vscode", "settings.json")),
      read("/etc/hosts"),
    ];
    for (const req of cases) {
      const h = classifierHarness({ mode: "safe" });
      const c = checker();
      c.setToolClassifier(h.clf as never);
      const r = await c.check(req);
      expect(r.allowed, JSON.stringify(req.input)).toBe(true);
      expect(h.llmCalls).toBe(1);
    }
  });
});

describe("§6.1 验收表 12：敏感文件硬拒不受影响", () => {
  test("12. write <ws>/../.ssh/authorized_keys → allowed=false step=4（0 次 LLM）", async () => {
    const h = classifierHarness({ mode: "safe" });
    const c = checker();
    c.setToolClassifier(h.clf as never);

    const r = await c.check(write(`${workspace}/../.ssh/authorized_keys`));

    expect(r.allowed).toBe(false);
    expect(r.needsConfirmation).toBe(false);
    expect(r.step).toBe("4");
    expect(h.llmCalls).toBe(0);
  });
});

describe("补充：Level 1 的路径判定（ripgrep 不经 Step 10，能真正走到 fastPath）", () => {
  test("ripgrep 工作区内 → fastPath 放行，0 次 LLM", async () => {
    const h = classifierHarness({ mode: "throw" });
    const c = checker();
    c.setToolClassifier(h.clf as never);

    const r = await c.check({ toolName: "ripgrep", input: { path: join(workspace, "src") } });

    expect(r.allowed).toBe(true);
    expect(h.fastPathCalls[0].pathVerdict).toBe("inside");
    expect(h.llmCalls).toBe(0);
  });

  test("ripgrep 工作区外 → 不按工具名放行，落到 LLM", async () => {
    const h = classifierHarness({ mode: "throw" });
    const c = checker();
    c.setToolClassifier(h.clf as never);

    const r = await c.check({ toolName: "ripgrep", input: { path: "/etc" } });

    expect(r.needsConfirmation).toBe(true);
    expect(h.fastPathCalls[0].pathVerdict).toBe("outside");
    expect(h.llmCalls).toBe(1);
  });
});
