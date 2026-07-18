/**
 * cronToHuman 人类可读描述测试（P2-17）
 */
import { describe, test, expect } from "bun:test";
import { cronToHuman } from "../../src/cron/describe.ts";

describe("cronToHuman", () => {
  test("每 N 分钟", () => {
    expect(cronToHuman("*/5 * * * *")).toBe("每 5 分钟");
    expect(cronToHuman("*/30 * * * *")).toBe("每 30 分钟");
  });

  test("每小时", () => {
    expect(cronToHuman("0 * * * *")).toBe("每小时整点");
    expect(cronToHuman("15 * * * *")).toBe("每小时第 15 分钟");
  });

  test("每 N 小时", () => {
    expect(cronToHuman("0 */2 * * *")).toBe("每 2 小时（第 0 分钟）");
  });

  test("每天固定时刻", () => {
    expect(cronToHuman("30 9 * * *")).toBe("每天 09:30");
    expect(cronToHuman("0 0 * * *")).toBe("每天 00:00");
  });

  test("工作日", () => {
    expect(cronToHuman("0 9 * * 1-5")).toBe("工作日 09:00");
  });

  test("每周某几天", () => {
    expect(cronToHuman("0 9 * * 1")).toBe("每周一 09:00");
    expect(cronToHuman("0 9 * * 1,3,5")).toBe("每周一、周三、周五 09:00");
    expect(cronToHuman("0 9 * * 0")).toBe("每周日 09:00");
  });

  test("每月某日", () => {
    expect(cronToHuman("0 8 1 * *")).toBe("每月 1 日 08:00");
  });

  test("识别不了的复杂表达式回落到原始 cron", () => {
    expect(cronToHuman("0 9 1,15 * *")).toBe("cron: 0 9 1,15 * *");
    expect(cronToHuman("5 4 * 6 2")).toBe("cron: 5 4 * 6 2");
  });

  test("非法字段数回落", () => {
    expect(cronToHuman("* * *")).toBe("cron: * * *");
  });
});
