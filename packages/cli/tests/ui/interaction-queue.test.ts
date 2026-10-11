/**
 * 交互式确认串行队列：并发到达的确认不再互相覆盖。
 *
 * 回归的是这个场景：两个权限请求同时到，旧实现第二个直接覆盖 state 里唯一的格子，
 * 第一个的 resolve 永远没人调，那次工具调用挂到 abort 为止。
 */

import { describe, test, expect } from "bun:test";
import { InteractionQueue } from "@sid-code/cli/ui/interaction-queue.ts";

/** 模拟 app.ts 里的单格 state：写入时若已有未答的请求，即为「覆盖」 */
function makeSlot() {
  let current: { id: string; answer: (v: string) => void } | null = null;
  const overwritten: string[] = [];
  return {
    show: (id: string) =>
      new Promise<string>((resolve) => {
        if (current) overwritten.push(current.id);
        current = {
          id,
          answer: (v) => {
            current = null;
            resolve(v);
          },
        };
      }),
    get current() {
      return current;
    },
    overwritten,
  };
}

const tick = () => new Promise((r) => setTimeout(r, 0));

describe("InteractionQueue", () => {
  test("并发确认依次显示，后一个不覆盖前一个，两个都能拿到答案", async () => {
    const q = new InteractionQueue();
    const slot = makeSlot();
    const a = q.run(
      () => slot.show("a"),
      () => "aborted",
    );
    const b = q.run(
      () => slot.show("b"),
      () => "aborted",
    );
    await tick();
    expect(slot.current?.id).toBe("a");
    expect(q.waitingCount).toBe(1);
    slot.current!.answer("yes");
    await tick();
    expect(slot.current?.id).toBe("b");
    slot.current!.answer("no");
    expect(await a).toBe("yes");
    expect(await b).toBe("no");
    expect(slot.overwritten).toEqual([]);
  });

  test("排队期间被 abort → 直接出队按保守默认闭合，不再弹出", async () => {
    const q = new InteractionQueue();
    const slot = makeSlot();
    const ac = new AbortController();
    const a = q.run(
      () => slot.show("a"),
      () => "aborted",
    );
    const b = q.run(
      () => slot.show("b"),
      () => "aborted",
      ac.signal,
    );
    const c = q.run(
      () => slot.show("c"),
      () => "aborted",
    );
    await tick();
    ac.abort();
    expect(await b).toBe("aborted");
    slot.current!.answer("yes");
    await tick();
    expect(slot.current?.id).toBe("c");
    slot.current!.answer("yes");
    expect(await a).toBe("yes");
    expect(await c).toBe("yes");
  });

  test("已 abort 的请求不占位", async () => {
    const q = new InteractionQueue();
    const ac = new AbortController();
    ac.abort();
    expect(
      await q.run(
        async () => "shown",
        () => "aborted",
        ac.signal,
      ),
    ).toBe("aborted");
    expect(
      await q.run(
        async () => "shown",
        () => "aborted",
      ),
    ).toBe("shown");
  });

  test("show 抛错也释放显示权", async () => {
    const q = new InteractionQueue();
    await expect(
      q.run(
        async () => {
          throw new Error("boom");
        },
        () => "aborted",
      ),
    ).rejects.toThrow("boom");
    expect(
      await q.run(
        async () => "next",
        () => "aborted",
      ),
    ).toBe("next");
  });
});
