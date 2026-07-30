/**
 * yoga 多槽布局缓存丢失子节点定位的回归测试
 *
 * 背景（Footer 行2 右对齐失效的真根因，前两次修复都没碰到这层）：
 * `layoutNode` 的多槽缓存（`_cIn`/`_cOut`，4 槽 LRU）**只存 w/h，不存子节点位置**。
 * 但它此前在 **layout pass（performLayout=true）** 也参与命中判定，一旦命中就
 * `return`，跳过 STEP 5 的子节点定位递归 —— 子节点被冻结在上一次 layout pass
 * 留下的 left/top 上。
 *
 * 单槽 `_hasL` 在 layout pass 命中是安全的：它的输入描述的正是**最近一次** layout
 * pass，而当前子节点位置也正对应那一次。多槽缓存故意保留最多 4 个**更早世代**的
 * 条目，因此可能命中一个「位置早已被覆盖」的世代。
 *
 * 触发序列 60→120→50→120：最后一次 resize 命中了世代 2 留下的 width=120 条目，
 * 于是 clean 的 Footer/root 子树直接返回 width=120 而不重新定位，
 * `justifyContent:'flex-end'` 的行2 内容盒保持在 width=50 时算出的 left，
 * 不再跟随右边缘（表现为偏左 / 被裁截）。
 *
 * 修复：多槽缓存只在 `!performLayout`（measure pass）时参与命中。
 *
 * 本测试用**纯 yoga**（不涉及 ink / React / 终端）钉死该行为——bug 在这一层就能复现。
 */

import { test, expect, describe } from "bun:test";
import Yoga, {
  Justify,
  FlexDirection,
  Overflow,
  Wrap,
  Edge,
  type Node as YogaNode,
} from "../../src/ink/_vendor/yoga-layout/index.ts";

/** 按根宽度重算布局（第二参显式传 undefined：vendored 签名要求 ≥2 参）。 */
function layoutAt(root: YogaNode, width: number): void {
  root.setWidth(width);
  root.calculateLayout(width, undefined);
}

/** 复刻 Footer 结构：root → outer(paddingX=1, width=100%) → row(flex-end) → content(固定宽) */
function buildFooterLikeTree(contentWidth: number) {
  const root = Yoga.Node.create();
  root.setFlexDirection(FlexDirection.Column);

  const outer = Yoga.Node.create();
  outer.setFlexDirection(FlexDirection.Column);
  outer.setPadding(Edge.Left, 1);
  outer.setPadding(Edge.Right, 1);
  outer.setWidth("100%");

  const row = Yoga.Node.create();
  row.setFlexDirection(FlexDirection.Row);
  row.setJustifyContent(Justify.FlexEnd);
  row.setFlexWrap(Wrap.NoWrap);
  row.setOverflow(Overflow.Hidden);

  const content = Yoga.Node.create();
  content.setFlexShrink(0);
  content.setMeasureFunc(() => ({ width: contentWidth, height: 1 }));

  row.insertChild(content, 0);
  outer.insertChild(row, 0);
  root.insertChild(outer, 0);
  return { root, outer, row, content };
}

describe("yoga 多槽布局缓存不得跳过子节点定位", () => {
  const CONTENT_W = 32;

  test("flex-end 子节点在反复 resize（含回到旧宽度）后始终贴右", () => {
    const { root, row, content } = buildFooterLikeTree(CONTENT_W);

    // 关键序列：最后一次回到 120，会命中第二次 layout 留下的 width=120 缓存条目。
    // 修复前 content.left 冻结在 width=50 时的 16，永不回到 86。
    for (const width of [60, 120, 50, 120, 60, 200, 120]) {
      layoutAt(root, width);

      const rowWidth = row.getComputedWidth();
      expect(rowWidth).toBe(width - 2); // paddingX=1 各边
      // flex-end：内容左缘 = 行宽 - 内容宽，右缘恰好贴行内缘
      expect(content.getComputedLeft()).toBe(rowWidth - CONTENT_W);
      expect(content.getComputedLeft() + CONTENT_W).toBe(rowWidth);
    }
  });

  test("同一宽度重复 layout 幂等（不因缓存写入而漂移）", () => {
    const { root, row, content } = buildFooterLikeTree(CONTENT_W);
    // 超过 CACHE_SLOTS(4) 次，确保 LRU 环绕后依然正确
    for (let i = 0; i < 6; i++) {
      layoutAt(root, 80);
      expect(content.getComputedLeft()).toBe(row.getComputedWidth() - CONTENT_W);
    }
  });

  test("变窄方向也重新定位（放不下时收敛，再放大必须恢复贴右）", () => {
    const { root, content } = buildFooterLikeTree(CONTENT_W);
    layoutAt(root, 120);
    expect(content.getComputedLeft()).toBe(118 - CONTENT_W);

    // 窄到内容放不下：flex-end 下 left 收敛到 <=0，不得残留旧的大 left
    layoutAt(root, 10);
    expect(content.getComputedLeft()).toBeLessThanOrEqual(0);

    // 再放大必须恢复贴右
    layoutAt(root, 120);
    expect(content.getComputedLeft()).toBe(118 - CONTENT_W);
  });

  test("居中（center）子节点同样跟随宽度变化", () => {
    const root = Yoga.Node.create();
    root.setFlexDirection(FlexDirection.Row);
    root.setJustifyContent(Justify.Center);
    const child = Yoga.Node.create();
    child.setFlexShrink(0);
    child.setMeasureFunc(() => ({ width: 10, height: 1 }));
    root.insertChild(child, 0);

    for (const width of [60, 120, 50, 120]) {
      layoutAt(root, width);
      expect(child.getComputedLeft()).toBe((width - 10) / 2);
    }
  });
});
