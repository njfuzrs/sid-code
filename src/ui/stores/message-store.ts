/**
 * 消息数据存储
 *
 * 存储 DisplayItem[]，提供增删查接口，EventEmitter 通知变化。
 */

import { EventEmitter } from "events";
import type { DisplayItem } from "../App.tsx";

export class MessageDataStore extends EventEmitter {
  private items: DisplayItem[] = [];

  /** 追加项目 */
  appendItems(newItems: DisplayItem[]): void {
    if (newItems.length === 0) return;
    for (const item of newItems) {
      this.items.push(item);
    }
    this.emit("itemsChanged");
  }

  /** 替换最后一项（用于流式更新） */
  updateLastItem(item: DisplayItem): void {
    if (this.items.length > 0) {
      this.items[this.items.length - 1] = item;
    } else {
      this.items.push(item);
    }
    this.emit("itemsChanged");
  }

  /** 清空 */
  clear(): void {
    this.items = [];
    this.emit("itemsChanged");
  }

  /** 获取所有项目 */
  getItems(): readonly DisplayItem[] {
    return this.items;
  }

  /** 获取指定索引的项目 */
  getItem(index: number): DisplayItem | undefined {
    return this.items[index];
  }

  /** 项目数量 */
  getItemCount(): number {
    return this.items.length;
  }

  /** 设置全部项目（重建时使用） */
  setItems(items: DisplayItem[]): void {
    this.items = items;
    this.emit("itemsChanged");
  }
}
