/**
 * 敏感数据检测与遮盖测试
 */

import { describe, test, expect } from "bun:test";
import {
  detectSensitiveData,
  maskSensitiveData,
  maskSensitiveJson,
} from "@sid-code/core/permission/sensitive.ts";

describe("detectSensitiveData", () => {
  test("检测 AWS Access Key", () => {
    const matches = detectSensitiveData("key = AKIAIOSFODNN7EXAMPLE");
    expect(matches.length).toBeGreaterThanOrEqual(1);
    expect(matches.some((m) => m.type === "AWS Access Key")).toBe(true);
  });

  test("检测阿里云 AccessKey", () => {
    const matches = detectSensitiveData("LTAI5tAbcDefGhiJkl");
    expect(matches.some((m) => m.type === "阿里云 AccessKey")).toBe(true);
  });

  test("检测腾讯云 SecretId", () => {
    const matches = detectSensitiveData("AKID1234567890abcdef");
    expect(matches.some((m) => m.type === "腾讯云 SecretId")).toBe(true);
  });

  test("检测 Anthropic API Key", () => {
    const matches = detectSensitiveData("sk-ant-api03-abcdefghijklmnopqrstuvwxyz");
    expect(matches.some((m) => m.type === "Anthropic API Key")).toBe(true);
  });

  test("检测 OpenAI API Key", () => {
    const matches = detectSensitiveData("sk-proj1234567890abcdefghij");
    expect(matches.some((m) => m.type === "OpenAI API Key")).toBe(true);
  });

  test("检测 GitHub Token", () => {
    const matches = detectSensitiveData("ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijkl");
    expect(matches.some((m) => m.type === "GitHub Token")).toBe(true);
  });

  test("检测 GitLab Token", () => {
    const matches = detectSensitiveData("glpat-xxxxxxxxxxxxxxxxxxxx");
    expect(matches.some((m) => m.type === "GitLab Token")).toBe(true);
  });

  test("检测 Bearer Token", () => {
    const matches = detectSensitiveData(
      "Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9",
    );
    expect(matches.some((m) => m.type === "Bearer Token")).toBe(true);
  });

  test("检测 JWT", () => {
    const matches = detectSensitiveData(
      "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U",
    );
    expect(matches.some((m) => m.type === "JWT")).toBe(true);
  });

  test("检测数据库连接串", () => {
    const matches = detectSensitiveData("mysql://root:password@localhost:3306/mydb");
    expect(matches.some((m) => m.type === "DB 连接串")).toBe(true);
  });

  test("检测密码赋值", () => {
    const matches = detectSensitiveData('password = "my_secret_password_123"');
    expect(matches.some((m) => m.type === "密码赋值")).toBe(true);
  });

  test("检测 SSH 私钥头", () => {
    const matches = detectSensitiveData("-----BEGIN RSA PRIVATE KEY-----");
    expect(matches.some((m) => m.type === "SSH 私钥")).toBe(true);
  });

  test("检测 Slack Token", () => {
    const matches = detectSensitiveData("xoxb-1234567890-abcdefghij");
    expect(matches.some((m) => m.type === "Slack Token")).toBe(true);
  });

  test("检测 npm Token", () => {
    const matches = detectSensitiveData("npm_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijkl");
    expect(matches.some((m) => m.type === "npm Token")).toBe(true);
  });

  test("无敏感数据返回空数组", () => {
    const matches = detectSensitiveData("这是一段普通文本，没有任何敏感信息");
    expect(matches).toEqual([]);
  });

  test("同一文本中检测多种敏感数据", () => {
    const text = "AKIAIOSFODNN7EXAMPLE sk-ant-api03-abcdefghijklmnopqrstuvwxyz";
    const matches = detectSensitiveData(text);
    expect(matches.length).toBeGreaterThanOrEqual(2);
    const types = matches.map((m) => m.type);
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

/**
 * 回归：信用卡号规则曾把 JSON 小数的尾数当卡号（2026-08-07 真实事故）。
 *
 * `"total_cost_usd": 0.4428123456780257` 的尾数 `4428123456780257` 恰好 16 位、前缀 4，
 * 被改写成 `0.4428********0257` —— `*` 是真实字节，整份 session.traj 无法 JSON.parse，
 * `/trace` 与 `bun scripts/trace-digest.ts` 单文件损坏即整体 rc=1。
 */
describe("信用卡号规则不得误伤数字（事故回归）", () => {
  // 实测在盘上造成损坏的两个真实 cost 值
  const REAL_COSTS = [
    0.4428123456780257, 0.5154235074925331, 0.14600612396000884, 0.1015861489997812,
    1.0327980477802163,
  ];

  test("JSON 小数不被改写，且仍可 JSON.parse", () => {
    for (const cost of REAL_COSTS) {
      const json = JSON.stringify({ total_cost_usd: cost });
      const masked = maskSensitiveData(json);
      expect(masked).toBe(json);
      expect(JSON.parse(masked).total_cost_usd).toBe(cost);
    }
  });

  test("长整数（token 计数 / 时间戳）不被改写", () => {
    for (const n of [4428123456780257, 1700000000000, 5154235074925331]) {
      const json = JSON.stringify({ n });
      expect(maskSensitiveData(json)).toBe(json);
    }
  });

  test("真实卡号仍然被脱敏（不能为了修误报把功能改没）", () => {
    // 通过 Luhn 校验的标准测试卡号
    for (const card of ["4111111111111111", "5500005555555559"]) {
      const result = maskSensitiveData(`我的卡号是 ${card}`);
      expect(result).not.toContain(card);
      expect(result).toContain("*");
      expect(detectSensitiveData(`card: ${card}`).some((m) => m.type === "信用卡号")).toBe(true);
    }
  });

  test("带分隔符的真实卡号仍被脱敏", () => {
    const result = maskSensitiveData("卡号 4111-1111-1111-1111");
    expect(result).not.toContain("4111-1111-1111-1111");
  });

  test("未过 Luhn 校验的 16 位数字不脱敏", () => {
    // 小数尾数正是这一类：形态像卡号但校验位不对
    const text = "序号 4428123456780257 结束";
    expect(maskSensitiveData(text)).toBe(text);
  });

  /**
   * 回归：UUID 被信用卡规则误遮（2026-11-23，PR #959 的 CI flake 暴露）。
   *
   * 根因：信用卡正则允许 `[- ]?` 作千位分隔符，而 UUID 的段分隔符同样是 `-`。
   * 于是「段 1 全数字 + 段 2 全数字 + 段 3 全数字」的 UUID 会凑出 16 位数字，
   * 再（约 1/10 概率）通过 Luhn，被遮成 `6507********4909-…`。轨迹落盘的
   * `device_id` 是 UUID —— 用户排查时看到半截 ID，断言 device_id 完整的测试
   * 也随之偶发变红（百万随机 UUIDv4 实测约 1/9 万次误遮）。
   */
  test("UUID 不被误当成卡号（device_id 必须完整落盘）", () => {
    const uuids = [
      "65070000-0009-4909-8def-0123456789ab", // 事故形态：段 1-3 全数字且过 Luhn
      "40147302-8620-4555-9ee9-9c7707fa18f6", // 百万随机样本实测被遮的实例
      "42036270-4482-4784-ac16-ea7cb1dfc250",
    ];
    for (const uuid of uuids) {
      expect(detectSensitiveData(uuid).some((m) => m.type === "信用卡号")).toBe(false);
      expect(maskSensitiveData(uuid)).toBe(uuid);
      // 真实落盘路径：JSON 字符串值里的 device_id 也要原样保留
      const json = JSON.stringify({ device_id: uuid });
      expect(maskSensitiveJson(json)).toBe(json);
    }
  });

  test("紧邻非十六进制边界的卡号仍被遮（排除 UUID 不能放过真实卡号）", () => {
    // `=` / 空格 / 中文都不是 UUID 字符，边界扩展会停住，整段不构成 UUID 形态
    for (const text of [
      "id=4111-1111-1111-1111",
      "卡号 4111111111111111",
      "card: 5500005555555559",
    ]) {
      expect(maskSensitiveData(text)).not.toBe(text);
    }
  });
});

describe("maskSensitiveJson（结构化脱敏）", () => {
  const OPENAI_KEY = "sk-abcdefghij0123456789xyz";

  test("字符串值里的凭证被脱敏", () => {
    const src = JSON.stringify({ note: `key is ${OPENAI_KEY}` });
    const out = maskSensitiveJson(src, 0);
    expect(out).not.toContain(OPENAI_KEY);
    expect(out).toContain("*");
    expect(JSON.parse(out)).toBeDefined();
  });

  test("数字字面量在任何情况下都不被触碰", () => {
    const obj = {
      total_cost_usd: 0.4428123456780257,
      tokens: 4428123456780257,
      nested: { arr: [0.5154235074925331, 1700000000000] },
    };
    const out = maskSensitiveJson(JSON.stringify(obj), 0);
    expect(JSON.parse(out)).toEqual(obj);
  });

  test("嵌套结构与数组里的凭证也被脱敏", () => {
    const src = JSON.stringify({
      messages: [{ role: "user", content: OPENAI_KEY }],
      meta: { deep: { k: OPENAI_KEY } },
    });
    const out = maskSensitiveJson(src, 0);
    expect(out).not.toContain(OPENAI_KEY);
    expect(JSON.parse(out).messages[0].content).toContain("*");
  });

  test("键名里的凭证也被脱敏", () => {
    const out = maskSensitiveJson(JSON.stringify({ [OPENAI_KEY]: 1 }), 0);
    expect(out).not.toContain(OPENAI_KEY);
  });

  test("非 JSON 输入回退到纯文本脱敏", () => {
    const out = maskSensitiveJson(`plain log line with ${OPENAI_KEY}`, 0);
    expect(out).not.toContain(OPENAI_KEY);
    expect(out).toContain("*");
  });

  test("无命中时逐字节保持原文（不重排缩进/键序）", () => {
    // 词法扫描而非 parse→stringify，所以原格式必须一字节不差地保留
    const obj = { b: 1, a: { c: 2 } };
    for (const src of [
      JSON.stringify(obj),
      JSON.stringify(obj, null, 2),
      JSON.stringify(obj, null, 4),
      '{\n\t"x": 1,\n\t"y": [1, 2,   3]\n}',
    ]) {
      expect(maskSensitiveJson(src)).toBe(src);
    }
  });

  test("超长数字与科学计数法不被 IEEE754 改写", () => {
    // parse→stringify 会把 1e999 变成 Infinity（非法 JSON）、把超长整数丢精度
    for (const src of [
      '{"big": 12345678901234567890123456789}',
      '{"exp": 1e999}',
      '{"neg": -0.0}',
      '{"tiny": 1e-400}',
    ]) {
      expect(maskSensitiveJson(src)).toBe(src);
    }
  });

  test("属性测试：任意含数字的对象脱敏后必定仍可 JSON.parse", () => {
    // 覆盖「未来新增数字类规则」这一整类风险：不枚举规则，只断不变量
    for (let i = 0; i < 300; i++) {
      const obj = {
        cost: Math.random(),
        big: Math.floor(Math.random() * 1e16),
        text: `token ${Math.floor(Math.random() * 1e16)}`,
        nested: { v: Math.random() * 1000 },
      };
      const src = JSON.stringify(obj);
      const out = maskSensitiveJson(src, 0);
      expect(() => JSON.parse(out)).not.toThrow();
      // 数字必须原值保留
      expect(JSON.parse(out).cost).toBe(obj.cost);
      expect(JSON.parse(out).big).toBe(obj.big);
    }
  });
});
