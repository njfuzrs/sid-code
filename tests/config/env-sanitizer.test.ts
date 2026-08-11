import { describe, test, expect } from "bun:test";
import { sanitizeEnv, isEnvVarSafe } from "@sid-code/core/config/env-sanitizer.ts";

describe("Environment Variable Sanitizer", () => {
  const testEnv = {
    // 安全变量
    PATH: "/usr/bin:/bin",
    HOME: "/home/user",
    SHELL: "/bin/bash",
    NODE_ENV: "development",
    // 敏感变量（黑名单）
    DATABASE_URL: "postgres://user:pass@localhost/db",
    AWS_SECRET_ACCESS_KEY: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
    GITHUB_TOKEN: "ghp_1234567890abcdefghijklmnopqrstuvwxyz",
    // 敏感变量（模式匹配）
    MY_API_KEY: "sk-1234567890abcdefghijklmnopqrstuvwxyz",
    SECRET_TOKEN: "secret-value-123",
    CUSTOM_PASSWORD: "password123",
  };

  test("preserves safe system variables", () => {
    const result = sanitizeEnv(testEnv);
    expect(result.PATH).toBe("/usr/bin:/bin");
    expect(result.HOME).toBe("/home/user");
    expect(result.SHELL).toBe("/bin/bash");
    expect(result.NODE_ENV).toBe("development");
  });

  test("removes blacklisted variables", () => {
    const result = sanitizeEnv(testEnv);
    expect(result.DATABASE_URL).toBeUndefined();
    expect(result.AWS_SECRET_ACCESS_KEY).toBeUndefined();
    expect(result.GITHUB_TOKEN).toBeUndefined();
  });

  test("removes variables matching sensitive patterns", () => {
    const result = sanitizeEnv(testEnv);
    expect(result.MY_API_KEY).toBeUndefined();
    expect(result.SECRET_TOKEN).toBeUndefined();
    expect(result.CUSTOM_PASSWORD).toBeUndefined();
  });

  test("respects extra allowed variables", () => {
    const result = sanitizeEnv(testEnv, {
      extraAllowed: ["MY_API_KEY"],
    });
    expect(result.MY_API_KEY).toBe("sk-1234567890abcdefghijklmnopqrstuvwxyz");
  });

  test("respects extra denied variables", () => {
    const result = sanitizeEnv(testEnv, {
      extraDenied: ["NODE_ENV"],
    });
    expect(result.NODE_ENV).toBeUndefined();
  });

  test("isEnvVarSafe detects sensitive names", () => {
    expect(isEnvVarSafe("API_KEY", "value").safe).toBe(false);
    expect(isEnvVarSafe("SECRET", "value").safe).toBe(false);
    expect(isEnvVarSafe("PASSWORD", "value").safe).toBe(false);
    expect(isEnvVarSafe("TOKEN", "value").safe).toBe(false);
  });

  test("isEnvVarSafe detects sensitive values", () => {
    expect(isEnvVarSafe("KEY", "sk-1234567890abcdefghijklmnopqrstuvwxyz").safe).toBe(false);
    expect(isEnvVarSafe("KEY", "ghp_1234567890abcdefghijklmnopqrstuvwxyz").safe).toBe(false);
    expect(isEnvVarSafe("KEY", "-----BEGIN PRIVATE KEY-----").safe).toBe(false);
  });

  test("isEnvVarSafe allows safe variables", () => {
    expect(isEnvVarSafe("PATH", "/usr/bin").safe).toBe(true);
    expect(isEnvVarSafe("NODE_ENV", "development").safe).toBe(true);
    expect(isEnvVarSafe("DEBUG", "true").safe).toBe(true);
  });
});
