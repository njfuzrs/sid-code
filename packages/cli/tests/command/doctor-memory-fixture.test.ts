/**
 * `/doctor` 记忆夹具自愈检测测试（D-15 第 3 步）
 *
 * 为什么测 doctor 报告而不是只测 `detectFixtureMemories()`：本项治的问题是
 * 「历史夹具泄漏留在真实记忆库里却没人看得见」。检测函数写得再对，
 * 没接进 `/doctor` 就等于没做 —— 这与 doctor-disk 那条「缺的正是入口」同源。
 *
 * 落盘隔离按 CONTRIBUTING「测试约定」：只写 `SID_CONFIG_DIR` 指向的 tmpdir，
 * 存/恢复原值而不无条件 delete（同批多文件跑在同一进程，删掉会抹掉 preload 兜底）。
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { CommandContext } from "@sid-code/cli/command/types.ts";

let tmpHome: string;
let prevConfigDir: string | undefined;

/** 最小 ctx：主诊断里 checkModelProvider 直接解 ctx.config.model，空对象即可。 */
function makeCtx(): CommandContext {
  return { cwd: tmpHome, config: {} } as unknown as CommandContext;
}

async function runDoctor(): Promise<string> {
  const doctor = (await import("@sid-code/cli/command/commands/doctor/doctor.ts")).default;
  const r = await doctor.call("", makeCtx());
  if (r.type !== "text") throw new Error(`期望 text 结果，实得 ${r.type}`);
  return r.value;
}

/** 按真实落盘形态写一条记忆：frontmatter 带 name/description/type。 */
function writeMemory(key: string, description: string): string {
  const dir = join(tmpHome, "memory");
  mkdirSync(dir, { recursive: true });
  const filePath = join(dir, `reference_${key}.md`);
  writeFileSync(
    filePath,
    [
      "---",
      `name: ${key}`,
      `description: ${description}`,
      "type: reference",
      "---",
      "",
      "正文",
    ].join("\n"),
  );
  return filePath;
}

beforeEach(() => {
  tmpHome = mkdtempSync(join(tmpdir(), "sid-doctor-fixture-"));
  prevConfigDir = process.env.SID_CONFIG_DIR;
  process.env.SID_CONFIG_DIR = tmpHome;
});

afterEach(() => {
  if (prevConfigDir === undefined) delete process.env.SID_CONFIG_DIR;
  else process.env.SID_CONFIG_DIR = prevConfigDir;
  try {
    rmSync(tmpHome, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

describe("/doctor 记忆夹具检测", () => {
  test("全局记忆库含 doc_example 时报告该 key 与其来源", async () => {
    const written = writeMemory("doc_example", "AWS 文档示例: AKIAIOSFODNN7EXAMPLE");

    const out = await runDoctor();

    // key 本身：报告里必须能直接读到，否则用户不知道哪条是夹具
    expect(out).toContain("doc_example");
    // 来源：名单会腐化，报告里带上出处才让人能判断"这条名单条目是否还有效"
    expect(out).toContain("packages/core/tests/tool/memory.test.ts");
    // 只报告不删：必须显式声明且带可定位路径
    expect(out).toContain("只报告不删除");
    expect(out).toContain(written);
    // 未抛检查失败（说明整段检测真的跑通了，而不是被 catch 吞成 warn）
    expect(out).not.toContain("检查失败");
    // 确实落到了 tmpdir，没有写真实 HOME
    expect(written.startsWith(tmpHome)).toBe(true);
  });

  test("记忆库干净时报 ok 项，而不是整项消失", async () => {
    writeMemory("coding_style", "本项目偏好 2 空格缩进");

    const out = await runDoctor();

    expect(out).toContain("记忆夹具");
    expect(out).toContain("无已知测试夹具条目");
    expect(out).not.toContain("doc_example");
  });

  test("只认 frontmatter 的 name —— 正文引用同名串不算夹具", async () => {
    const dir = join(tmpHome, "memory");
    mkdirSync(dir, { recursive: true });
    // 用户正常记忆里说明"测试用了 doc_example 这个 key"是合理内容，不该被当成夹具
    writeFileSync(
      join(dir, "project_test-convention.md"),
      [
        "---",
        "name: test_convention",
        "description: 记忆夹具测试约定",
        "type: project",
        "---",
        "",
        "doc_example 是 memory.test.ts 里的夹具 key。",
      ].join("\n"),
    );

    const out = await runDoctor();

    expect(out).toContain("无已知测试夹具条目");
  });
});
