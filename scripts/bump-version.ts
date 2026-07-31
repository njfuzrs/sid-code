/**
 * 自增 package.json 的 patch 版本号（x.y.z → x.y.z+1）
 * 由 `make build-bump` 与 release.sh 调用，确保每次发布的二进制携带唯一版本号。
 * 注意：日常开发的 `make build` **不**调用本脚本——版本号只在发布（或显式 build-bump）时才变。
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
