/**
 * 发现 8（20261020 ce7ea52e）：digest 成本取账本与 traj 元数据中**较新**的那个，并标注取数源。
 *
 * 旧口径账本无条件优先：账本停在第 1 问的 $0.17（ts 03:27），元数据快照 23:57 已是 $11.14，
 * digest 首行照抄 $0.17。下面第一条用例就是那次会话的真实数字。
 */
import { describe, test, expect } from "bun:test";
import { resolveDigestCost } from "../../src/trace/digest.ts";

const sec = (iso: string) => Math.floor(Date.parse(iso) / 1000);

describe("resolveDigestCost", () => {
  test("ce7ea52e：账本旧（03:27）、元数据新（23:57）→ 取元数据", () => {
    const r = resolveDigestCost(
      { costUSD: 0.1739, ts: sec("2026-10-20T03:27:33Z") },
      { total_cost_usd: 11.1444, snapshot_at: "2026-10-20T23:57:28.640Z" },
    );
    expect(r).toEqual({ costUSD: 11.1444, source: "metadata" });
  });

  test("账本晚于快照 → 取账本（SessionState 权威值，含旁路）", () => {
    const r = resolveDigestCost(
      { costUSD: 11.1984, ts: sec("2026-10-20T23:57:29Z") },
      { total_cost_usd: 11.1444, snapshot_at: "2026-10-20T23:57:28.640Z" },
    );
    expect(r.source).toBe("ledger");
    expect(r.costUSD).toBe(11.1984);
  });

  test("同一秒内（账本 ts 秒级取整）视作同时 → 取账本", () => {
    const r = resolveDigestCost(
      { costUSD: 2, ts: sec("2026-10-20T10:00:00Z") },
      { total_cost_usd: 1, snapshot_at: "2026-10-20T10:00:00.900Z" },
    );
    expect(r.source).toBe("ledger");
  });

  test("元数据缺 snapshot_at → 退回账本优先（缺失不当「更旧」）", () => {
    const r = resolveDigestCost({ costUSD: 2, ts: 1 }, { total_cost_usd: 9 });
    expect(r).toEqual({ costUSD: 2, source: "ledger" });
  });

  test("无账本 → 元数据；都没有 → traj 汇总；全缺 → 0 且无来源", () => {
    expect(resolveDigestCost(undefined, { total_cost_usd: 3 })).toEqual({
      costUSD: 3,
      source: "metadata",
    });
    expect(resolveDigestCost(undefined, {}, 4)).toEqual({ costUSD: 4, source: "traj" });
    expect(resolveDigestCost(undefined, {})).toEqual({ costUSD: 0 });
  });
});
