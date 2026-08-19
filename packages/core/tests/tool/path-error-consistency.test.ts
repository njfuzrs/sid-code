/**
 * 「路径不存在」报错一致性 + bash cwd 变更告知。
 *
 * 事故形态（轨迹 20260817-141456-065fe328）：bash `cd packages/shared/src` 后全局 cwd 被持久化
 * （bash.ts 的 applyCwdTracking → setCwd），文件类工具经 normalizeToolPath 跟随它解析相对路径
 * （这是刻意设计，见 path-utils.ts:24-27）。模型随后传了一个**仓库根相对**的路径，于是拼出
 * `packages/shared/src/packages/cli/src/cli.ts` 这种不存在的路径 —— 而 grep 的报错只回显拼接
 * 结果、不报 cwd，模型花了两轮试错才想明白是上一条 cd 的锅。
 *
 * 两侧同时修：
 *  - 被动侧：报错统一走 formatPathNotFoundError（含「当前工作目录」+ 相似文件名建议）
 *  - 主动侧：cd 真的换了目录时，在 bash 的 tool_result 末尾告知新 cwd
 *
 * 另锁一条连带影响：plan/recovery 的 classifyRecoveryTrigger 是按**错误消息字面串**分类的，
 * 文案一改分类结果就变。语义上这次改判是对的（确实是 file_not_found），但它是行为变更，
 * 必须锁值 —— 否则下一个改文案的人会静默改掉 plan-recovery 的提示。
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { GrepTool } from "@sid-code/core/tool/grep.ts";
import { NotebookEditTool } from "@sid-code/core/tool/notebook-edit.ts";
import { EnterWorktreeTool } from "@sid-code/core/tool/enter-worktree.ts";
import { BashTool } from "@sid-code/core/tool/bash.ts";
import { classifyRecoveryTrigger } from "@sid-code/core/plan/recovery.ts";
import { getCwd, setCwd } from "@sid-code/core/bootstrap/state.ts";

let tmpRoot: string;
let originalCwd: string;

beforeEach(() => {
  originalCwd = getCwd();
  tmpRoot = mkdtempSync(join(tmpdir(), "sid-path-err-"));
});

afterEach(() => {
  setCwd(originalCwd);
  try {
    rmSync(tmpRoot, { recursive: true, force: true });
  } catch {
    /* 忽略 */
  }
});

describe("grep — 路径不存在时报出当前工作目录", () => {
  test("报错含「文件不存在」+「当前工作目录」，不再是只回显拼接结果的旧文案", async () => {
    setCwd(tmpRoot);
    const result = await new GrepTool().execute({ pattern: "x", path: "no/such/dir" });

    expect(result.isError).toBe(true);
    expect(result.output).toContain("文件不存在");
    // 这是本次修复的核心：模型必须能看出路径是被哪个 cwd 拼出来的
    expect(result.output).toContain("当前工作目录:");
    // 旧文案不该再出现
    expect(result.output).not.toContain("错误: 路径不存在 ");
  });

  test("cd 到子目录后传仓库根相对路径 —— 报错里的 cwd 就是那个子目录（事故复现）", async () => {
    const sub = join(tmpRoot, "packages", "shared", "src");
    mkdirSync(sub, { recursive: true });
    setCwd(sub);

    const result = await new GrepTool().execute({ pattern: "x", path: "packages/cli/src" });
    expect(result.isError).toBe(true);
    // 拼接结果与 cwd 都在，模型一眼能看出重复了 packages/ 前缀
    expect(result.output).toContain("packages/shared/src/packages/cli/src");
    expect(result.output).toContain("当前工作目录:");
  });
});

describe("notebook_edit — 文件不存在走同一套文案", () => {
  test("报错含「文件不存在」+「当前工作目录」", async () => {
    setCwd(tmpRoot);
    const result = await new NotebookEditTool().execute({
      notebook_path: join(tmpRoot, "missing.ipynb"),
      new_source: "print(1)",
      edit_mode: "insert",
      cell_type: "code",
    });

    expect(result.isError).toBe(true);
    expect(result.output).toContain("文件不存在");
    expect(result.output).toContain("当前工作目录:");
    expect(result.output).not.toContain("notebook 文件不存在");
  });
});

