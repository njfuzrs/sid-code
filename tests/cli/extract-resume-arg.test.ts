/**
 * extractResumeArg 三态解析测试
 *
 * 背景：`-r` / `--resume` 对齐 claude-code 的 `[value]` 可选值语义——
 * parseArgs 的 type:"string" 强制带值（`sid-code -r` 单独出现会报 argument missing），
 * 故手动预扫描 argv 抽取 resume，得到三态：
 *   - 未出现       → { present:false }
 *   - 出现不带值   → { present:true, picker:true }        开选择器
 *   - 出现且带值   → { present:true, value:"<v>" }        ID / 索引 / 搜索词
 * 并把相关 token 从 argv 剔除（rest），交给 parseArgs 处理其余选项。
 */

import { describe, test, expect } from "bun:test";
import { extractResumeArg } from "@sid-code/cli/cli.ts";

describe("extractResumeArg", () => {
  test("未出现 resume → present=false，rest 原样保留", () => {
    const r = extractResumeArg(["--model", "opus", "hello"]);
    expect(r.present).toBe(false);
    expect(r.picker).toBe(false);
    expect(r.value).toBeUndefined();
    expect(r.rest).toEqual(["--model", "opus", "hello"]);
  });

  test("-r 单独出现（无值）→ 开选择器", () => {
    const r = extractResumeArg(["-r"]);
    expect(r.present).toBe(true);
    expect(r.picker).toBe(true);
    expect(r.value).toBeUndefined();
    expect(r.rest).toEqual([]);
  });

  test("--resume 单独出现（无值）→ 开选择器", () => {
    const r = extractResumeArg(["--resume"]);
    expect(r.present).toBe(true);
    expect(r.picker).toBe(true);
    expect(r.value).toBeUndefined();
  });

  test("-r 后紧跟另一个选项 → 视为无值开选择器，不吞掉后续选项", () => {
    const r = extractResumeArg(["-r", "--model", "opus"]);
    expect(r.present).toBe(true);
    expect(r.picker).toBe(true);
    expect(r.value).toBeUndefined();
    expect(r.rest).toEqual(["--model", "opus"]);
  });

  test("-r <值> → 带值，值 token 被消费（不掉进 positionals）", () => {
    const r = extractResumeArg(["-r", "20260101-120000-abcd"]);
    expect(r.present).toBe(true);
    expect(r.picker).toBe(false);
    expect(r.value).toBe("20260101-120000-abcd");
    expect(r.rest).toEqual([]);
  });

  test("--resume <值> → 带值", () => {
    const r = extractResumeArg(["--resume", "3"]);
    expect(r.value).toBe("3");
    expect(r.picker).toBe(false);
  });

  test("--resume=<值> 等号形式 → 带值", () => {
    const r = extractResumeArg(["--resume=myterm"]);
    expect(r.present).toBe(true);
    expect(r.value).toBe("myterm");
    expect(r.picker).toBe(false);
  });

  test("-r=<值> 短选项等号形式 → 带值", () => {
    const r = extractResumeArg(["-r=xyz"]);
    expect(r.value).toBe("xyz");
    expect(r.picker).toBe(false);
  });

  test("-r<值> 短选项紧贴形式 → 带值", () => {
    const r = extractResumeArg(["-rfoo"]);
    expect(r.value).toBe("foo");
    expect(r.picker).toBe(false);
  });

  test("resume 值中含空格（搜索词）→ 完整保留", () => {
    const r = extractResumeArg(["-r", "恢复 对话"]);
    expect(r.value).toBe("恢复 对话");
  });

  test("resume 与其它选项混排 → 其它选项进 rest", () => {
    const r = extractResumeArg(["--model", "opus", "-r", "myterm", "--debug"]);
    expect(r.value).toBe("myterm");
    expect(r.rest).toEqual(["--model", "opus", "--debug"]);
  });

  test("--resume= 空值等号形式 → 值为空串（不视为 picker）", () => {
    // 等号显式给了空值，与「完全不带值」区分：这里 value="" present=true。
    // 下游 mergeConfig 会把空串当未设，最终既非 picker 也无有效 resume；
    // 属于用户显式敲空值的边界，保持解析层忠实即可。
    const r = extractResumeArg(["--resume="]);
    expect(r.present).toBe(true);
    expect(r.value).toBe("");
    expect(r.picker).toBe(false);
  });
});
