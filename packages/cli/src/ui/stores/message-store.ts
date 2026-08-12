/**
 * 消息数据存储
 *
 * 存储 DisplayItem[]，提供增删查接口，类型安全的事件通知。
 * 每次变更都创建新数组引用，确保 React 不可变性约定。
 */

import { EventEmitter } from "events";
import type { DisplayItem } from "../App.tsx";

/** 类型安全的事件定义 */
interface MessageStoreEvents {
  itemsChanged: [];
}

export class MessageDataStore extends EventEmitter {
  private items: DisplayItem[] = [];

  constructor() {
    super();
    // 设置最大监听器数量，避免默认 10 个的警告
    this.setMaxListeners(50);
  }

  // 类型安全的 emit/on/off 重载
  override emit<K extends keyof MessageStoreEvents>(
    event: K,
    ...args: MessageStoreEvents[K]
  ): boolean {
    return super.emit(event, ...args);
  }
  override on<K extends keyof MessageStoreEvents>(
    event: K,
    listener: (...args: MessageStoreEvents[K]) => void,
  ): this {
    return super.on(event, listener as (...args: any[]) => void);
  }
  override off<K extends keyof MessageStoreEvents>(
    event: K,
    listener: (...args: MessageStoreEvents[K]) => void,
  ): this {
    return super.off(event, listener as (...args: any[]) => void);
  }

  /** 追加项目（创建新数组引用） */
  appendItems(newItems: DisplayItem[]): void {
    if (newItems.length === 0) return;
    this.items = [...this.items, ...newItems];
    this.emit("itemsChanged");
  }

  /** 替换最后一项（创建新数组引用） */
  updateLastItem(item: DisplayItem): void {
    if (this.items.length > 0) {
      const newItems = this.items.slice(0, -1);
      newItems.push(item);
      this.items = newItems;
    } else {
      this.items = [item];
    }
    this.emit("itemsChanged");
  }

  /** 清空 */
  clear(): void {
    this.items = [];
    this.emit("itemsChanged");
  }

  /** 获取所有项目（返回当前数组引用，变更时引用会更新） */
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
    this.items = [...items];
    this.emit("itemsChanged");
  }

  /** 清理所有监听器和数据 */
  destroy(): void {
    this.removeAllListeners();
    this.items = [];
  }
}
