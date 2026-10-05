/**
 * 节点级输出缓存（B9 / T3.4，契约 P3）。
 *
 * ① 等价性：每次变更之后，带缓存出的屏幕必须与「全部清掉缓存重走一遍」逐单元一致。
 *    变更覆盖缓存键的每一维：文本、中间插入（纵向平移）、样式、属性、transform、显隐、宽度变化、Static 外的删除。
 * ② 只走脏子树：2000 项历史、只改底部一行时，每帧真正遍历的节点数与历史长度无关。
 */
import { describe, expect, test } from "bun:test";
import { PassThrough } from "node:stream";
import React, { useSyncExternalStore } from "react";
import { Box, render, Text, Transform } from "../src/index.ts";
import instances from "../src/instances.ts";
import renderer from "../src/renderer.ts";
import { renderStats } from "../src/render-node-to-output.ts";
import { screenToString } from "../src/screen/index.ts";
import Yoga from "yoga-layout";
import applyStyles from "../src/styles.ts";
import {
  appendChildNode,
  createNode,
  createTextNode,
  type DOMElement,
  type DOMNode,
  insertBeforeNode,
  markRenderDirty,
  removeChildNode,
  setAttribute,
  setStyle,
  setTextNodeValue,
  type TextNode,
} from "../src/dom.ts";

function store<T>(v: T) {
  const subs = new Set<() => void>();
  return {
    get: () => v,
    set(n: T) {
      v = n;
      for (const s of subs) s();
    },
    use: () =>
      useSyncExternalStore(
        (cb) => (subs.add(cb), () => subs.delete(cb)),
        () => v,
      ),
  };
}

function mount(node: React.ReactNode, columns = 40) {
  // 直接接管 write：PassThrough 的 data 事件是异步派发的，同步断言时还读不到
  let buf = "";
  const stdout = Object.assign(new PassThrough(), { columns, rows: 10, isTTY: false });
  stdout.write = ((chunk: string | Uint8Array) => {
    buf += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString();
    return true;
  }) as typeof stdout.write;
  const stdin = Object.assign(new PassThrough(), { isTTY: false });
  const inst = render(node, {
    stdout: stdout as never,
    stdin: stdin as never,
    patchConsole: false,
    exitOnCtrlC: false,
  });
  const root = (instances.get(stdout as never) as unknown as { rootNode: DOMElement }).rootNode;
  return { inst, root, stdout, written: () => buf };
}

/** 等 React 提交 + 底座出帧（useSyncExternalStore 的更新在 microtask 里提交，同步断言会读到旧 DOM） */
const flush = () => new Promise((r) => setTimeout(r, 5));

function dirtyAll(node: DOMNode) {
  node.renderDirty = true;
  if (node.nodeName !== "#text") for (const c of node.childNodes) dirtyAll(c);
}

/**
 * 底座这一帧真正写出的内容（走缓存的增量路径） vs 清空缓存冷渲染，必须一致。
 * 非 TTY 下每帧写整帧（R12，包在 DEC 2026 里），取最后一帧。不能自己再调一次 renderer 当「带缓存」那一侧：
 * 底座刚按当前布局渲染过，缓存已是最新，再调只会回放一份必然正确的东西，测不出平移 / 键遗漏。
 */
function expectCacheEquivalent(root: DOMElement, written: () => string) {
  const frames = written().split("\x1b[?2026h");
  const last = frames.at(-1)!.replace("\x1b[?2026l", "");
  dirtyAll(root);
  const cold = screenToString(renderer(root, false, false).screen!);
  expect(JSON.stringify(last)).toBe(JSON.stringify(cold));
}