describe("enter_worktree — 两种失败必须分开报", () => {
  test("路径不存在 → 通用文案（含 cwd）", async () => {
    const result = await new EnterWorktreeTool().execute({
      path: join(tmpRoot, "definitely-missing"),
    });
    expect(result.isError).toBe(true);
    expect(result.output).toContain("文件不存在");
    expect(result.output).toContain("当前工作目录:");
  });

  test("路径存在但缺 .git → 保留场景文案，且**不**混入「找相似文件」那类无关建议", async () => {
    const dir = join(tmpRoot, "plain-dir");
    mkdirSync(dir);
    writeFileSync(join(dir, "a.txt"), "x", "utf8");

    const result = await new EnterWorktreeTool().execute({ path: dir });
    expect(result.isError).toBe(true);
    expect(result.output).toContain("不是 Git worktree");
    expect(result.output).toContain(".git");
    // 目录确实存在，套通用函数会给出一段无关建议——这就是必须拆两路的理由
    expect(result.output).not.toContain("文件不存在");
    expect(result.output).not.toContain("目录中存在相似文件");
  });
});

describe("plan-recovery 分类锁值（文案改动的连带影响）", () => {
  test("grep 的路径失败现在判 file_not_found（改造前是 tool_failure，语义上这次改判是对的）", async () => {
    setCwd(tmpRoot);
    const result = await new GrepTool().execute({ pattern: "x", path: "no/such/dir" });
    expect(classifyRecoveryTrigger("grep", result.output)).toBe("file_not_found");
  });

  test("notebook_edit 的文件不存在仍判 file_not_found（改造前后不变）", async () => {
    const result = await new NotebookEditTool().execute({
      notebook_path: join(tmpRoot, "missing.ipynb"),
      new_source: "print(1)",
      edit_mode: "insert",
      cell_type: "code",
    });
    expect(classifyRecoveryTrigger("notebook_edit", result.output)).toBe("file_not_found");
  });

  test("enter_worktree 的「存在但不是 worktree」仍判 tool_failure（不能被误判成路径不存在）", async () => {
    const dir = join(tmpRoot, "plain-dir2");
    mkdirSync(dir);
    const result = await new EnterWorktreeTool().execute({ path: dir });
    expect(classifyRecoveryTrigger("enter_worktree", result.output)).toBe("tool_failure");
  });
});

describe("反向门禁 — cwd 不许进系统提示词静态区", () => {
  test("getCwd() 变化后 <environment> 段与 generateCacheKey 都不变", async () => {
    if (process.platform === "win32") return;
    const { buildSystemPrompt, clearPromptCache, generateCacheKey } =
      await import("@sid-code/core/config/system-prompt.ts");
    const sub = join(tmpRoot, "sub-static");
    mkdirSync(sub);

    // 不传 workingDir：generateCacheKey 会归一化成 cwd()（process.cwd()，不是 getCwd()）
    const ctx = { tools: [] };
    setCwd(tmpRoot);
    clearPromptCache();
    const before = buildSystemPrompt(ctx);
    const keyBefore = generateCacheKey(ctx);

    setCwd(sub);
    clearPromptCache();
    const after = buildSystemPrompt(ctx);
    const keyAfter = generateCacheKey(ctx);

    // 这一段在 DYNAMIC_BOUNDARY 之前且进缓存键。让它跟随会跟随 bash cd 的 getCwd()
    // 等于「任意 cd + 任意重建 = 静态前缀击穿」，而重建每会话通常一次都不发生 —— 纯亏。
    // cwd 的主动信号走 bash tool_result（见上一组用例），不走这里。
    expect(after).toBe(before);
    expect(keyAfter).toBe(keyBefore);
  });
});

describe("bash — cd 成功后在结果里告知新工作目录", () => {
  test("cd 子目录成功 → 结果末尾含新 cwd 绝对路径", async () => {
    if (process.platform === "win32") return; // Windows 不追踪 cwd
    const sub = join(tmpRoot, "sub");
    mkdirSync(sub);
    setCwd(tmpRoot);

    const result = await new BashTool().execute({ command: "cd sub", description: "进入 sub" });
    expect(result.isError).toBeFalsy();
    expect(result.output).toContain("[工作目录已切换]");
    // pwd -P 解析符号链接（macOS 的 tmpdir 是符号链接），用后缀断言容错
    expect(result.output).toContain(getCwd());
    expect(getCwd().endsWith("/sub")).toBe(true);
  });

  test("cd 不存在的目录（命令失败）→ 结果里**不含**该行", async () => {
    if (process.platform === "win32") return;
    setCwd(tmpRoot);
    const result = await new BashTool().execute({
      command: "cd definitely-missing-dir",
      description: "进入不存在的目录",
    });
    expect(result.isError).toBe(true);
    expect(result.output).not.toContain("[工作目录已切换]");
  });

  test("成功但没换目录（pwd）→ 不追加告知（避免每条命令都刷一行噪音）", async () => {
    if (process.platform === "win32") return;
    setCwd(tmpRoot);
    const result = await new BashTool().execute({ command: "pwd", description: "查看目录" });
    expect(result.isError).toBeFalsy();
    expect(result.output).not.toContain("[工作目录已切换]");
  });
});
