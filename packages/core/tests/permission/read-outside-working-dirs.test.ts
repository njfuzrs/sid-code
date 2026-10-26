/**
 * 工作区外读边界（对齐 Claude Code）
 *
 * 缺陷：第 5 步只对**写**操作检查工作目录边界，读操作在工作区外一律 allow ——
 * 只要不命中系统目录保护或敏感文件清单，read 工具就能读走任何文件。
 *
 * 本次改动同时动三处，缺一不可：
 *   1. 第 5 步扩展到读写都查（needsConfirmation，不是硬拒）；
 *   2. 敏感文件检查**前移**到边界检查之前 —— 否则工作区外的 `.env` 会从
 *      「硬 deny」退化成「可点确认放行」，那是安全回退；
 *   3. checker Step 4 给这类拒绝开 allow 规则逃生舱 —— 否则用户对区外读
 *      没有任何配置途径（`Read(/data/**)` 写了也不生效）。
 *
 * fixture 用 `fs.realpathSync(os.tmpdir())` 派生：macOS 上 `/var → /private/var`，
 * 两种写法不同源会让 isWithinWorkspace 判在工作区外（见 add-dir-additive.test.ts）。
 */
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { PathValidator } from "@sid-code/core/permission/path-validator.ts";
import { PermissionChecker } from "@sid-code/core/permission/checker.ts";
import { defaultConfig } from "@sid-code/core/config/config.ts";
import type { PermissionRule } from "@sid-code/core/permission/types.ts";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

let base: string;
/** 工作区 */
let ws: string;
/** 工作区外的目录 */
let outside: string;
/** 追加目录（--add-dir 的等价物） */
let extra: string;

beforeAll(() => {
  base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "read-boundary-")));
  ws = path.join(base, "ws");
  outside = path.join(base, "outside");
  extra = path.join(base, "extra");
  for (const d of [ws, outside, extra]) fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(ws, "a.ts"), "// a");
  fs.writeFileSync(path.join(outside, "b.ts"), "// b");
  fs.writeFileSync(path.join(outside, ".env"), "SECRET=1");
});

afterAll(() => {
  fs.rmSync(base, { recursive: true, force: true });
});

describe("PathValidator：读边界与写边界同口径（工作目录集合）", () => {
  test("工作区内读 allow", () => {
    const v = new PathValidator(ws);
    expect(v.validateAccess(path.join(ws, "a.ts"), "read").allowed).toBe(true);
  });

  test("工作区外读 → 需确认（不是硬拒，也不是放行）", () => {
    const v = new PathValidator(ws);
    const r = v.validateAccess(path.join(outside, "b.ts"), "read");
    expect(r.allowed).toBe(false);
    expect(r.needsConfirmation).toBe(true);
    expect(r.outsideWorkingDirs).toBe(true);
    expect(r.reason).toContain("读取路径在工作区外");
  });

  test("工作区外写仍是需确认（口径未变）", () => {
    const v = new PathValidator(ws);
    const r = v.validateAccess(path.join(outside, "new.ts"), "write");
    expect(r.allowed).toBe(false);
    expect(r.needsConfirmation).toBe(true);
    expect(r.reason).toContain("写入路径在工作区外");
  });

  test("--add-dir 追加目录内读 allow", () => {
    const v = new PathValidator(ws, [extra]);
    expect(v.validateAccess(path.join(extra, "b.ts"), "read").allowed).toBe(true);
  });

  test("工作区外 .env 仍是硬 deny —— 敏感文件检查前移，不退化为可确认", () => {
    const v = new PathValidator(ws);
    const r = v.validateAccess(path.join(outside, ".env"), "read");
    expect(r.allowed).toBe(false);
    // 关键断言：needsConfirmation 必须是 false。若它变 true，说明边界检查跑到了
    // 敏感文件检查前面（用户点一次「允许」就能拿走凭证）。
    expect(r.needsConfirmation).toBe(false);
    expect(r.sensitiveFile).toBe(true);
    expect(r.reason).toContain("敏感文件");
  });
});

describe("PermissionChecker：allow 规则是区外读的逃生舱", () => {
  test("default 模式读工作区外 → 需确认", async () => {
    const config = { ...defaultConfig(), allowedDirectories: [] as string[] };
    const checker = new PermissionChecker(config, undefined, ws);
    const r = await checker.check({
      toolName: "read",
      input: { file_path: path.join(outside, "b.ts") },
    });
    expect(r.allowed).toBe(false);
    expect(r.needsConfirmation).toBe(true);
  });

  test("显式 allow 规则可放行工作区外读", async () => {
    const config = { ...defaultConfig(), allowedDirectories: [] as string[] };
    // 绝对路径规则写法：`//` 前缀表示文件系统根（见 path-rule-matching.ts）
    const rules: PermissionRule = { allow: [`Read(//${outside.slice(1)}/**)`] };
    const checker = new PermissionChecker(config, rules, ws);
    const r = await checker.check({
      toolName: "read",
      input: { file_path: path.join(outside, "b.ts") },
    });
    expect(r.allowed).toBe(true);
  });

  test("无头模式（print）读工作区外 → deny，且成因写进模型可见的 reason", async () => {
    const config = { ...defaultConfig(), allowedDirectories: [] as string[], print: true };
    const checker = new PermissionChecker(config, undefined, ws);
    const r = await checker.check({
      toolName: "read",
      input: { file_path: path.join(outside, "b.ts") },
    });
    expect(r.allowed).toBe(false);
    // 模型看到的是 decisionReason.reason（见 checker 的 nonInteractiveDecision 注释），
    // 必须是「读取路径在工作区外」这类可行动信息，不能只有「非交互模式」。
    const reason = r.decisionReason?.type === "other" ? r.decisionReason.reason : "";
    expect(reason).toContain("读取路径在工作区外");
  });

  test("allow 规则不放行系统目录保护（那是独立判断，不走逃生舱）", async () => {
    const config = { ...defaultConfig(), allowedDirectories: [] as string[] };
    const rules: PermissionRule = { allow: ["Read(//proc/**)"] };
    const checker = new PermissionChecker(config, rules, ws);
    const r = await checker.check({
      toolName: "read",
      input: { file_path: "/proc/cpuinfo" },
    });
    expect(r.allowed).toBe(false);
    expect(r.reason).toContain("系统目录读取被拦截");
  });
});
