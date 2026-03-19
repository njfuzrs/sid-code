/**
 * Rasterizer 单元测试
 *
 * 测试 Yoga DOM 树 → ScreenBuffer 光栅化的正确性。
 * 重点测试：文本渲染、背景色、边框、裁剪、transformer 链。
 */

import { describe, it, expect, beforeEach } from "bun:test";
import { Rasterizer } from "../../../src/ui/renderer/rasterizer.ts";
import { ScreenBuffer } from "../../../src/ui/renderer/screen-buffer.ts";
import { COLOR_DEFAULT, MOD_DIM } from "../../../src/ui/renderer/constants.ts";
import Yoga from "yoga-layout";

/**
 * 创建一个简单的 Yoga 节点树用于测试
 */
function createTestNode(config: {
  nodeName: string;
  width?: number;
  height?: number;
  text?: string;
  style?: any;
  children?: any[];
}): any {
  const yogaNode = Yoga.Node.create();
  if (config.width !== undefined) {
    yogaNode.setWidth(config.width);
  }
  if (config.height !== undefined) {
    yogaNode.setHeight(config.height);
  }

  const node: any = {
    nodeName: config.nodeName,
    yogaNode,
    style: config.style || {},
    childNodes: config.children || [],
    internal_static: false,
  };

  // 为子节点设置父节点引用
  for (const child of node.childNodes) {
    if (child.yogaNode) {
      yogaNode.insertChild(child.yogaNode, yogaNode.getChildCount());
    }
  }

  return node;
}

/**
 * 创建一个文本节点（ink-text）
 */
function createTextNode(text: string, style: any = {}): any {
  const yogaNode = Yoga.Node.create();
  yogaNode.setWidth(text.length);
  yogaNode.setHeight(1);

  return {
    nodeName: "ink-text",
    yogaNode,
    style,
    childNodes: [
      {
        nodeName: "#text",
        nodeValue: text,
      },
    ],
    internal_static: false,
  };
}

