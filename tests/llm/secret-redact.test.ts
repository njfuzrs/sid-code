/**
 * SecretRedactHook 单测 — ADR-026 §7 验收
 *
 * 覆盖:
 *   - §3.1 7 类 pattern 全部命中
 *   - §3.3 白名单段 3 类守护 (代码标识符 / 测试 fixture / markdown 占位)
 *   - 边界: 空文本 / 多重命中 / detect 模式 / 自定义注册
 *   - 误报率: 显式反例
 */

import { describe, test, expect } from "bun:test";
import { SecretRedactHook, getSharedSecretRedactHook } from "../../src/llm/hooks/secret-redact.ts";

describe("SecretRedactHook — 7 类 pattern 命中 (§3.1)", () => {
  test("GitHub Token (ghp_*) 被替换", () => {
    const hook = new SecretRedactHook();
    const r = hook.redact({
      text: "我的 token 是 ghp_AbCdEfGhIjKlMnOpQrStUvWxYz0123456789, 请保密",
      source: "memory_value",
    });
    expect(r.hasSecrets).toBe(true);
    expect(r.text).toContain("<REDACTED:github_token>");
    expect(r.text).not.toContain("ghp_AbCdEfGhIjKl");
    expect(r.hits[0].category).toBe("github_token");
  });

  test("GitHub Token 其他前缀 (gho_/ghu_/ghs_/ghr_) 也命中", () => {
    const hook = new SecretRedactHook();
    // 严格 36 字符尾段 (a-z 26 + 0-9 10 = 36)
    const tail36a = "abcdefghijklmnopqrstuvwxyz0123456789";
    const tail36b = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
    expect(tail36a.length).toBe(36);
    expect(tail36b.length).toBe(36);
    const text = `gho_${tail36a} and ghs_${tail36b}`;
    const r = hook.redact({ text, source: "llm_response" });
    expect(r.hasSecrets).toBe(true);
    expect(r.hits[0].count).toBe(2);
    expect(r.text).not.toContain(`gho_${tail36a}`);
    expect(r.text).not.toContain(`ghs_${tail36b}`);
  });

  test("OpenAI sk-* / sk-proj-* / sk-ant-* 被替换", () => {
    const hook = new SecretRedactHook();
    const r = hook.redact({
      text: "OPENAI_API_KEY=sk-proj-abcdefghijklmnopqrstuvwxyz012345 ANTHROPIC=sk-ant-AAAA1111BBBB2222CCCC3333",
      source: "llm_request",
    });
    expect(r.text).toContain("<REDACTED:llm_api_key>");
    expect(r.text).not.toContain("sk-proj-abc");
    expect(r.text).not.toContain("sk-ant-AAAA");
  });

  test("AWS Access Key (AKIA*) 被替换", () => {
    const hook = new SecretRedactHook();
    const r = hook.redact({
      text: "aws_access_key_id=AKIAJKLMNOPQRSTUVWXY",
      source: "tool_arg",
    });
    expect(r.text).toContain("<REDACTED:aws_access_key>");
    expect(r.text).not.toContain("AKIAJKLMNOPQRST");
  });

  test("AWS 官方占位 AKIAIOSFODNN7EXAMPLE 被守护跳过 (fixture)", () => {
    const hook = new SecretRedactHook();
    const r = hook.redact({
      text: "示例 access key: AKIAIOSFODNN7EXAMPLE",
      source: "memory_value",
    });
    // 不应被 redact (含 EXAMPLE 标记)
    expect(r.hasSecrets).toBe(false);
    expect(r.text).toContain("AKIAIOSFODNN7EXAMPLE");
  });

  test("Generic API Key 形式 (api_key=...) 保留 key 名仅 redact value", () => {
    const hook = new SecretRedactHook();
    const r = hook.redact({
      text: 'config: { api_key: "abcdef1234567890abcdef" }',
      source: "tool_arg",
    });
    expect(r.text).toContain("<REDACTED:api_key>");
    expect(r.text).toContain("api_key");
    expect(r.text).not.toContain("abcdef1234567890abcdef");
  });

  test("Bearer Token 被替换", () => {
    const hook = new SecretRedactHook();
    const r = hook.redact({
      text: "Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.aaa.bbb",
      source: "llm_request",
    });
    expect(r.text).toContain("Bearer <REDACTED:bearer_token>");
    expect(r.text).not.toContain("eyJhbGciOiJI");
  });

  test("Private Key 整段 (BEGIN..END) 被替换", () => {
    const hook = new SecretRedactHook();
    const text = `before
-----BEGIN RSA PRIVATE KEY-----
MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQDX1234567890
abcdefghijklmnopqrstuvwxyz
-----END RSA PRIVATE KEY-----
after`;
    const r = hook.redact({ text, source: "llm_response" });
    expect(r.text).toContain("<REDACTED:private_key>");
    expect(r.text).toContain("before");
    expect(r.text).toContain("after");
    expect(r.text).not.toContain("MIIEvQIBADAN");
  });

  test("DB Connection String 保留 schema/host, redact password", () => {
    const hook = new SecretRedactHook();
    const r = hook.redact({
      text: "DATABASE_URL=postgres://admin:supersecret123@db.example.com:5432/mydb",
      source: "memory_value",
    });
    expect(r.text).toContain("postgres://admin:<REDACTED:db_password>@db.example.com");
    expect(r.text).not.toContain("supersecret123");
  });

  test("MongoDB SRV 也命中", () => {
    const hook = new SecretRedactHook();
    const r2 = hook.redact({
      text: "mongodb+srv://user:simplepwd@cluster0.example.net/dbname",
      source: "tool_arg",
    });
    expect(r2.text).toContain("<REDACTED:db_password>");
  });
});

