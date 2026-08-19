/**
 * 派生问题核算的单测（scripts/lib/pr-batch-derived.ts）。
 *
 * ## 为什么这个门禁自己需要变异自证
 *
 * 本仓反复发作的病灶是「绿了但没测到」：门禁存在、断言存在、值是废的
 * （见 tests/build/ 与 packages/core/tests/telemetry/ 下几处注释）。
 * 这个模块的核心断言是「#64 会与 PR12 撞上」，而它有一条极易走成恒真的路径：
 * 只要交集算错方向、或者 pending 列表算成空，输出就恒为「无冲突」——
 * **而那个输出看起来完全正常**（没有告警、退出码 0、报告体面）。
 *
 * 所以下面每组断言都配一条**变异**：把输入改成「本该不报」的形态，
 * 断言它真的不报。只有正例的测试证明不了这个函数在做判断。
 *
 * fixture 用的是首次试跑的**真实数据形态**（#64 / #65 / PR12），
 * 不是编出来的 —— 编出来的 fixture 只能验证代码符合自己的想象。
 */

import { describe, test, expect } from "bun:test";
import {
  parseMarker,
  extractProseFiles,
  extractPlanPrs,
  resolveBasename,
  crossCheck,
  formatReport,
  SYNCED_LABEL,
  type Payload,
} from "../../scripts/lib/pr-batch-derived.ts";

// ── fixture：真实形态的最小切片 ──────────────────────────────

/** 方案文档的真实结构切片：P.3 总表 + 两个 PR 小节。 */
const PLAN_DOC = `
## P.3 PR 总表

| # | 分支 / 标题 | 覆盖 | 优先级 |
| --- | --- | --- | --- |
| **PR11** | \`fix/catalog-concurrent-write-merge\`<br>\`fix(llm): 目录缓存写盘前重读合并\` | D7 | P2 |
| **PR12** | \`feat/gateway-supported-endpoint-types\`<br>\`feat(gateway): 采集 supported_endpoint_types\` | D6 | P2 |
| **PR13** | \`chore/catalog-coverage-script\`<br>\`chore(llm): 覆盖率注释带日期\` | D10 | P2 |

## P.4 每个 PR 的范围与验收

### PR11 — D7 并发写（P2）

写盘前重读一次磁盘并与内存态合并。见 \`model-capabilities.ts\` 的 persist()。

### PR12 — D6 网关 \`supported_endpoint_types\`（P2）

⚠ 需要一次显式的职责边界修订。\`gateway-pricing.ts:1-14\` 现在写「只采价格」。

### PR13 — D10 覆盖率口径（P2）

落 \`scripts/catalog-coverage.ts\`，让覆盖率变成可复算口径。

## 一、别的章节

这一节提到 \`should-not-be-attributed.ts\`，它在 PR 小节之外，不该被算成任何 PR 的足迹。
`;

/** #64 的真实形态：带标记，且正文同时提到「要改的」与「只是对照的」两个文件。 */
const ISSUE_64_BODY = `
<!-- pr-batch: from=PR11 pr=63 files=packages/core/src/llm/gateway-pricing.ts plan-doc-correction=§6.2 -->

## 背景

PR #63 修了 \`model-capabilities.ts\` 的 D7 并发写。方案文档 §6.2 说
\`gateway-pricing.ts\` 有**同样**的问题 —— 回源码核完，这个描述不准确。

| | \`model-capabilities.ts\` | \`gateway-pricing.ts\` |
| 写前重读 | ❌ | ✅ 已有 |
| 原子写 | ✅ 已有 | ❌ 没有 |
`;

const ISSUE_65_BODY = `
<!-- pr-batch: from=PR11 pr=63 files=packages/core/src/llm/model-capabilities.ts -->

## 现象

\`packages/core/src/llm/model-capabilities.ts\` 的 \`persistDisabled\` 是单向开关。
防复发门禁在 \`packages/core/tests/telemetry/no-real-path-writes.test.ts\`。
`;