describe("P3 节点级输出缓存", () => {
  test("P3: 每种变更后带缓存的屏幕与冷渲染逐字节一致", async () => {
    type S = {
      items: string[];
      color: "ansi:red" | "ansi:green";
      pad: number;
      hidden: boolean;
      upper: boolean;
      tab: boolean;
      tall: boolean;
      word: string;
      ghost: boolean;
    };
    const st = store<S>({
      items: ["一", "二", "三", "四"],
      color: "ansi:red",
      pad: 0,
      hidden: false,
      upper: false,
      tab: false,
      tall: false,
      word: "abc",
      ghost: false,
    });
    const Item = React.memo(({ s }: { s: string }) => (
      <Box borderStyle="round" paddingX={1}>
        <Text>{s} 内容</Text>
      </Box>
    ));
    function App() {
      const s = st.use();
      return (
        <Box flexDirection="column">
          {s.items.map((t) => (
            <Item key={t} s={t} />
          ))}
          <Box paddingLeft={s.pad} display={s.hidden ? "none" : "flex"}>
            <Text color={s.color}>{s.tab ? "a\tb" : "ab"}</Text>
          </Box>
          {/* memo 的子树只被父级横向挪动：自己没改、不标脏，缓存必须按横坐标失效（tab 对齐屏幕绝对列） */}
          <Box paddingLeft={s.pad}>
            <Item s={"x\ty"} />
          </Box>
          {/* memo 的边框盒被父级拉高：自己没改、不标脏，缓存必须按高度失效（边框画在新高度上） */}
          <Box height={s.tall ? 6 : 3} flexDirection="column">
            <Box flexGrow={1}>
              <Item s="grow" />
            </Box>
          </Box>
          <Transform transform={(l) => (s.upper ? l.toUpperCase() : l)}>
            <Text>tail line</Text>
          </Transform>
          {/* 下面几处尺寸都不变，只能靠标脏失效：同宽文本、等高换项、定高盒里的显隐 */}
          <Text>{s.word}</Text>
          <Box height={2} flexDirection="column">
            <Text>always</Text>
            <Box display={s.ghost ? "none" : "flex"}>
              <Text>ghost</Text>
            </Box>
          </Box>
        </Box>
      );
    }
    const { inst, root, stdout, written } = mount(<App />);
    const steps: Array<Partial<S> | "resize"> = [
      { items: ["零", "一", "二", "三", "四"] }, // 中间插入：后面的项纵向平移
      { items: ["零", "一", "三", "四"] }, // 删除
      { color: "ansi:green" },
      { pad: 3 },
      { tab: true },
      { pad: 1 }, // tab 跟着横坐标变
      { hidden: true },
      { hidden: false },
      { upper: true }, // transform 换了函数
      { tall: true },
      { word: "xyz" }, // 同宽文本
      { items: ["零", "一", "五", "四"] }, // 等高换项：父盒尺寸不变
      { ghost: true }, // 定高盒里隐藏
      { ghost: false },
      "resize",
      { items: ["一"] },
    ];
    await flush();
    expectCacheEquivalent(root, written);
    for (const step of steps) {
      if (step === "resize") {
        (stdout as unknown as { columns: number }).columns = 25;
        stdout.emit("resize");
      } else st.set({ ...st.get(), ...step });
      await flush();
      expectCacheEquivalent(root, written);
    }
    inst.unmount();
  });

  test("P3: 2000 项历史只改底部一行，每帧遍历的节点数与历史长度无关", async () => {
    for (const n of [200, 2000]) {
      const counter = store(0);
      const Item = React.memo(({ i }: { i: number }) => (
        <Box flexDirection="column" paddingLeft={2}>
          <Text>● 工具 {i}</Text>
          <Text>结果 {i}</Text>
        </Box>
      ));
      function App() {
        const c = counter.use();
        return (
          <Box flexDirection="column">
            {Array.from({ length: n }, (_, i) => (
              <Item key={i} i={i} />
            ))}
            <Text>计数 {c}</Text>
          </Box>
        );
      }
      const { inst } = mount(<App />, 80);
      await flush();
      const before = renderStats.walked;
      for (let k = 1; k <= 10; k++) {
        counter.set(k);
        await flush();
      }
      const perFrame = (renderStats.walked - before) / 10;
      // 根 + 外层 Box + 底部那行 Text = 3；与 n 无关
      expect(perFrame, `n=${n}`).toBeLessThanOrEqual(3);
      inst.unmount();
    }
  });
});

/**
 * DOM 层逐个 API 自证：经 React 时同一次更新往往走好几条标脏路径（`<Text>` 每次渲染都换 `internal_transform`），
 * 漏掉任一条都会被别的路径盖住。这里绕过 React，直接调 dom / reconciler 的单个变更 API，
 * 每次只动一处，再比「带缓存」与「冷渲染」。
 */
describe("P3 标脏覆盖每个变更 API（DOM 层）", () => {
  // 每个用例：建一棵树、渲染一次（填缓存）、做一处变更、再渲染比较
  type Tree = { root: DOMElement; a: DOMElement; b: DOMElement; textA: TextNode; box: DOMElement };
  function build(): Tree {
    const root = createNode("ink-root");
    root.yogaNode!.setWidth(20);
    const box = createNode("ink-box");
    setStyle(box, { flexDirection: "column" });
    applyStyles(box.yogaNode!, { flexDirection: "column" });
    // 定高：子节点怎么变，box 尺寸都不变，只能靠标脏失效
    box.yogaNode!.setHeight(3);
    const a = createNode("ink-text");
    const textA = createTextNode("aaa");
    appendChildNode(a, textA as unknown as DOMElement);
    const b = createNode("ink-text");
    appendChildNode(b, createTextNode("bbb") as unknown as DOMElement);
    appendChildNode(box, a);
    appendChildNode(box, b);
    appendChildNode(root, box);
    return { root, a, b, textA, box };
  }
  const draw = (root: DOMElement) => {
    root.yogaNode!.calculateLayout(undefined, undefined, Yoga.DIRECTION_LTR);
    return screenToString(renderer(root, false, false).screen!);
  };
  const cases: Record<string, (t: Tree) => void> = {
    "setTextNodeValue（同宽）": (t) => setTextNodeValue(t.textA, "xyz"),
    // 只改 DOM 样式、不改 yoga：边框是渲染时画的，尺寸不变
    setStyle: (t) => setStyle(t.box, { ...t.box.style, borderStyle: "round" }),
    "removeChildNode（单独删）": (t) => removeChildNode(t.box, t.b),
    "appendChildNode（单独追加）": (t) => {
      const c = createNode("ink-text");
      appendChildNode(c, createTextNode("ccc") as unknown as DOMElement);
      appendChildNode(t.box, c);
    },
    setAttribute: (t) => setAttribute(t.box, "data", 1),
    "removeChildNode + appendChildNode（换顺序）": (t) => {
      removeChildNode(t.box, t.a);
      appendChildNode(t.box, t.a);
    },
    insertBeforeNode: (t) => {
      const c = createNode("ink-text");
      appendChildNode(c, createTextNode("ccc") as unknown as DOMElement);
      insertBeforeNode(t.box, c, t.a);
    },
    "internal_transform（盒上的 transformer 下传给子节点）": (t) => {
      t.box.internal_transform = (s) => s.toUpperCase();
      markRenderDirty(t.box);
    },
  };
  for (const [name, mutate] of Object.entries(cases)) {
    test(`P3: ${name} 之后缓存与冷渲染一致`, () => {
      const t = build();
      draw(t.root);
      mutate(t);
      const cached = draw(t.root);
      dirtyAll(t.root);
      expect(JSON.stringify(cached)).toBe(JSON.stringify(draw(t.root)));
    });
  }
});
