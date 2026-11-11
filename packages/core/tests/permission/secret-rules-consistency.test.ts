/**
 * 密钥识别规则一致性测试（B15 验收核心）
 *
 * ── 为什么需要这一层 ──
 *
 * 2026-11-10 实测：三套规则**没有任何一个测试同时 import 两套**（`grep -l` 交叉为零），
 * 所以「R2 漏了 `github_pat_`」这种事只能靠人肉审计发现。同一形态在三处各写一条正则、
 * 长度还各不相同，漂移是必然的 —— 这个文件把「矩阵里每一行在三处各是什么行为」写死。
 *
 * ── 探针表怎么读 ──
 *
 * 每行 = 一个形态 + 它在三档消费 API 下的期望：
 *   - `mask`   R1 落盘（`maskSensitiveData`）：是否必须遮
 *   - `detect` R2 记忆闸门（`SecretRedactHook.detect`，过 fixture 守护后）：是否必须检出
 *   - `scan`   R3 团队扫描（`scanForSecrets`）：是否必须检出
 *   - `tiers`  这个形态属于哪一档。**mask / detect 从 tiers 推导**，不重复声明 ——
 *              一处判断写两遍就是下一个漂移点。
 *   - `note`   只有「R3 期望与 strict 档不一致」时才允许出现，必须写清误报代价理由。
 *
 * ── 守恒断言防的是什么 ──
 *
 * 「下一个人看到 R3 对 DB URL 是 ✗，顺手把它拉平」—— 拉平的代价是团队记忆开始拒正常写入
 * （R3 的读者是所有协作者，误报没有逃生舱）。所以凡差异必带 note，note 必写代价。
 *
 * ── 变异自证（手工执行，不是自动化）──
 *
 * 把 `secret-rules.ts` 里任一 `wide` 规则的 `tiers` 删掉 → 「覆盖」断言必须变红。
 * 已按 CONTRIBUTING 的「新增门禁必做变异自证」在本 PR 里跑过一次。
 */

import { describe, test, expect } from "bun:test";
import { maskSensitiveData } from "@sid-code/core/permission/sensitive.ts";
import { SecretRedactHook } from "@sid-code/core/llm/hooks/secret-redact.ts";
import { scanForSecrets } from "@sid-code/core/memory/team/secret-scanner.ts";
import {
  SECRET_RULES,
  rulesForTier,
  type SecretTier,
} from "@sid-code/core/permission/secret-rules.ts";

// ─── 合成样本（全部为假值，不含任何真实凭证）──────────────────────────────

const OPENAI_PROJ = "sk-proj-" + "a".repeat(32);
const GH_FINE_60 = "github_pat_" + "a".repeat(49); // 60 位 < R3 的精确 82
const GH_FINE_102 = "github_pat_" + "b".repeat(91); // 102 位 ≥ 82
const ANTHROPIC_80 = "sk-ant-api03-" + "c".repeat(67); // 80 位，非 93+AA
const ANTHROPIC_93 = "sk-ant-api03-" + "d".repeat(93) + "AA";
const PEM_BODY = "MIIEowIBAAKCAQEA" + "x".repeat(64);
const PEM = `-----BEGIN RSA PRIVATE KEY-----\n${PEM_BODY}\n-----END RSA PRIVATE KEY-----`;
const DB_PWD = "supersecret123";

interface Probe {
  id: string;
  sample: string;
  /** 该形态参与的档位。mask / detect 由它推导 */
  tiers: SecretTier[];
  /** R3 团队扫描的期望（R3 只消费自己的规则集，不由 tiers 推导） */
  scan: boolean;
  /** 与 tiers 推导不一致时的显式理由（必写误报代价） */
  note?: string;
}

