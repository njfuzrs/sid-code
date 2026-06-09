/**
 * 自增 package.json 的 patch 版本号（x.y.z → x.y.z+1）
 * 用于 make build 前自动更新版本，确保每次编译的二进制携带唯一版本号
 */
import { readFileSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkgPath = resolve(__dirname, "..", "package.json");

const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));

const oldVersion = pkg.version;
const [major, minor, patch] = oldVersion.split(".").map(Number);
const newVersion = `${major}.${minor}.${patch + 1}`;

pkg.version = newVersion;
writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + "\n");

console.log(`版本号已更新: ${oldVersion} → ${newVersion}`);
