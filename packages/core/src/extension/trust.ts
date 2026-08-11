/**
 * 项目级扩展信任管理
 * 存储：~/.sid-code/trusted-extensions.json
 * 格式：{ [projectDir]: { [filePath]: contentHash } }
 */

import { existsSync } from "fs";
import { readFile, writeFile, mkdir } from "fs/promises";
import { createHash } from "crypto";
import { getLogger } from "../debug/logger.ts";
import { sidPaths } from "../config/paths.ts";

/** 信任存储文件路径：~/.sid-code/state/trusted-extensions.json */
function trustFilePath(): string {
  return sidPaths.trustedExtensions();
}

/** 信任存储格式 */
interface TrustStore {
  [projectDir: string]: {
    [filePath: string]: string; // contentHash
  };
}

export class TrustManager {
  private store: TrustStore = {};
  private loaded = false;

  /**
   * 检查文件是否已被信任
   * @param filePath 文件绝对路径
   * @param content 文件内容
   * @param projectDir 项目目录
   */
  async isTrusted(filePath: string, content: string, projectDir: string): Promise<boolean> {
    await this.ensureLoaded();

    const projectTrust = this.store[projectDir];
    if (!projectTrust) return false;

    const storedHash = projectTrust[filePath];
    if (!storedHash) return false;

    const currentHash = this.computeHash(content);
    return storedHash === currentHash;
  }

  /**
   * 记录信任
   * @param filePath 文件绝对路径
   * @param content 文件内容
   * @param projectDir 项目目录
   */
  async trust(filePath: string, content: string, projectDir: string): Promise<void> {
    await this.ensureLoaded();

    if (!this.store[projectDir]) {
      this.store[projectDir] = {};
    }

    const hash = this.computeHash(content);
    this.store[projectDir][filePath] = hash;

    await this.save();
  }

  /**
   * 批量记录信任
   * @param files 文件列表 { filePath, content }
   * @param projectDir 项目目录
   */
  async trustBatch(files: Array<{ filePath: string; content: string }>, projectDir: string): Promise<void> {
    await this.ensureLoaded();

    if (!this.store[projectDir]) {
      this.store[projectDir] = {};
    }

    for (const file of files) {
      const hash = this.computeHash(file.content);
      this.store[projectDir][file.filePath] = hash;
    }

    await this.save();
  }

  /**
   * 移除项目的所有信任记录
   * @param projectDir 项目目录
   */
  async removeTrust(projectDir: string): Promise<void> {
    await this.ensureLoaded();
    delete this.store[projectDir];
    await this.save();
  }

  /**
   * 计算内容 hash（SHA-256）
   */
  computeHash(content: string): string {
    return createHash("sha256").update(content, "utf-8").digest("hex");
  }

  /** 确保已加载存储文件 */
  private async ensureLoaded(): Promise<void> {
    if (this.loaded) return;

    const log = getLogger();

    if (!existsSync(trustFilePath())) {
      this.store = {};
      this.loaded = true;
      return;
    }

    try {
      const content = await readFile(trustFilePath(), "utf-8");
      this.store = JSON.parse(content);
      this.loaded = true;
    } catch (err: any) {
      log.warn("TRUST", `加载信任存储失败: ${err.message}`);
      this.store = {};
      this.loaded = true;
    }
  }

  /** 保存到磁盘 */
  private async save(): Promise<void> {
    const log = getLogger();

    try {
      const dir = sidPaths.state();
      if (!existsSync(dir)) {
        await mkdir(dir, { recursive: true });
      }

      await writeFile(trustFilePath(), JSON.stringify(this.store, null, 2), "utf-8");
    } catch (err: any) {
      log.error("TRUST", `保存信任存储失败: ${err.message}`);
    }
  }
}
