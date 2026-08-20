/**
 * 嵌入编译期模型目录快照的隔离层。
 *
 * 与 `tool/rg-embedded.ts` 同一套模式（那份文件头注释已经写清楚了原因，这里不重复）：
 * 用 bun 原生 `with { type: "file" }` 把 `scripts/gen-model-catalog-snapshot.ts` 生成的
 * JSON 嵌入 `bun --compile` 产物，编译时读取，运行时得到一个 `/$bunfs/` 虚拟路径字符串。
 *
 * 关键约束（与 rg-embedded.ts 一致）：
 * - 本模块**只能被 `require()` 动态加载**，且调用方须先用 IS_DEV_MODE 守卫
 *   （见 model-catalog-snapshot.ts）。
 * - `packages/core/vendor/model-catalog-snapshot.json` 是构建脚本在编译前落成的固定占位
 *   文件（见 scripts/gen-model-catalog-snapshot.ts），不入库。仓库里没有它时
 *   `bun build --compile` 会报「找不到模块」——这与 rg-embed 不同：rg-embed 靠 `.gitignore`
 *   之外**保底提交一个 0 字节占位**，而快照文件选择不保底提交占位，代价是
 *   **必须先跑一次生成脚本才能 `bun build --compile`**（Makefile 的 `build` 目标已经这么排）。
 * - dev 模式（`bun run src`）下 IS_DEV_MODE 为 true，调用方守卫直接短路，
 *   根本不会加载本模块，因此 dev 运行不依赖这份 vendor 文件是否存在。
 *
 * ⚠️ 改错这个路径**不会**在 `bun run` / `bun test` 下暴露：dev 模式根本不会加载
 *    本模块，只有 `bun build --compile` 才会真去读这个文件。所以动过它必须跑一次
 *    `make build` 验证，光跑测试是测不出来的（与 rg-embedded.ts 同一条踩坑记录）。
 */

// 指向**本包内**的 vendor/：模型目录快照只有 core 用，谁用谁带，与 rg-embed 同一套约定。
import snapshotPath from "../../vendor/model-catalog-snapshot.json" with { type: "file" };

/** 嵌入快照文件的运行时虚拟路径（`/$bunfs/...`），用 Bun.file()/readFileSync() 读取。 */
export { snapshotPath };