const PROBES: Probe[] = [
  // ── (a) 该补的漏点：B15 之后三档应当一致 ──
  {
    id: "openai-assignment",
    sample: `OPENAI_API_KEY=${OPENAI_PROJ}`,
    tiers: ["strict", "wide"],
    scan: false,
    note: "R3 只收 gitleaks 独特前缀规则；键名赋值在团队记忆里误报会挡住正常写入（无逃生舱）",
  },
  {
    id: "github-fine-grained-60",
    sample: `GITHUB_TOKEN=${GH_FINE_60}`,
    tiers: ["strict", "wide"],
    scan: false,
    note: "R3 保留 gitleaks 精确长度 {82}：放宽到 {22,} 会让团队记忆在 github_pat_ 前缀的普通串上误拒",
  },
  {
    id: "github-fine-grained-102",
    sample: GH_FINE_102,
    tiers: ["strict", "wide"],
    scan: true,
  },
  {
    id: "github-fine-grained-bare",
    sample: `token is ${GH_FINE_60} end`,
    tiers: ["strict", "wide"],
    scan: false,
    note: "同上：R3 的精确 {82} 只认长形态，短形态在团队侧不拒",
  },
  {
    id: "api-key-assignment",
    sample: "API_KEY=sk-" + "e".repeat(30),
    tiers: ["strict", "wide"],
    scan: false,
    note: "键名赋值类不进 R3（团队记忆误报代价高），R1/R2 已覆盖",
  },
  {
    id: "secret-literal",
    sample: "SECRET='abcdefghij1234567890'",
    tiers: ["strict", "wide"],
    scan: false,
    note: "同上：B15 补进了 R2，但 R3 的 gitleaks 子集不含键名赋值（团队记忆误报会挡住正常写入）",
  },
  {
    id: "aws-secret-access-key",
    sample: "AWS_SECRET_ACCESS_KEY=" + "f".repeat(40),
    tiers: ["strict", "wide"],
    scan: false,
    note: "同上：R2 此前完全不认这个键名，B15 已补；R3 仍只收独特前缀（团队记忆误报代价高）",
  },
  {
    id: "anthropic-80",
    sample: ANTHROPIC_80,
    tiers: ["strict", "wide"],
    scan: false,
    note: "R3 只认 gitleaks 精确形态 {93}AA；放宽会让团队记忆误拒",
  },
  {
    id: "anthropic-93",
    sample: ANTHROPIC_93,
    tiers: ["strict", "wide"],
    scan: true,
  },
  {
    id: "db-conn-auth",
    sample: `postgres://admin:${DB_PWD}@db.example.com:5432/prod`,
    tiers: ["strict", "wide"],
    scan: false,
    note: "DB URL 形态宽松，只进 R1/R2 的 wide+strict；R3 收它会让团队记忆拒掉无认证的本地连接串",
  },
  {
    id: "pem-block",
    sample: PEM,
    tiers: ["strict", "wide"],
    scan: true,
  },
  {
    id: "x-api-key-header",
    sample: "curl -H 'x-api-key: abcdef1234567890abcdef12'",
    tiers: ["strict", "wide"],
    scan: false,
    note: "文本头形态宽松，R3 不收（团队记忆里 curl 示例很常见，误报会挡正常写入）",
  },
  {
    id: "bearer",
    sample: "Authorization: Bearer " + "g".repeat(32),
    tiers: ["strict", "wide"],
    scan: false,
    note: "同上：Bearer 在团队文档的示例里高频出现，R3 不收",
  },
  {
    id: "aws-access-key",
    sample: "AKIA" + "IOSFODNN7EXAMPLE",
    tiers: ["wide"],
    scan: true,
    note: "R2 的 fixture 守护刻意跳过含 EXAMPLE 的命中：命中即拒场景误报无逃生舱；R1 与 R3 照遮/照报",
  },
  {
    id: "github-pat",
    sample: "ghp_" + "h".repeat(36),
    tiers: ["strict", "wide"],
    scan: true,
  },

  // ── 已知不覆盖（不改）：值含 `/` 被判为路径 ──
  {
    id: "api-key-path-value",
    sample: "MY_API_KEY=/path/abcdef1234567890",
    tiers: [],
    scan: false,
    note: "已知不覆盖：literalSecretValue 把含 / 的值判为路径。放宽会让 KEY=/usr/local/bin/xxx 这类路径被遮",
  },
];

