/**
 * 两阶段事件分发器 — P1-1
 *
 * 流程(对齐浏览器 DOM 事件模型):
 * 1. 从 target 沿 parentNode 链收集路径(target → root)
 * 2. 捕获阶段:root → target,调用各节点 captureHandlers
 * 3. 冒泡阶段:target → root,调用各节点 bubbleHandlers
 * 4. 任一阶段 stopPropagation() → 停止后续节点;stopImmediatePropagation() → 当前节点也立即停止
 *
 * 返回事件是否被"消费"(任一 handler 调用了 stopPropagation/preventDefault),
 * 供 KeypressContext 集成层决定是否回退到优先级处理器。
 */

import type { EventTarget, TerminalEvent } from "./terminal-event.ts";

/** 收集 target → root 的节点路径 */
export function collectPath(target: EventTarget): EventTarget[] {
  const path: EventTarget[] = [];
  let node: EventTarget | null = target;
  const seen = new Set<EventTarget>();
  while (node) {
    if (seen.has(node)) break; // 防御:环路保护
    seen.add(node);
    path.push(node);
    node = node.parentNode;
  }
  return path;
}

export function dispatch(event: TerminalEvent, target: EventTarget): boolean {
  event.target = target;
  const path = collectPath(target);

  // 捕获阶段:root → target
  event.eventPhase = "capture";
  for (let i = path.length - 1; i >= 0; i--) {
    const node = path[i];
    event.currentTarget = node;
    const handlers = node.captureHandlers.get(event.type);
    if (handlers) {
      // 复制一份,避免 handler 内部增删集合导致迭代异常
      for (const handler of [...handlers]) {
        handler(event);
        if (event.immediatePropagationStopped) {
          return finish(event);
        }
      }
    }
    if (event.propagationStopped) {
      return finish(event);
    }
  }

  // 冒泡阶段:target → root
  event.eventPhase = "bubble";
  for (let i = 0; i < path.length; i++) {
    const node = path[i];
    event.currentTarget = node;
    const handlers = node.bubbleHandlers.get(event.type);
    if (handlers) {
      for (const handler of [...handlers]) {
        handler(event);
        if (event.immediatePropagationStopped) {
          return finish(event);
        }
      }
    }
    if (event.propagationStopped) {
      return finish(event);
    }
  }

  return finish(event);
}

function finish(event: TerminalEvent): boolean {
  event.eventPhase = "none";
  event.currentTarget = null;
  return event.propagationStopped || event.defaultPrevented;
}

/** 在节点上注册 handler,返回注销函数 */
export function addHandler(
  node: EventTarget,
  type: string,
  handler: (event: TerminalEvent) => void,
  phase: "capture" | "bubble" = "bubble",
): () => void {
  const map = phase === "capture" ? node.captureHandlers : node.bubbleHandlers;
  let set = map.get(type);
  if (!set) {
    set = new Set();
    map.set(type, set);
  }
  set.add(handler);
  return () => {
    set!.delete(handler);
    if (set!.size === 0) map.delete(type);
  };
}