describe("Rasterizer", () => {
  let rasterizer: Rasterizer;
  let buffer: ScreenBuffer;

  beforeEach(() => {
    rasterizer = new Rasterizer();
    buffer = new ScreenBuffer(80, 24);
  });

  describe("基本文本渲染", () => {
    it("渲染简单文本到 buffer", () => {
      const textNode = createTextNode("Hello");
      const rootNode = createTestNode({
        nodeName: "ink-root",
        width: 80,
        height: 24,
        children: [textNode],
      });

      rootNode.yogaNode.calculateLayout(80, 24, Yoga.DIRECTION_LTR);
      rasterizer.rasterize(rootNode, buffer, { skipStaticElements: true });

      expect(buffer.getSymbol(0, 0)).toBe("H");
      expect(buffer.getSymbol(1, 0)).toBe("e");
      expect(buffer.getSymbol(2, 0)).toBe("l");
      expect(buffer.getSymbol(3, 0)).toBe("l");
      expect(buffer.getSymbol(4, 0)).toBe("o");
    });

    it("跳过空文本节点", () => {
      const textNode = createTextNode("");
      const rootNode = createTestNode({
        nodeName: "ink-root",
        width: 80,
        height: 24,
        children: [textNode],
      });

      rootNode.yogaNode.calculateLayout(80, 24, Yoga.DIRECTION_LTR);
      rasterizer.rasterize(rootNode, buffer, { skipStaticElements: true });

      // buffer 应该保持空白
      expect(buffer.getSymbol(0, 0)).toBe(" ");
    });

    it("渲染多行文本", () => {
      const textNode = createTextNode("Line1\nLine2");
      textNode.yogaNode.setWidth(10);
      textNode.yogaNode.setHeight(2);

      const rootNode = createTestNode({
        nodeName: "ink-root",
        width: 80,
        height: 24,
        children: [textNode],
      });

      rootNode.yogaNode.calculateLayout(80, 24, Yoga.DIRECTION_LTR);
      rasterizer.rasterize(rootNode, buffer, { skipStaticElements: true });

      expect(buffer.getSymbol(0, 0)).toBe("L");
      expect(buffer.getSymbol(4, 0)).toBe("1");
      expect(buffer.getSymbol(0, 1)).toBe("L");
      expect(buffer.getSymbol(4, 1)).toBe("2");
    });
  });

  describe("背景色渲染", () => {
    it("渲染背景色填充", () => {
      const boxNode = createTestNode({
        nodeName: "ink-box",
        width: 5,
        height: 3,
        style: { backgroundColor: "#ff0000" },
      });

      const rootNode = createTestNode({
        nodeName: "ink-root",
        width: 80,
        height: 24,
        children: [boxNode],
      });

      rootNode.yogaNode.calculateLayout(80, 24, Yoga.DIRECTION_LTR);
      rasterizer.rasterize(rootNode, buffer, { skipStaticElements: true });

      // 检查背景色区域
      for (let y = 0; y < 3; y++) {
        for (let x = 0; x < 5; x++) {
          expect(buffer.getBg(x, y)).toBe(0xff0000);
          expect(buffer.getSymbol(x, y)).toBe(" ");
        }
      }

      // 检查背景色外的区域
      expect(buffer.getBg(5, 0)).toBe(COLOR_DEFAULT);
    });

    it("跳过默认背景色", () => {
      const boxNode = createTestNode({
        nodeName: "ink-box",
        width: 5,
        height: 3,
        style: { backgroundColor: undefined },
      });

      const rootNode = createTestNode({
        nodeName: "ink-root",
        width: 80,
        height: 24,
        children: [boxNode],
      });

      rootNode.yogaNode.calculateLayout(80, 24, Yoga.DIRECTION_LTR);
      rasterizer.rasterize(rootNode, buffer, { skipStaticElements: true });

      // 没有背景色，buffer 保持默认
      expect(buffer.getBg(0, 0)).toBe(COLOR_DEFAULT);
    });
  });

  describe("边框渲染", () => {
    it("渲染完整边框", () => {
      const boxNode = createTestNode({
        nodeName: "ink-box",
        width: 5,
        height: 3,
        style: { borderStyle: "single", borderColor: "#00ff00" },
      });
      boxNode.yogaNode.setBorder(Yoga.EDGE_ALL, 1);

      const rootNode = createTestNode({
        nodeName: "ink-root",
        width: 80,
        height: 24,
        children: [boxNode],
      });

      rootNode.yogaNode.calculateLayout(80, 24, Yoga.DIRECTION_LTR);
      rasterizer.rasterize(rootNode, buffer, { skipStaticElements: true });

      // 检查四个角
      expect(buffer.getSymbol(0, 0)).toBe("┌");
      expect(buffer.getSymbol(4, 0)).toBe("┐");
      expect(buffer.getSymbol(0, 2)).toBe("└");
      expect(buffer.getSymbol(4, 2)).toBe("┘");

      // 检查边框颜色
      expect(buffer.getFg(0, 0)).toBe(0x00ff00);
    });

    it("渲染部分边框（只有顶部和左侧）", () => {
      const boxNode = createTestNode({
        nodeName: "ink-box",
        width: 5,
        height: 3,
        style: {
          borderStyle: "single",
          borderTop: true,
          borderLeft: true,
          borderRight: false,
          borderBottom: false,
        },
      });
      boxNode.yogaNode.setBorder(Yoga.EDGE_TOP, 1);
      boxNode.yogaNode.setBorder(Yoga.EDGE_LEFT, 1);

      const rootNode = createTestNode({
        nodeName: "ink-root",
        width: 80,
        height: 24,
        children: [boxNode],
      });

      rootNode.yogaNode.calculateLayout(80, 24, Yoga.DIRECTION_LTR);
      rasterizer.rasterize(rootNode, buffer, { skipStaticElements: true });

      // 左上角
      expect(buffer.getSymbol(0, 0)).toBe("┌");
      // 顶部边框
      expect(buffer.getSymbol(1, 0)).toBe("─");
      // 左侧边框
      expect(buffer.getSymbol(0, 1)).toBe("│");

      // 右下角应该没有边框
      expect(buffer.getSymbol(4, 2)).toBe(" ");
    });

    it("边框 dim 标志", () => {
      const boxNode = createTestNode({
        nodeName: "ink-box",
        width: 5,
        height: 3,
        style: {
          borderStyle: "single",
          borderDimColor: true,
        },
      });
      boxNode.yogaNode.setBorder(Yoga.EDGE_ALL, 1);

      const rootNode = createTestNode({
        nodeName: "ink-root",
        width: 80,
        height: 24,
        children: [boxNode],
      });

      rootNode.yogaNode.calculateLayout(80, 24, Yoga.DIRECTION_LTR);
      rasterizer.rasterize(rootNode, buffer, { skipStaticElements: true });

      // 检查 dim 标志
      expect(buffer.getMods(0, 0)).toBe(MOD_DIM);
    });
  });

  describe("裁剪（overflow: hidden）", () => {
    it("水平裁剪超出内容", () => {
      const textNode = createTextNode("LongTextThatExceedsWidth");
      textNode.yogaNode.setWidth(24);
      textNode.yogaNode.setHeight(1);

      const boxNode = createTestNode({
        nodeName: "ink-box",
        width: 10,
        height: 3,
        style: { overflowX: "hidden" },
        children: [textNode],
      });

      const rootNode = createTestNode({
        nodeName: "ink-root",
        width: 80,
        height: 24,
        children: [boxNode],
      });

      rootNode.yogaNode.calculateLayout(80, 24, Yoga.DIRECTION_LTR);
      rasterizer.rasterize(rootNode, buffer, { skipStaticElements: true });

      // 前 10 个字符应该被渲染: L o n g T e x t T h
      expect(buffer.getSymbol(0, 0)).toBe("L");
      expect(buffer.getSymbol(9, 0)).toBe("h");

      // 第 11 个字符应该被裁剪（超出 box 宽度）
      expect(buffer.getSymbol(10, 0)).toBe(" ");
    });

    it("垂直裁剪超出内容", () => {
      const textNode = createTextNode("Line1\nLine2\nLine3\nLine4");
      textNode.yogaNode.setWidth(10);
      textNode.yogaNode.setHeight(4);

      const boxNode = createTestNode({
        nodeName: "ink-box",
        width: 10,
        height: 2,
        style: { overflowY: "hidden" },
        children: [textNode],
      });

      const rootNode = createTestNode({
        nodeName: "ink-root",
        width: 80,
        height: 24,
        children: [boxNode],
      });

      rootNode.yogaNode.calculateLayout(80, 24, Yoga.DIRECTION_LTR);
      rasterizer.rasterize(rootNode, buffer, { skipStaticElements: true });

      // 前 2 行应该被渲染
      expect(buffer.getSymbol(0, 0)).toBe("L");
      expect(buffer.getSymbol(0, 1)).toBe("L");

      // 第 3 行应该被裁剪
      expect(buffer.getSymbol(0, 2)).toBe(" ");
    });

    it("嵌套裁剪取交集", () => {
      const textNode = createTextNode("VeryLongText");
      textNode.yogaNode.setWidth(12);
      textNode.yogaNode.setHeight(1);

      const innerBox = createTestNode({
        nodeName: "ink-box",
        width: 10,
        height: 1,
        style: { overflowX: "hidden" },
        children: [textNode],
      });

      const outerBox = createTestNode({
        nodeName: "ink-box",
        width: 8,
        height: 1,
        style: { overflowX: "hidden" },
        children: [innerBox],
      });

      const rootNode = createTestNode({
        nodeName: "ink-root",
        width: 80,
        height: 24,
        children: [outerBox],
      });

      rootNode.yogaNode.calculateLayout(80, 24, Yoga.DIRECTION_LTR);
      rasterizer.rasterize(rootNode, buffer, { skipStaticElements: true });

      // 应该只渲染前 8 个字符（外层 box 的限制）
      expect(buffer.getSymbol(0, 0)).toBe("V");
      expect(buffer.getSymbol(7, 0)).toBe("g");
      expect(buffer.getSymbol(8, 0)).toBe(" ");
    });
  });

  describe("display:none 跳过", () => {
    it("跳过 display:none 节点", () => {
      const textNode = createTextNode("Hidden");
      textNode.yogaNode.setDisplay(Yoga.DISPLAY_NONE);

      const rootNode = createTestNode({
        nodeName: "ink-root",
        width: 80,
        height: 24,
        children: [textNode],
      });

      rootNode.yogaNode.calculateLayout(80, 24, Yoga.DIRECTION_LTR);
      rasterizer.rasterize(rootNode, buffer, { skipStaticElements: true });

      // buffer 应该保持空白
      expect(buffer.getSymbol(0, 0)).toBe(" ");
    });
  });

  describe("Static 节点跳过", () => {
    it("skipStaticElements=true 时跳过 Static 节点", () => {
      const textNode = createTextNode("Static");
      textNode.internal_static = true;

      const rootNode = createTestNode({
        nodeName: "ink-root",
        width: 80,
        height: 24,
        children: [textNode],
      });

      rootNode.yogaNode.calculateLayout(80, 24, Yoga.DIRECTION_LTR);
      rasterizer.rasterize(rootNode, buffer, { skipStaticElements: true });

      // buffer 应该保持空白
      expect(buffer.getSymbol(0, 0)).toBe(" ");
    });

    it("skipStaticElements=false 时渲染 Static 节点", () => {
      const textNode = createTextNode("Static");
      textNode.internal_static = true;

      const rootNode = createTestNode({
        nodeName: "ink-root",
        width: 80,
        height: 24,
        children: [textNode],
      });

      rootNode.yogaNode.calculateLayout(80, 24, Yoga.DIRECTION_LTR);
      rasterizer.rasterize(rootNode, buffer, { skipStaticElements: false });

      // 应该渲染 Static 内容
      expect(buffer.getSymbol(0, 0)).toBe("S");
    });
  });

  describe("rasterizeStaticToString", () => {
    it("返回 Static 区域的字符串", () => {
      const textNode = createTextNode("StaticOutput");
      textNode.internal_static = true;
      textNode.yogaNode.setWidth(12);
      textNode.yogaNode.setHeight(1);

      const staticNode = createTestNode({
        nodeName: "ink-box",
        width: 12,
        height: 1,
        children: [textNode],
      });

      staticNode.yogaNode.calculateLayout(12, 1, Yoga.DIRECTION_LTR);
      const output = rasterizer.rasterizeStaticToString(staticNode);

      // 应该包含文本内容
      expect(output).toContain("StaticOutput");
    });

    it("空 Static 节点返回空字符串", () => {
      const output = rasterizer.rasterizeStaticToString(null);
      expect(output).toBe("");
    });
  });

  describe("边界情况", () => {
    it("空 rootNode 不抛出异常", () => {
      expect(() => {
        rasterizer.rasterize(null as any, buffer, { skipStaticElements: true });
      }).not.toThrow();
    });

    it("rootNode 没有 yogaNode 不抛出异常", () => {
      const rootNode = { nodeName: "ink-root", childNodes: [] };
      expect(() => {
        rasterizer.rasterize(rootNode, buffer, { skipStaticElements: true });
      }).not.toThrow();
    });

    it("背景色区域为负数时不渲染", () => {
      const boxNode = createTestNode({
        nodeName: "ink-box",
        width: 2,
        height: 2,
        style: {
          backgroundColor: "#ff0000",
          borderStyle: "single",
        },
      });
      // 边框占据全部空间，内容区域为负
      boxNode.yogaNode.setBorder(Yoga.EDGE_ALL, 2);

      const rootNode = createTestNode({
        nodeName: "ink-root",
        width: 80,
        height: 24,
        children: [boxNode],
      });

      rootNode.yogaNode.calculateLayout(80, 24, Yoga.DIRECTION_LTR);

      expect(() => {
        rasterizer.rasterize(rootNode, buffer, { skipStaticElements: true });
      }).not.toThrow();

      // 不应该有背景色（因为内容区域 <= 0）
      expect(buffer.getBg(0, 0)).toBe(COLOR_DEFAULT);
    });
  });
});
