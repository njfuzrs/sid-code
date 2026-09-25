import { test, expect, describe } from "bun:test";
import { formatStartupWarning } from "@sid-code/cli/ui/startup-warning.ts";

describe("formatStartupWarning", () => {
  test("单行文案加 path 前缀", () => {
    expect(formatStartupWarning("anthropicKey", "未设置")).toBe("anthropicKey: 未设置");
  });

  test("多行文案不加前缀", () => {
    const message = "环境变量 baseURL 被模型覆盖\n实际使用：https://model.example/v1";
    expect(formatStartupWarning("baseURL", message)).toBe(message);
  });
});
