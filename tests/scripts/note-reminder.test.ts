/**
 * Agent Note 缺失提醒（scripts/note-reminder.ts，质量防线分层专项 M6）。
 *
 * 两种失效都不报红，所以要测：
 *   ① 判据漂了（目录清单写错、前缀少个斜杠）→ 提醒静默不再出现；
 *   ② 提醒变成了阻断（脚本非 0 退出、或 CI 步骤去掉了「只报告」的保险）→ 逼人写空 Note 过闸。
 */
import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { parse as parseYaml } from "yaml";
import { WATCHED_DIRS, judgeReminder, renderReminder } from "../../scripts/note-reminder.ts";

const ROOT = join(import.meta.dir, "../..");
const SCRIPT = join(ROOT, "scripts/note-reminder.ts");

describe("judgeReminder", () => {
  test("改了受关注目录、没带 Note → 提醒", () => {
    const r = judgeReminder(["packages/core/src/tool/bash.ts", "README.md"]);
    expect(r.remind).toBe(true);
    expect(r.watched).toEqual(["packages/core/src/tool/bash.ts"]);
  });

  test("六个目录每一个都会触发（防清单里漏一个或写错前缀）", () => {
    for (const d of WATCHED_DIRS) expect(judgeReminder([`${d}x.ts`]).remind).toBe(true);
    expect(WATCHED_DIRS).toHaveLength(6);
  });

  test("带了 Note → 不提醒", () => {
    const r = judgeReminder([
      "packages/core/src/hook/runner.ts",
      ".agents/notes/implemented/bug-fix/2026-11-10-x.md",
    ]);
    expect(r.remind).toBe(false);
    expect(r.hasNote).toBe(true);
  });

  test("没碰受关注目录 → 不提醒（相邻目录与同名前缀不误报）", () => {
    expect(judgeReminder(["packages/core/src/cron/scheduler.ts"]).remind).toBe(false);
    // 每个目录都查「同名前缀的相邻目录」：前缀少了尾斜杠时 `llm` 会误匹配 `llmkit/`。
    // 名字写死，不从 WATCHED_DIRS 派生——派生的话常量写错，期望也跟着错，断言恒绿
    for (const name of ["query", "tool", "permission", "hook", "llm", "context"]) {
      expect(judgeReminder([`packages/core/src/${name}kit/a.ts`]).remind).toBe(false);
      expect(judgeReminder([`packages/core/src/${name}/a.ts`]).remind).toBe(true);
    }
    expect(judgeReminder(["packages/core/tests/tool/bash.test.ts"]).remind).toBe(false);
    expect(judgeReminder([]).remind).toBe(false);
  });

  test("提醒文案写明「不阻断」并列出文件，超过 10 个折叠", () => {
    const files = Array.from({ length: 12 }, (_, i) => `packages/core/src/llm/f${i}.ts`);
    const md = renderReminder(judgeReminder(files));
    expect(md).toContain("不阻断");
    expect(md).toContain("`packages/core/src/llm/f0.ts`");
    expect(md).toContain("另 2 个");
  });
});

describe("脚本端到端：恒退 0", () => {
  // 在临时 git 仓里造两次提交，走真实的 git diff 路径
  const sh = (cwd: string, ...args: string[]) =>
    Bun.spawnSync(args, { cwd, stdout: "pipe", stderr: "pipe" });
  const run = (cwd: string, extra: string[] = []) => {
    const r = Bun.spawnSync(["bun", "run", SCRIPT, ...extra], {
      cwd,
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, GITHUB_STEP_SUMMARY: "" },
    });
    return { code: r.exitCode, out: r.stdout.toString() };
  };
  const repo = (files: string[]) => {
    const d = mkdtempSync(join(tmpdir(), "note-reminder-"));
    sh(d, "git", "init", "-q");
    sh(
      d,
      "git",
      "-c",
      "user.email=t@t",
      "-c",
      "user.name=t",
      "commit",
      "-q",
      "--allow-empty",
      "-m",
      "a",
    );
    for (const f of files) {
      mkdirSync(dirname(join(d, f)), { recursive: true });
      writeFileSync(join(d, f), "x\n");
    }
    sh(d, "git", "add", "-A");
    sh(d, "git", "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "-m", "b");
    return d;
  };

  test("需要提醒时打 ::warning:: 且退 0", () => {
    const d = repo(["packages/core/src/permission/x.ts"]);
    try {
      const r = run(d, ["--base", "HEAD^1", "--head", "HEAD"]);
      expect(r.code).toBe(0);
      expect(r.out).toContain("::warning title=缺 Agent Note？::");
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
  });

  test("取不到 diff（base 不存在）也只打 warning、退 0", () => {
    const d = repo(["a.txt"]);
    try {
      const r = run(d, ["--base", "no-such-rev", "--head", "HEAD"]);
      expect(r.code).toBe(0);
      expect(r.out).toContain("::warning::note-reminder 取不到 diff");
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
  });
});

describe("CI 接线：在 lint job、只在 PR 上、只报告", () => {
  type Step = { name?: string; run?: string; if?: string; "continue-on-error"?: unknown };
  const doc = parseYaml(readFileSync(join(ROOT, ".github/workflows/ci.yml"), "utf8")) as {
    jobs: Record<string, { steps?: Step[] }>;
  };
  const steps = doc.jobs.lint?.steps ?? [];
  const i = steps.findIndex((s) => s.run?.includes("scripts/note-reminder.ts"));

  test("步骤存在且脚本文件存在", () => {
    expect(i).toBeGreaterThanOrEqual(0);
    expect(existsSync(SCRIPT)).toBe(true);
  });

  test("continue-on-error: true，且只在 pull_request 上跑", () => {
    expect(steps[i]?.["continue-on-error"]).toBe(true);
    expect(steps[i]?.if).toContain("pull_request");
  });

  test("排在 fetch 两层历史的期望守卫之后（否则 HEAD^1 解析不到）", () => {
    const guard = steps.findIndex((s) => s.run?.includes("expect-guard.ts"));
    expect(guard).toBeGreaterThanOrEqual(0);
    expect(i).toBeGreaterThan(guard);
  });
});
