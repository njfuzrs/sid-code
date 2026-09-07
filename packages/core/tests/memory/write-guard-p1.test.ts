/**
 * P1-8 / P1-9 防复发：secret 闸门不再只覆盖一条记忆线；后台代理不再越权写 scope
 *
 * ─── P1-8 ───
 * 四条记忆线里此前只有 team 那条有 write/edit 闸门；**私有记忆与 agent 记忆整条没有**。
 * 关键不是「私有记忆不重要」，而是**同一个后台提取代理有两条权限相同的路径**
 * （`save_memory` 与 `write`/`edit`），其中一条有闸门、另一条没有 ——
 * 不对称的防护等于没有防护，模型换条路就绕过了。
 *
 * ─── P1-9 ───
 * `createExtractPermissions` 旧代码对 `save_memory` 无条件 `allow`，注释称
 * 「内部已写入 memoryDir」，但四个 scope 里有三个落在 memoryDir 之外
 * （global 跨所有项目、team 会同步给全体协作者、agent 是另一棵树）。
 *
 * ⚠️ 变异自证：逐条确认过「把对应守卫去掉就变红」。
 * secret 样本刻意避开 fixtureGuard 的 EXAMPLE/FAKE/示例 等标记 ——
 * 带那些词的样本会被判为占位符而放行，那样的用例在修复前后都绿，测不到东西。
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { checkPrivateMemSecrets } from "@sid-code/core/memory/write-guard.ts";
import { createExtractPermissions } from "@sid-code/core/memory/extract/permissions.ts";
import { getAutoMemPath, getAgentMemPath } from "@sid-code/core/memory/paths.ts";

/** 真实形态的凭证样本（不含 fixture 标记，故不会被 falsePositiveGuard 放行） */
const AWS_KEY = "AKIA2Z7QWJ4RNPXV8KLM";
const DB_CONN = "postgres://admin:s3cr3tpwd@db.internal:5432/prod";

let tmpHome: string;
let prevConfigDir: string | undefined;

beforeAll(() => {
  tmpHome = mkdtempSync(join(tmpdir(), "sid-wg-home-"));
  prevConfigDir = process.env.SID_CONFIG_DIR;
  process.env.SID_CONFIG_DIR = tmpHome;
});

afterAll(() => {
  if (prevConfigDir === undefined) delete process.env.SID_CONFIG_DIR;
  else process.env.SID_CONFIG_DIR = prevConfigDir;
  try {
    rmSync(tmpHome, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

describe("P1-8 私有记忆目录的 write/edit secret 闸门", () => {
  test("写私有记忆目录时命中 secret → 返回拒绝理由", () => {
    const target = join(getAutoMemPath(process.cwd()), "reference_creds.md");
    const err = checkPrivateMemSecrets(target, `凭证如下 ${AWS_KEY} 请勿外传`);
    expect(err).not.toBeNull();
    // 理由里要点明命中类别，且**不能回显命中的明文**（拒绝信息本身也会进上下文）
    expect(err).toContain("aws_access_key");
    expect(err).not.toContain(AWS_KEY);
  });

  test("报错栈里的连接串同样被拦（generic 规则，team 那套 gitleaks 子集覆盖不到）", () => {
    const target = join(getAutoMemPath(process.cwd()), "reference_stack.md");
    const content = `复现步骤：启动失败，日志里是 ${DB_CONN}`;
    expect(checkPrivateMemSecrets(target, content)).not.toBeNull();
  });

  test("agent 记忆目录同样被覆盖（第四条记忆线）", () => {
    const target = join(getAgentMemPath("code-review"), "reference_x.md");
    expect(checkPrivateMemSecrets(target, `token ${AWS_KEY}`)).not.toBeNull();
  });

  test("干净内容放行", () => {
    const target = join(getAutoMemPath(process.cwd()), "reference_clean.md");
    expect(checkPrivateMemSecrets(target, "用户偏好：提交信息用中文，不要 emoji")).toBeNull();
  });

  test("非记忆路径不干预（闸门只管记忆目录，不做全局内容审查）", () => {
    expect(checkPrivateMemSecrets("/tmp/some-project/src/config.ts", `key ${AWS_KEY}`)).toBeNull();
  });
});

describe("P1-9 后台提取代理的 save_memory 只能写 project scope", () => {
  const memDir = "/tmp/sid-extract-memdir";
  const perms = () => createExtractPermissions(memDir);

  test("默认 scope（未传）放行 —— MemoryTool 按 project 处理", async () => {
    const r = await perms()("save_memory", { key: "k", value: "v" });
    expect(r.behavior).toBe("allow");
  });

  test("显式 project 放行", async () => {
    const r = await perms()("save_memory", { key: "k", value: "v", scope: "project" });
    expect(r.behavior).toBe("allow");
  });

  test("global 被拒（会污染所有项目的会话）", async () => {
    const r = await perms()("save_memory", { key: "k", value: "v", scope: "global" });
    expect(r.behavior).toBe("deny");
  });

  test("team 被拒（启用团队记忆后会同步给全体协作者）", async () => {
    const r = await perms()("save_memory", { key: "k", value: "v", scope: "team" });
    expect(r.behavior).toBe("deny");
  });

  test("agent 被拒", async () => {
    const r = await perms()("save_memory", { key: "k", value: "v", scope: "agent" });
    expect(r.behavior).toBe("deny");
  });

  test("write/edit 仍按**路径**收窄（两个维度各管一半，别只留一个）", async () => {
    const inside = await perms()("write", {
      file_path: join(memDir, "reference_a.md"),
      content: "x",
    });
    expect(inside.behavior).toBe("allow");

    const outside = await perms()("write", { file_path: "/etc/hosts", content: "x" });
    expect(outside.behavior).toBe("deny");
  });
});
