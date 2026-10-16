/**
 * CHANGELOG.md 的提交改写表：git 历史改不了，但渲染出来的文字可以。
 *
 * CHANGELOG.md 由 `generate-changelog.ts` 每次从 git 完整重建，手改会在下一次发版时被覆盖回来。
 * 某条提交的标题或正文不适合继续对外展示时，在这里登记一条改写，生成器渲染时套用。
 *
 * 规则：
 *   · 键是**完整 40 位 hash**。短 hash 会随仓库变大而变长，按短 hash 匹配迟早静默失配。
 *   · `subject` 给出时整条替换标题，必须仍是 Conventional Commits 格式，否则分组会掉进「其他」。
 *   · `dropDetails` 是要从正文细节里删掉的行的子串，命中任一即删整行。
 *   · 只改展示，不改事实：不改 PR 号、不改分组、不把一条提交改成另一件事。
 *
 * 每条都有测试看着（tests/scripts/changelog-rewrites.test.ts）：hash 必须存在于本仓历史，
 * 改写后的标题必须能被生成器解析。提交被 rebase 掉、hash 不再存在时测试会红，提醒删掉这一条。
 */

export interface CommitRewrite {
  /** 替换后的完整标题（含 type(scope): 前缀与 PR 号） */
  subject?: string;
  /** 正文细节里含这些子串的行整行删掉 */
  dropDetails?: string[];
}

export const COMMIT_REWRITES: Readonly<Record<string, CommitRewrite>> = {
  "779b8ae9521dcfa880eea9d4c4b1e5b725555b69": {
    subject: "fix(tui): 渲染底座 resize 后宽度不跟，补 TerminalSizeContext (#224)",
  },
  "27929abf90a30af230af611e6a9fdaf43b845a2c": {
    subject: "refactor(tui): 渲染底座换成 packages/tui（B9） (#210)",
  },
  "5954159be411e2e7645a96ef819ed11eac32930b": {
    subject: "refactor(tui): 渲染层收口为 packages/tui 一套（B9 / T9.1） (#236)",
  },
  b7498c3a8ea45d279c3d0ab4f95e348a59ca0f05: {
    subject: "refactor: 删除 /claude-api 命令与源码取回机制 (#247)",
    dropDetails: ["vendor-src", "vendor:fetch"],
  },
  eec616ba7a0c0e8d2d39560a7741eeb1d7d3394b: {
    dropDetails: ["5954159b v0.1.607"],
  },
};

/** 按完整 hash 查改写；短 hash 不认（见文件头） */
export function rewriteFor(fullHash: string): CommitRewrite | undefined {
  return COMMIT_REWRITES[fullHash.trim()];
}

/** 套用 dropDetails：删掉含任一子串的行 */
export function applyDetailDrops(details: string[], rw: CommitRewrite | undefined): string[] {
  const drops = rw?.dropDetails;
  if (!drops?.length) return details;
  return details.filter((d) => !drops.some((s) => d.includes(s)));
}
