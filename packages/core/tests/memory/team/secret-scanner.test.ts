/**
 * 团队记忆密钥扫描器测试（E.11）
 *
 * 验证 gitleaks 子集规则的命中、不返回明文、redact 行为、label 派生。
 */

import { describe, test, expect } from "bun:test";
import {
  scanForSecrets,
  redactSecrets,
  getSecretLabel,
} from "@sid-code/core/memory/team/secret-scanner.ts";

describe("secret-scanner — 命中检测", () => {
  test("GitHub PAT 命中且 label 正确", () => {
    const content = "token: ghp_" + "a".repeat(36);
    const hits = scanForSecrets(content);
    expect(hits.length).toBeGreaterThan(0);
    expect(hits.some((h) => h.ruleId === "github-pat")).toBe(true);
    const gh = hits.find((h) => h.ruleId === "github-pat")!;
    expect(gh.label).toBe("GitHub PAT");
  });

  test("AWS access token 命中", () => {
    const content = "aws key AKIAIOSFODNN7EXAMPLE here";
    const hits = scanForSecrets(content);
    expect(hits.some((h) => h.ruleId === "aws-access-token")).toBe(true);
  });

  test("private key 命中", () => {
    const content =
      "-----BEGIN RSA PRIVATE KEY-----\n" +
      "MIIBderp".repeat(20) +
      "\n-----END RSA PRIVATE KEY-----";
    const hits = scanForSecrets(content);
    expect(hits.some((h) => h.ruleId === "private-key")).toBe(true);
  });

  test("Slack bot token 命中", () => {
    const content = "xoxb-1234567890-0987654321-abcdefghijklmnop";
    const hits = scanForSecrets(content);
    expect(hits.some((h) => h.ruleId === "slack-bot-token")).toBe(true);
  });

  test("DeepSeek/通用 sk-32hex key 命中（国产模型补充规则）", () => {
    const content = "DEEPSEEK_API_KEY=sk-" + "0123456789abcdef0123456789abcdef";
    const hits = scanForSecrets(content);
    expect(hits.some((h) => h.ruleId === "deepseek-api-key")).toBe(true);
  });

  test("普通团队记忆内容不误报", () => {
    const content = `# 团队约定
- 统一用 4 空格缩进
- PR 标题不超过 70 字符
- 提交信息用中文
- 数据库连接走 process.env.DATABASE_URL`;
    const hits = scanForSecrets(content);
    expect(hits.length).toBe(0);
  });

  test("结果只含 ruleId+label，绝不含明文 secret", () => {
    const secret = "ghp_" + "b".repeat(36);
    const hits = scanForSecrets(`token=${secret}`);
    const serialized = JSON.stringify(hits);
    expect(serialized).not.toContain(secret);
    expect(serialized).not.toContain("b".repeat(36));
  });

  test("同一规则多次命中只返回一项（去重）", () => {
    const content = `ghp_${"a".repeat(36)} 和 ghp_${"c".repeat(36)}`;
    const hits = scanForSecrets(content);
    expect(hits.filter((h) => h.ruleId === "github-pat").length).toBe(1);
  });
});

describe("secret-scanner — redact", () => {
  test("redact 替换 secret 为 [REDACTED] 且保留周边文本", () => {
    const secret = "ghp_" + "d".repeat(36);
    const out = redactSecrets(`前缀 ${secret} 后缀`);
    expect(out).toContain("前缀");
    expect(out).toContain("后缀");
    expect(out).toContain("[REDACTED]");
    expect(out).not.toContain(secret);
  });

  test("无 secret 时 redact 原样返回", () => {
    const content = "完全干净的文本";
    expect(redactSecrets(content)).toBe(content);
  });
});

describe("secret-scanner — label 派生", () => {
  test("特例大写映射", () => {
    expect(getSecretLabel("github-pat")).toBe("GitHub PAT");
    expect(getSecretLabel("aws-access-token")).toBe("AWS Access Token");
    expect(getSecretLabel("gcp-api-key")).toBe("GCP API Key");
    expect(getSecretLabel("openai-api-key")).toBe("OpenAI API Key");
  });

  test("未知 id 回退 Title Case", () => {
    expect(getSecretLabel("foo-bar")).toBe("Foo Bar");
  });
});
