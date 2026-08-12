/**
 * StorageAdapter 实现
 * ADR-030 / S8-T08
 */

import {
  readFileSync,
  writeFileSync,
  unlinkSync,
  existsSync,
  mkdirSync,
  readdirSync,
} from "node:fs";
import { join } from "node:path";
import type { StorageAdapter } from "./types.ts";

export class FileStorageAdapter implements StorageAdapter {
  private dir: string;

  constructor(dir: string) {
    this.dir = dir;
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  }

  async saveSession(id: string, data: unknown): Promise<void> {
    const path = join(this.dir, `${id}.json`);
    writeFileSync(path, JSON.stringify(data, null, 2), "utf-8");
  }

  async loadSession(id: string): Promise<unknown | null> {
    const path = join(this.dir, `${id}.json`);
    if (!existsSync(path)) return null;
    return JSON.parse(readFileSync(path, "utf-8"));
  }

  async deleteSession(id: string): Promise<void> {
    const path = join(this.dir, `${id}.json`);
    if (existsSync(path)) unlinkSync(path);
  }

  async listSessions(): Promise<string[]> {
    if (!existsSync(this.dir)) return [];
    return readdirSync(this.dir)
      .filter((f) => f.endsWith(".json"))
      .map((f) => f.replace(/\.json$/, ""));
  }
}

export class PostgresStorageAdapter implements StorageAdapter {
  private url: string;

  constructor(url: string) {
    this.url = url;
  }

  async saveSession(_id: string, _data: unknown): Promise<void> {
    throw new Error(`PostgresStorageAdapter not implemented (M6+). URL: ${this.url}`);
  }

  async loadSession(_id: string): Promise<unknown | null> {
    throw new Error("PostgresStorageAdapter not implemented (M6+)");
  }

  async deleteSession(_id: string): Promise<void> {
    throw new Error("PostgresStorageAdapter not implemented (M6+)");
  }

  async listSessions(): Promise<string[]> {
    throw new Error("PostgresStorageAdapter not implemented (M6+)");
  }
}
