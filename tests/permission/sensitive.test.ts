/**
 * 敏感数据检测与遮盖测试
 */

import { describe, test, expect } from "bun:test";
import { detectSensitiveData, maskSensitiveData } from "../../src/permission/sensitive.ts";

describe("detectSensitiveData", () => {
  test("检测 AWS Access Key", () => {
    const matches = detectSensitiveData("key = AKIAIOSFODNN7EXAMPLE");
    expect(matches.length).toBeGreaterThanOrEqual(1);
    expect(matches.some(m => m.type === "AWS Access Key")).toBe(true);
  });

  test("检测阿里云 AccessKey", () => {
    const matches = detectSensitiveData("LTAI5tAbcDefGhiJkl");
    expect(matches.some(m => m.type === "阿里云 AccessKey")).toBe(true);
  });

  test("检测腾讯云 SecretId", () => {
    const matches = detectSensitiveData("AKID1234567890abcdef");
    expect(matches.some(m => m.type === "腾讯云 SecretId")).toBe(true);
  });

  test("检测 Anthropic API Key", () => {
    const matches = detectSensitiveData("sk-ant-api03-abcdefghijklmnopqrstuvwxyz");
    expect(matches.some(m => m.type === "Anthropic API Key")).toBe(true);
  });

  test("检测 OpenAI API Key", () => {
    const matches = detectSensitiveData("sk-proj1234567890abcdefghij");
    expect(matches.some(m => m.type === "OpenAI API Key")).toBe(true);
  });

  test("检测 GitHub Token", () => {
    const matches = detectSensitiveData("ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijkl");
    expect(matches.some(m => m.type === "GitHub Token")).toBe(true);
  });

  test("检测 GitLab Token", () => {
    const matches = detectSensitiveData("glpat-xxxxxxxxxxxxxxxxxxxx");
    expect(matches.some(m => m.type === "GitLab Token")).toBe(true);
  });

  test("检测 Bearer Token", () => {
    const matches = detectSensitiveData("Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9");
    expect(matches.some(m => m.type === "Bearer Token")).toBe(true);
  });

  test("检测 JWT", () => {
    const matches = detectSensitiveData("eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U");
    expect(matches.some(m => m.type === "JWT")).toBe(true);
  });

  test("检测数据库连接串", () => {
    const matches = detectSensitiveData("mysql://root:password@localhost:3306/mydb");
    expect(matches.some(m => m.type === "DB 连接串")).toBe(true);
  });

  test("检测密码赋值", () => {
    const matches = detectSensitiveData('password = "my_secret_password_123"');
    expect(matches.some(m => m.type === "密码赋值")).toBe(true);
  });

  test("检测 SSH 私钥头", () => {
    const matches = detectSensitiveData("-----BEGIN RSA PRIVATE KEY-----");
    expect(matches.some(m => m.type === "SSH 私钥")).toBe(true);
  });

  test("检测 Slack Token", () => {
    const matches = detectSensitiveData("xoxb-1234567890-abcdefghij");
    expect(matches.some(m => m.type === "Slack Token")).toBe(true);
  });

  test("检测 npm Token", () => {
    const matches = detectSensitiveData("npm_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijkl");
    expect(matches.some(m => m.type === "npm Token")).toBe(true);
  });

  test("无敏感数据返回空数组", () => {
    const matches = detectSensitiveData("这是一段普通文本，没有任何敏感信息");
    expect(matches).toEqual([]);
  });

  test("同一文本中检测多种敏感数据", () => {
    const text = "AKIAIOSFODNN7EXAMPLE sk-ant-api03-abcdefghijklmnopqrstuvwxyz";
    const matches = detectSensitiveData(text);
    expect(matches.length).toBeGreaterThanOrEqual(2);
    const types = matches.map(m => m.type);
    expect(types).toContain("AWS Access Key");
    expect(types).toContain("Anthropic API Key");
  });
});

describe("maskSensitiveData", () => {
  test("遮盖 AWS Access Key", () => {
    const result = maskSensitiveData("key = AKIAIOSFODNN7EXAMPLE");
    expect(result).toContain("AKIA");
    expect(result).not.toContain("AKIAIOSFODNN7EXAMPLE");
    expect(result).toContain("****");
  });

  test("遮盖 Anthropic API Key", () => {
    const result = maskSensitiveData("sk-ant-api03-abcdefghijklmnopqrstuvwxyz");
    expect(result).toContain("sk-ant-");
    expect(result).toContain("****");
    expect(result).not.toContain("abcdefghijklmnopqrstuvwxyz");
  });

  test("遮盖 OpenAI API Key", () => {
    const result = maskSensitiveData("sk-proj1234567890abcdefghij");
    expect(result).toContain("sk-");
    expect(result).toContain("****");
  });

  test("不修改普通文本", () => {
    const text = "这是一段普通文本";
    expect(maskSensitiveData(text)).toBe(text);
  });

  test("遮盖多个敏感数据", () => {
    const text = "aws: AKIAIOSFODNN7EXAMPLE, github: ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijkl";
    const result = maskSensitiveData(text);
    expect(result).not.toContain("AKIAIOSFODNN7EXAMPLE");
    expect(result).not.toContain("ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijkl");
  });

  test("遮盖数据库连接串中的密码", () => {
    const result = maskSensitiveData("postgres://admin:supersecret@db.example.com:5432/prod");
    expect(result).toContain("postgres:");
    expect(result).toContain("*");
    expect(result).not.toContain("supersecret");
  });
});