const REPO_FILES = [
  "packages/core/src/llm/model-capabilities.ts",
  "packages/core/src/llm/gateway-pricing.ts",
  "packages/core/src/config/config.ts",
  "packages/cli/src/config.ts",
  "packages/core/tests/telemetry/no-real-path-writes.test.ts",
];

function payload(over: Partial<Payload> = {}): Payload {
  return {
    issues: [
      {
        number: 64,
        title: "gateway-pricing.ts 缺原子写",
        body: ISSUE_64_BODY,
        state: "OPEN",
        labels: ["bug"],
      },
      {
        number: 65,
        title: "persistDisabled 单向不可复位",
        body: ISSUE_65_BODY,
        state: "OPEN",
        labels: ["bug"],
      },
    ],
    planDoc: PLAN_DOC,
    planDocPath: "docs-research/.../方案.md",
    batchPrIds: ["PR10", "PR11"],
    batchPrs: [
      { id: "PR10", number: 66, state: "OPEN" },
      { id: "PR11", number: 63, state: "MERGED" },
    ],
    mergedBranches: ["fix-catalog-concurrent-write-merge"],
    repoFiles: REPO_FILES,
    ...over,
  };
}

// ── 解析层 ──────────────────────────────────────────────────

describe("parseMarker", () => {
  test("抽出 from / pr / files / plan-doc-correction 四项", () => {
    const m = parseMarker(ISSUE_64_BODY);
    expect(m).not.toBeNull();
    expect(m!.from).toBe("PR11");
    expect(m!.pr).toBe(63);
    expect(m!.files).toEqual(["packages/core/src/llm/gateway-pricing.ts"]);
    expect(m!.planDocCorrection).toBe("§6.2");
  });

  test("变异：没有标记时返回 null，而不是返回空壳", () => {
    // 空壳（{files:[]}）会让调用方以为「有标记但没写文件」，从而跳过正文 grep 退路。
    expect(parseMarker("## 背景\n就是个普通 issue")).toBeNull();
  });

  test("pr 写 #63 或 63 都认", () => {
    expect(parseMarker("<!-- pr-batch: pr=#63 -->")!.pr).toBe(63);
    expect(parseMarker("<!-- pr-batch: pr=63 -->")!.pr).toBe(63);
  });

  test("多文件用逗号分隔", () => {
    const m = parseMarker("<!-- pr-batch: files=a/b.ts,c/d.ts -->");
    expect(m!.files).toEqual(["a/b.ts", "c/d.ts"]);
  });
});

describe("extractProseFiles（弱证据退路）", () => {
  test("捞出正文里的 .ts，反引号不带进结果", () => {
    const files = extractProseFiles(ISSUE_65_BODY);
    expect(files).toContain("packages/core/src/llm/model-capabilities.ts");
    expect(files.some((f) => f.startsWith("`"))).toBe(false);
  });

  test("变异：它确实分不出「要改的」与「只是对照的」—— 这正是标记存在的理由", () => {
    // #64 正文同时提到两个文件，grep 会都捞出来。
    // 这条断言不是在夸 grep，是把它的**已知缺陷**锁住：
    // 将来若有人把 fileEvidence 的 prose 档当成权威，这条会提醒他为什么不能。
    const files = extractProseFiles(ISSUE_64_BODY).map((f) => f.split("/").pop());
    expect(files).toContain("gateway-pricing.ts");
    expect(files).toContain("model-capabilities.ts");
  });
});