// ─── 三档消费 API ─────────────────────────────────────────────────────────

const hook = new SecretRedactHook();

/** R1：落盘遮盖 */
function r1Masks(sample: string): boolean {
  return maskSensitiveData(sample) !== sample;
}

/** R2：记忆闸门（含 fixture 守护） */
function r2Detects(sample: string): boolean {
  return hook.detect(sample).length > 0;
}

/** R3：团队扫描 */
function r3Scans(sample: string): boolean {
  return scanForSecrets(sample).length > 0;
}

describe("B15 规则一致性：探针表 × 三档消费 API", () => {
  for (const probe of PROBES) {
    test(`${probe.id}`, () => {
      const inWide = probe.tiers.includes("wide");
      const inStrict = probe.tiers.includes("strict");

      // 覆盖：wide 档必须遮；不属于 wide 档的必须原样返回
      expect({ mask: r1Masks(probe.sample) }).toEqual({ mask: inWide });

      // 覆盖：strict 档 R2 必须检出
      expect({ detect: r2Detects(probe.sample) }).toEqual({ detect: inStrict });

      // R3 按探针显式期望（R3 只消费自己的规则集，不由 tiers 推导）
      expect({ scan: r3Scans(probe.sample) }).toEqual({ scan: probe.scan });
    });
  }

  test("守恒：R3 期望与 strict 档不一致时必须带 note，且 note 写清误报代价", () => {
    for (const probe of PROBES) {
      const inStrict = probe.tiers.includes("strict");
      if (inStrict === probe.scan) continue;
      expect({ id: probe.id, hasNote: Boolean(probe.note) }).toEqual({
        id: probe.id,
        hasNote: true,
      });
      // note 不能是占位符：必须解释「为什么不拉平」
      expect(probe.note).toMatch(/误报|代价|逃生舱|放宽|团队/);
    }
  });

  test("守恒：tiers 为空的探针必须带 note（已知不覆盖要写清原因）", () => {
    for (const probe of PROBES.filter((p) => p.tiers.length === 0)) {
      expect({ id: probe.id, hasNote: Boolean(probe.note) }).toEqual({
        id: probe.id,
        hasNote: true,
      });
    }
  });
});

describe("B15 规则表结构不变量", () => {
  test("id 唯一", () => {
    const ids = SECRET_RULES.map((r) => r.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  test("每条规则都声明了 label（detectSensitiveData 的 type 靠它，改名会断告警口径）", () => {
    for (const rule of SECRET_RULES) {
      expect({ id: rule.id, hasLabel: rule.label.length > 0 }).toEqual({
        id: rule.id,
        hasLabel: true,
      });
    }
  });

  test("每条规则至少参与一个档位（没有孤儿规则）", () => {
    for (const rule of SECRET_RULES) {
      expect({ id: rule.id, tiers: rule.tiers.length > 0 }).toEqual({ id: rule.id, tiers: true });
    }
  });

  test("strict 规则必须能编译成合法正则", () => {
    for (const rule of rulesForTier("strict")) {
      expect(
        () => new RegExp(rule.pattern instanceof RegExp ? rule.pattern : rule.pattern()),
      ).not.toThrow();
    }
  });

  test("wide 规则必须能编译成合法正则", () => {
    for (const rule of rulesForTier("wide")) {
      expect(
        () => new RegExp(rule.pattern instanceof RegExp ? rule.pattern : rule.pattern()),
      ).not.toThrow();
    }
  });

  test("strict 档非空且 wide 档非空（防止误删 tiers 让整档消失）", () => {
    expect(rulesForTier("strict").length).toBeGreaterThan(0);
    expect(rulesForTier("wide").length).toBeGreaterThan(0);
  });
});
