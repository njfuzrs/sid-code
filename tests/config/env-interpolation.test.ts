import { describe, test, expect } from "bun:test";
import { resolveEnvVars } from "../../src/config/env-interpolation.ts";

describe("Environment Variable Interpolation", () => {
  const testEnv = {
    API_KEY: "test-key-123",
    BASE_URL: "https://api.example.com",
    PORT: "3000",
    EMPTY_VAR: "",
  };

  test("interpolates $VAR format", () => {
    const input = { key: "$API_KEY" };
    const result = resolveEnvVars(input, testEnv);
    expect(result.key).toBe("test-key-123");
  });

  test("interpolates ${VAR} format", () => {
    const input = { url: "${BASE_URL}/v1" };
    const result = resolveEnvVars(input, testEnv);
    expect(result.url).toBe("https://api.example.com/v1");
  });

  test("preserves undefined variables", () => {
    const input = { key: "$UNDEFINED_VAR" };
    const result = resolveEnvVars(input, testEnv);
    expect(result.key).toBe("$UNDEFINED_VAR");
  });

  test("handles nested objects", () => {
    const input = {
      server: {
        url: "$BASE_URL",
        port: "$PORT",
      },
    };
    const result = resolveEnvVars(input, testEnv);
    expect(result.server.url).toBe("https://api.example.com");
    expect(result.server.port).toBe("3000");
  });

  test("handles arrays", () => {
    const input = {
      urls: ["$BASE_URL/v1", "$BASE_URL/v2"],
    };
    const result = resolveEnvVars(input, testEnv);
    expect(result.urls[0]).toBe("https://api.example.com/v1");
    expect(result.urls[1]).toBe("https://api.example.com/v2");
  });

  test("does not interpolate non-string values", () => {
    const input = {
      number: 123,
      boolean: true,
      null: null,
    };
    const result = resolveEnvVars(input, testEnv);
    expect(result.number).toBe(123);
    expect(result.boolean).toBe(true);
    expect(result.null).toBe(null);
  });

  test("handles mixed interpolation", () => {
    const input = { url: "${BASE_URL}:$PORT/api" };
    const result = resolveEnvVars(input, testEnv);
    expect(result.url).toBe("https://api.example.com:3000/api");
  });

  test("handles empty variable values", () => {
    const input = { key: "$EMPTY_VAR" };
    const result = resolveEnvVars(input, testEnv);
    expect(result.key).toBe("");
  });
});
