/**
 * Swarm 文件邮箱（Spec 18 §7.3.1）
 *
 * 团队成员（teammate）之间的持久化消息通道。每个成员一个收件箱目录，
 * 消息以单调递增序号的 JSON 文件落盘，读取后标记已读（移动到 .read/）。
 *
 * 与 message-queue.ts（进程内、易失）互补：mailbox 跨进程、可持久、可回放。
 */

import { writeFileSync, readFileSync, readdirSync, renameSync, mkdirSync, existsSync } from "fs";
import { join } from "path";

/** 邮件 */
export interface MailMessage {
  /** 单调递增序号（同一收件箱内有序） */
  seq: number;
  from: string;
  to: string;
  content: string;
  /** 可选消息类型：task(任务) / result(结果) / info(通知) */
  kind?: "task" | "result" | "info";
  timestamp: number;
}

export class Mailbox {
  private readonly root: string;
  /** 各收件箱的本地序号计数（仅用于本进程生成单调序号兜底） */
  private seqCounters = new Map<string, number>();

  /**
   * @param baseDir 团队根目录（如 .sid-code/swarm/<team>）
   */
  constructor(baseDir: string) {
    this.root = join(baseDir, "mailboxes");
  }

  private inboxDir(member: string): string {
    const safe = member.replace(/[^a-zA-Z0-9_-]/g, "_");
    return join(this.root, safe);
  }

  private readDir(member: string): string {
    return join(this.inboxDir(member), ".read");
  }

  /** 发送消息到目标成员收件箱 */
  send(msg: Omit<MailMessage, "seq" | "timestamp"> & { timestamp: number }): MailMessage {
    const dir = this.inboxDir(msg.to);
    mkdirSync(dir, { recursive: true });

    const seq = this.nextSeq(msg.to);
    const full: MailMessage = { ...msg, seq };
    // 序号零填充保证文件名字典序 == 序号序
    const fileName = `${String(seq).padStart(12, "0")}.json`;
    writeFileSync(join(dir, fileName), JSON.stringify(full, null, 2));
    return full;
  }

  /** 读取并清空目标成员的未读消息（按序号升序） */
  drain(member: string): MailMessage[] {
    const dir = this.inboxDir(member);
    if (!existsSync(dir)) return [];

    let files: string[];
    try {
      files = readdirSync(dir).filter((f) => f.endsWith(".json"));
    } catch {
      return [];
    }
    files.sort(); // 字典序 == 序号序（零填充）

    const readDir = this.readDir(member);
    mkdirSync(readDir, { recursive: true });

    const messages: MailMessage[] = [];
    for (const f of files) {
      const src = join(dir, f);
      try {
        const msg: MailMessage = JSON.parse(readFileSync(src, "utf-8"));
        messages.push(msg);
        // 标记已读：移动到 .read/
        renameSync(src, join(readDir, f));
      } catch {
        /* 损坏消息跳过 */
      }
    }
    return messages;
  }

  /** 查看未读消息数（不消费） */
  peekCount(member: string): number {
    const dir = this.inboxDir(member);
    if (!existsSync(dir)) return 0;
    try {
      return readdirSync(dir).filter((f) => f.endsWith(".json")).length;
    } catch {
      return 0;
    }
  }

  /** 生成单调递增序号：取收件箱现有最大序号 + 本进程计数 */
  private nextSeq(member: string): number {
    const dir = this.inboxDir(member);
    let maxOnDisk = 0;
    for (const sub of [dir, this.readDir(member)]) {
      if (!existsSync(sub)) continue;
      try {
        for (const f of readdirSync(sub)) {
          if (!f.endsWith(".json")) continue;
          const n = parseInt(f.replace(/\.json$/, ""), 10);
          if (!Number.isNaN(n) && n > maxOnDisk) maxOnDisk = n;
        }
      } catch {
        /* 忽略 */
      }
    }
    const local = (this.seqCounters.get(member) ?? 0) + 1;
    this.seqCounters.set(member, local);
    return Math.max(maxOnDisk + 1, local);
  }
}