describe("SecretRedactHook — 白名单守护 (§3.3)", () => {
  test("代码标识符 (process.env) 不被 redact", () => {
    const hook = new SecretRedactHook();
    const r = hook.redact({
      text: 'const apiKey = process.env.API_KEY_FOR_GITHUB',
      source: "tool_arg",
    });
    // process.env.* 是合法代码引用, 不应误报
    expect(r.hasSecrets).toBe(false);
  });

  test("测试 fixture 标记 (含 EXAMPLE / FAKE) 不被 redact", () => {
    const hook = new SecretRedactHook();
    const r = hook.redact({
      text: "ghp_FAKEAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA and AKIAEXAMPLEKEYAAAA",
      source: "memory_value",
    });
    expect(r.hasSecrets).toBe(false);
  });

  test("markdown 代码块旁含'示例'锚点时跳过", () => {
    const hook = new SecretRedactHook();
    const r = hook.redact({
      text: "下面是占位示例 token: ghp_AbCdEfGhIjKlMnOpQrStUvWxYz0123456789",
      source: "llm_response",
    });
    expect(r.hasSecrets).toBe(false);
  });

  test("'placeholder' 英文锚点也跳过", () => {
    const hook = new SecretRedactHook();
    const r = hook.redact({
      text: "Replace this placeholder: AKIAIOSFODNN7AAAAAA",
      source: "tool_arg",
    });
    expect(r.hasSecrets).toBe(false);
  });
});

describe("SecretRedactHook — detect / 多重命中 / 边界", () => {
  test("空文本: hasSecrets=false, text 不变", () => {
    const hook = new SecretRedactHook();
    const r = hook.redact({ text: "", source: "memory_value" });
    expect(r.hasSecrets).toBe(false);
    expect(r.text).toBe("");
  });

  test("无 secret 文本: hasSecrets=false", () => {
    const hook = new SecretRedactHook();
    const r = hook.redact({
      text: "这是一段正常文本, 没有任何 secret",
      source: "llm_response",
    });
    expect(r.hasSecrets).toBe(false);
    expect(r.hits).toEqual([]);
  });

  test("多类 secret 同时出现: 各 category 独立计数", () => {
    const hook = new SecretRedactHook();
    const r = hook.redact({
      text:
        "github=ghp_AbCdEfGhIjKlMnOpQrStUvWxYz0123456789 " +
        "openai=sk-proj-realRealKEY1234567890abcdef " +
        "aws=AKIAJKLMNOPQRSTUVWXY",
      source: "memory_value",
    });
    expect(r.hasSecrets).toBe(true);
    const cats = r.hits.map((h) => h.category).sort();
    expect(cats).toEqual(["aws_access_key", "github_token", "llm_api_key"]);
  });

  test("detect 模式只检测不替换, 返回原始 match", () => {
    const hook = new SecretRedactHook();
    const matches = hook.detect("ghp_AbCdEfGhIjKlMnOpQrStUvWxYz0123456789");
    expect(matches.length).toBe(1);
    expect(matches[0].category).toBe("github_token");
    expect(matches[0].match).toMatch(/^ghp_/);
    expect(matches[0].start).toBe(0);
  });

  test("registerPattern 自定义企业 SDK key", () => {
    const hook = new SecretRedactHook();
    hook.registerPattern(
      "company_internal_key",
      /\bcomp_[A-Z0-9]{32}\b/g,
      () => "<REDACTED:company_key>",
    );
    const r = hook.redact({
      text: "internal=comp_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
      source: "memory_value",
    });
    expect(r.text).toContain("<REDACTED:company_key>");
    expect(r.hits[0].category).toBe("company_internal_key");
  });

  test("getSharedSecretRedactHook 返回单例", () => {
    const a = getSharedSecretRedactHook();
    const b = getSharedSecretRedactHook();
    expect(a).toBe(b);
  });
});

describe("SecretRedactHook — 误报率反例 (§3.3 验收)", () => {
  test("正常代码: 16+ 字符变量名不应被 generic api_key 误命中", () => {
    const hook = new SecretRedactHook();
    const r = hook.redact({
      text: "function getUserAccessToken(userId: string) { return fetchToken(userId); }",
      source: "tool_arg",
    });
    expect(r.hasSecrets).toBe(false);
  });

  test("commit hash 不被 GitHub Token 误命中 (40 hex)", () => {
    const hook = new SecretRedactHook();
    const r = hook.redact({
      text: "commit a524bfb1234567890abcdef1234567890abcdefab",
      source: "llm_response",
    });
    // commit hash 不带 ghp_ 前缀
    expect(r.hasSecrets).toBe(false);
  });

  test("URL path 不被 DB conn string 误命中 (无 user:pwd@)", () => {
    const hook = new SecretRedactHook();
    const r = hook.redact({
      text: "see https://example.com/postgres-tutorial for postgres docs",
      source: "llm_response",
    });
    expect(r.hasSecrets).toBe(false);
  });

  test("仅出现 'Bearer' 单词无 token 不命中", () => {
    const hook = new SecretRedactHook();
    const r = hook.redact({
      text: "the Bearer authentication scheme requires a token in HTTP",
      source: "llm_response",
    });
    expect(r.hasSecrets).toBe(false);
  });
});