describe("extractPlanPrs", () => {
  test("从总表拿分支名，从小节拿文件足迹", () => {
    const prs = extractPlanPrs(PLAN_DOC);
    const pr12 = prs.find((p) => p.id === "PR12")!;
    expect(pr12.branch).toBe("feat/gateway-supported-endpoint-types");
    expect(pr12.files).toContain("gateway-pricing.ts");
  });

  test("变异：PR 小节之外的文件名不被算进任何 PR 的足迹", () => {
    // 若忘了在 `^## ` 处清空 cur，最后一个 PR 会把全文后续章节的文件名全吞掉，
    // 于是它跟每个 issue 都「同文件」→ 报告全是假阳性。
    const prs = extractPlanPrs(PLAN_DOC);
    const all = prs.flatMap((p) => p.files);
    expect(all).not.toContain("should-not-be-attributed.ts");
  });

  test("变异：格式不符时返回空数组（调用方要能据此告警）", () => {
    expect(extractPlanPrs("# 一份没有 PR 小节的文档\n随便写点东西")).toEqual([]);
  });
});

describe("resolveBasename", () => {
  test("同名文件多处时全部返回（config.ts 是真实的歧义案例）", () => {
    expect(resolveBasename("config.ts", REPO_FILES).length).toBe(2);
  });
  test("唯一时返回一条", () => {
    expect(resolveBasename("gateway-pricing.ts", REPO_FILES)).toEqual([
      "packages/core/src/llm/gateway-pricing.ts",
    ]);
  });
});

// ── 核算层：本模块存在的理由 ──────────────────────────────────

