/**
 * 缺口 A：间隔字符串 → cron 转换单测
 */

import { describe, it, expect } from "bun:test";
import { parseIntervalToSeconds, intervalToCron } from "@sid-code/core/cron/interval.ts";

describe("parseIntervalToSeconds", () => {
  it("纯数字按分钟", () => {
    expect(parseIntervalToSeconds("5")).toBe(300);
    expect(parseIntervalToSeconds("1")).toBe(60);
  });

  it("单位 h/m/s", () => {
    expect(parseIntervalToSeconds("30s")).toBe(30);
    expect(parseIntervalToSeconds("5m")).toBe(300);
    expect(parseIntervalToSeconds("1h")).toBe(3600);
  });

  it("组合单位", () => {
    expect(parseIntervalToSeconds("1h30m")).toBe(5400);
    expect(parseIntervalToSeconds("2h30m")).toBe(9000);
  });

  it("大小写不敏感 + 容忍空格", () => {
    expect(parseIntervalToSeconds("5M")).toBe(300);
    expect(parseIntervalToSeconds("1H 30M")).toBe(5400);
  });

  it("拒绝非法输入", () => {
    expect(parseIntervalToSeconds("")).toBeNull();
    expect(parseIntervalToSeconds("abc")).toBeNull();
    expect(parseIntervalToSeconds("5x")).toBeNull();
    expect(parseIntervalToSeconds("0")).toBeNull();
    expect(parseIntervalToSeconds("5m3")).toBeNull(); // 残留数字
  });
});

describe("intervalToCron", () => {
  it("能整除 60 的分钟 → */N", () => {
    expect(intervalToCron("5m")?.cron).toBe("*/5 * * * *");
    expect(intervalToCron("15m")?.cron).toBe("*/15 * * * *");
    expect(intervalToCron("30m")?.cron).toBe("*/30 * * * *");
    expect(intervalToCron("1")?.cron).toBe("*/1 * * * *");
  });

  it("整小时且整除 24 → 0 */H", () => {
    expect(intervalToCron("1h")?.cron).toBe("0 */1 * * *");
    expect(intervalToCron("2h")?.cron).toBe("0 */2 * * *");
    expect(intervalToCron("12h")?.cron).toBe("0 */12 * * *");
  });

  it("不能精确表达的间隔返回 null", () => {
    expect(intervalToCron("7m")).toBeNull(); // 60 % 7 != 0
    expect(intervalToCron("90m")).toBeNull(); // 1.5 小时，非整小时
    expect(intervalToCron("5h")).toBeNull(); // 24 % 5 != 0
    expect(intervalToCron("25h")).toBeNull(); // > 24 小时
  });

  it("秒级不足 1 分钟向上取整到 1 分钟", () => {
    expect(intervalToCron("30s")?.cron).toBe("*/1 * * * *");
  });

  it("非法输入返回 null", () => {
    expect(intervalToCron("abc")).toBeNull();
  });
});
