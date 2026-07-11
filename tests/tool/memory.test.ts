/**
 * MemoryTool save_memory 工具集成测试
 *
 * 验证 ADR-026 §4.2 第 3 项 — 写盘前 secret-redact 拒绝.
 * 不关心 store 持久化细节, 只验证 hook 介入后的 ToolResult.
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryTool } from "../../src/tool/memory.ts";
import { MemoryStore } from "../../src/memory/store.ts";

let tmpRoot: string;

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), "sid-mem-test-"));
});

afterEach(() => {
  try {
    rmSync(tmpRoot, { recursive: true, force: true });
  } catch {}
});

function makeTool() {
  const store = new MemoryStore(tmpRoot);
  return new MemoryTool(store);
}

describe("MemoryTool save_memory — ADR-026 secret 拦截", () => {
  test("正常 value 可以保存", async () => {
    const tool = makeTool();
    const r = await tool.execute({
      key: "coding_style",
      value: "prefer 2-space indent in TypeScript",
      scope: "project",
    });
    expect(r.isError).toBeFalsy();
    expect(r.output).toContain("记忆已保存");
  });

  test("含 GitHub Token 的 value 被拒绝写入", async () => {
    const tool = makeTool();
    const r = await tool.execute({
      key: "my_token",
      value: "我的 token 是 ghp_AbCdEfGhIjKlMnOpQrStUvWxYz0123456789",
      scope: "project",
    });
    expect(r.isError).toBe(true);
    expect(r.output).toContain("敏感信息");
    expect(r.output).toContain("github_token");
    // 关键: 必须包含安全建议 (引导 LLM 不再尝试)
    expect(r.output).toMatch(/\.env|环境变量|process\.env/);
  });

  test("含 OpenAI API Key 被拒绝", async () => {
    const tool = makeTool();
    const r = await tool.execute({
      key: "openai_key",
      value: "OPENAI_API_KEY=sk-proj-abcdefghijklmnopqrstuvwxyz012345",
      scope: "global",
    });
    expect(r.isError).toBe(true);
    expect(r.output).toContain("llm_api_key");
  });

  test("含 DB connection string 被拒绝", async () => {
    const tool = makeTool();
    const r = await tool.execute({
      key: "db",
      value: "数据库地址 postgres://admin:supersecret123@db.example.com/mydb",
      scope: "project",
    });
    expect(r.isError).toBe(true);
    expect(r.output).toContain("db_conn_string");
  });

  test("含 Bearer token 被拒绝", async () => {
    const tool = makeTool();
    const r = await tool.execute({
      key: "auth",
      value: "Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.aaa.bbb",
      scope: "project",
    });
    expect(r.isError).toBe(true);
    expect(r.output).toContain("bearer_token");
  });

  test("代码标识符 (process.env) 不被误判", async () => {
    const tool = makeTool();
    const r = await tool.execute({
      key: "code_pattern",
      value: "在配置加载层用 const apiKey = process.env.API_KEY_FOR_GITHUB",
      scope: "project",
    });
    expect(r.isError).toBeFalsy();
  });

  test("含 EXAMPLE 占位的 token-like 字符串不被误判", async () => {
    const tool = makeTool();
    const r = await tool.execute({
      key: "doc_example",
      value: "AWS 文档示例: AKIAIOSFODNN7EXAMPLE",
      scope: "global",
    });
    expect(r.isError).toBeFalsy();
  });
});

describe("MemoryTool save_memory — G13 agent scope", () => {
  let tmpHome: string;
  let prevEnv: string | undefined;

  beforeEach(() => {
    prevEnv = process.env.SID_CONFIG_DIR;
    tmpHome = mkdtempSync(join(tmpdir(), "sid-agentscope-"));
    process.env.SID_CONFIG_DIR = tmpHome;
  });

  afterEach(() => {
    if (prevEnv === undefined) delete process.env.SID_CONFIG_DIR;
    else process.env.SID_CONFIG_DIR = prevEnv;
    try {
      rmSync(tmpHome, { recursive: true, force: true });
    } catch {}
  });

  test("主会话（无 agentType）用 agent scope 被引导改用 project/global", async () => {
    const tool = new MemoryTool(new MemoryStore(tmpHome));
    const r = await tool.execute({ key: "k", value: "v", scope: "agent" });
    expect(r.isError).toBe(true);
    expect(r.output).toContain("agent 范围仅在子代理内可用");
  });

  test("子代理（有 agentType）用 agent scope 成功写入并可读回", async () => {
    const tool = new MemoryTool(new MemoryStore(tmpHome), "code-review");
    const r = await tool.execute({
      key: "review-habit",
      value: "本仓 review 关注错误处理路径的覆盖",
      scope: "agent",
    });
    expect(r.isError).toBeFalsy();
    expect(r.output).toContain("agent 范围");

    const { getAgentIndexContent } = await import("../../src/memory/agent-store.ts");
    const idx = await getAgentIndexContent("code-review");
    expect(idx).toContain("review-habit");
  });

  test("agent scope 仍走 secret 拦截（含 token 被拒）", async () => {
    const tool = new MemoryTool(new MemoryStore(tmpHome), "security-audit");
    const r = await tool.execute({
      key: "leak",
      value: "token 是 ghp_AbCdEfGhIjKlMnOpQrStUvWxYz0123456789",
      scope: "agent",
    });
    expect(r.isError).toBe(true);
    expect(r.output).toContain("敏感信息");
  });
});