describe("crossCheck：派生问题 × 未做的 PR", () => {
  test("#64 与 PR12 同文件 → 报「分层需重算」", () => {
    const r = crossCheck(payload());
    const v64 = r.verdicts.find((v) => v.number === 64)!;
    expect(v64.reLayer.map((x) => x.prId)).toContain("PR12");
    expect(v64.reLayer.find((x) => x.prId === "PR12")!.file).toBe("gateway-pricing.ts");
    expect(v64.fileEvidence).toBe("marker");
  });

  test("变异：把 PR12 从方案文档里去掉 → #64 不再报冲突", () => {
    // 这条是整份测试的核心。上一条为真可能只是因为「什么都报」；
    // 只有这条通过，才证明它在**做判断**而不是无条件报警。
    const doc = PLAN_DOC.replace(/### PR12[\s\S]*?(?=### PR13)/, "");
    const r = crossCheck(payload({ planDoc: doc }));
    const v64 = r.verdicts.find((v) => v.number === 64)!;
    expect(v64.reLayer.map((x) => x.prId)).not.toContain("PR12");
  });

  test("变异：PR12 已合并 → 不再是「未做的 PR」，不报冲突", () => {
    const r = crossCheck(
      payload({
        mergedBranches: [
          "fix-catalog-concurrent-write-merge",
          "feat/gateway-supported-endpoint-types",
        ],
      }),
    );
    expect(r.verdicts.find((v) => v.number === 64)!.reLayer).toEqual([]);
  });

  test("#65 只碰 model-capabilities.ts，而它属于已合入的 PR11 → 不报冲突", () => {
    // 用标记（而不是正文 grep）才能得到这个结论：#65 正文也提到了 tests/ 下的文件。
    const r = crossCheck(payload());
    expect(r.verdicts.find((v) => v.number === 65)!.reLayer).toEqual([]);
  });

  test("层内 vs 未做的PR：本批还开着的那路单独标 scope", () => {
    // 把 PR10 的足迹改成 gateway-pricing.ts，且 PR10 仍 OPEN → 应标「层内」。
    const doc = PLAN_DOC.replace(
      "### PR13 — D10 覆盖率口径（P2）",
      "### PR10 — D9 OpenRouter（P1）\n\n改 `gateway-pricing.ts` 一处。\n\n### PR13 — D10 覆盖率口径（P2）",
    );
    const r = crossCheck(payload({ planDoc: doc }));
    const scopes = r.verdicts
      .find((v) => v.number === 64)!
      .reLayer.map((x) => `${x.prId}:${x.scope}`);
    expect(scopes).toContain("PR10:层内");
    expect(scopes).toContain("PR12:未做的PR");
  });
});

describe("crossCheck：方案文档回流", () => {
  test("有 plan-doc-correction 且无 synced 标签 → 记为未回流", () => {
    const r = crossCheck(payload());
    expect(r.verdicts.find((v) => v.number === 64)!.planDocCorrection).toEqual({
      section: "§6.2",
      synced: false,
    });
  });

  test("变异：打上 plan-doc-synced 标签后 → synced=true 且不再计入未闭环", () => {
    const p = payload();
    p.issues[0].labels = ["bug", SYNCED_LABEL];
    const r = crossCheck(p);
    expect(r.verdicts.find((v) => v.number === 64)!.planDocCorrection!.synced).toBe(true);
    // 未闭环数应比未标记时少 1（回流那一项没了，分层那一项还在）
    expect(r.outstanding).toBe(crossCheck(payload()).outstanding - 1);
  });

  test("#65 没写 plan-doc-correction → 不虚构回流项", () => {
    expect(
      crossCheck(payload()).verdicts.find((v) => v.number === 65)!.planDocCorrection,
    ).toBeNull();
  });
});

describe("crossCheck：未闭环计数与关掉的 issue", () => {
  test("CLOSED 的 issue 不计入未闭环", () => {
    const p = payload();
    p.issues[0].state = "CLOSED";
    expect(crossCheck(p).outstanding).toBe(0);
  });

  test("全部闭环时 outstanding 归零（不是恒正）", () => {
    const p = payload();
    p.issues[0].state = "CLOSED";
    p.issues[1].state = "CLOSED";
    expect(crossCheck(p).outstanding).toBe(0);
  });
});

describe("crossCheck：核算缺口必须显式告警，不许静默跳过", () => {
  test("读不到方案文档 → 出告警，且不谎报「无冲突」", () => {
    const r = crossCheck(payload({ planDoc: undefined }));
    expect(r.warnings.some((w) => w.includes("算不出"))).toBe(true);
    // 报告正文里必须能看到这条，否则人只会看见空表以为没事
    expect(formatReport(r, payload({ planDoc: undefined }))).toContain("没算过");
  });

  test("方案文档解析不出 PR 小节 → 出告警", () => {
    const r = crossCheck(payload({ planDoc: "# 空文档" }));
    expect(r.warnings.some((w) => w.includes("没解析出"))).toBe(true);
  });

  test("issue 没带标记 → 标 prose 并告警（弱证据不冒充强证据）", () => {
    const p = payload();
    p.issues = [
      {
        number: 99,
        title: "无标记",
        body: "改 `gateway-pricing.ts` 一处",
        state: "OPEN",
        labels: [],
      },
    ];
    const r = crossCheck(p);
    expect(r.verdicts[0].fileEvidence).toBe("prose");
    expect(r.warnings.some((w) => w.includes("弱证据"))).toBe(true);
    // 弱证据也照样参与冲突核算 —— 宁可多报一条让人看，不要漏
    expect(r.verdicts[0].reLayer.map((x) => x.prId)).toContain("PR12");
  });

  test("裸文件名有歧义时登记（config.ts）", () => {
    const p = payload();
    p.issues = [
      {
        number: 98,
        title: "歧义",
        body: "<!-- pr-batch: files=config.ts -->",
        state: "OPEN",
        labels: [],
      },
    ];
    const r = crossCheck(p);
    expect(r.verdicts[0].ambiguous[0].candidates.length).toBe(2);
  });
});

describe("formatReport", () => {
  test("闭环时明确说「无未闭环项」，不闭环时给出处置动作", () => {
    const p = payload();
    expect(formatReport(crossCheck(p), p)).toContain("未闭环");
    expect(formatReport(crossCheck(p), p)).toContain("分层需重算");

    p.issues[0].state = "CLOSED";
    p.issues[1].state = "CLOSED";
    expect(formatReport(crossCheck(p), p)).toContain("✅ 无未闭环项");
  });

  test("必须写明「只判到同文件这一档」—— 不许让人以为算过 C1/C2/C3", () => {
    const p = payload();
    expect(formatReport(crossCheck(p), p)).toContain("算不出 §3.3");
  });
});
