/**
 * A1 按轮回滚（G4）：真 TUI 里 Esc、Esc 打开回退面板 → 选回退点 → 选「仅代码」→ 文件回到改前。
 *
 * 期望来源：核心功能触发清单 A1 的人工实测（2026-11-06，TUI 会话 `20261106-150653-acf57cf8` /
 * `20261106-150816-c4936666`，两次 `Rewind` 字段完全相同）：
 *   `{via:"dialog", outcome:"ok", mode:"code", point_id:1, messages_dropped:0, files_restored:1,
 *     file_restore_skipped:false, conversation_unavailable:false, has_snapshot:true}`
 * 文件逐字节回到改前；`mode=code` + `messages_dropped=0` 说明对话保留。
 * 本例的改动换成 A2 那份最小夹具（read → edit → read），实测形态与上面一致（2026-11-08 构建产物探针）。
 *
 * 两击 Esc 之间隔 200ms，**不能**一次写 `\x1b\x1b`：那会走解析层合成的 `escape-escape` 快路径，
 * 而人手双击（150–300ms）走的是 use-rewind-escape.ts 的慢路径——帮助里写的「Esc Esc」曾因为只认
 * 快路径而在正常手速下用不了。本例守的是人真正会按出来的那条。
 *
 * 屏幕等待的文本取「面板标题 + 操作提示」组合，不取「会话回退」四个字：第一次 Esc 的引导提示
 * 「再按一次 Esc 打开会话回退」也含这四个字，面板没开也会命中。
 */
import { REWIND_EVENT_NAME } from "@sid-code/core/session/rewind-telemetry.ts";
import type { SmokeCase } from "../../lib/types.ts";

const def: SmokeCase = {
  id: "A1-dialog",
  ledger: "A1",
  feature: "按轮回滚（Esc+Esc 面板）",
  kind: "guard",
  repo: { "hello.txt": "hello world\n" },
  argv: [],
  tui: [
    { kind: "wait", screen: "输入消息或 /help 查看命令", label: "TUI 就绪" },
    { kind: "type", text: "把 hello.txt 的 hello world 改成 hello sid-code" },
    { kind: "key", key: "enter" },
    { kind: "wait", screen: "已把 hello world 改成 hello sid-code", label: "改文件的一轮结束" },
    { kind: "key", key: "esc" },
    { kind: "pause", ms: 200 },
    { kind: "key", key: "esc" },
    { kind: "wait", screen: "选择回退到哪一轮之前", label: "回退面板打开" },
    { kind: "key", key: "enter" },
    { kind: "wait", screen: "只把文件回滚到该轮快照，保留对话", label: "进入回退范围选择" },
    { kind: "key", key: "enter" },
    { kind: "wait", screen: "已回退（仅代码）", label: "回退完成" },
    { kind: "key", key: "esc" },
    // 等面板关掉、输入框回来再交给运行器退出。这一步同时守「结果页按一次 Esc 就关」：
    // 2026-11-08 首跑发现要按两次（RewindDialog 的 Esc 判断顺序与渲染顺序不一致），同 PR 已修。
    // 另：紧跟着 Esc 的 Ctrl+C 会在 50ms（ESC_TIMEOUT）内被解析成一个 Meta 组合键，也必须先等。
    { kind: "wait", screen: "输入消息或 /help 查看命令", label: "面板关闭、回到输入框" },
  ],
  expect: {
    events: [
      {
        event: REWIND_EVENT_NAME,
        where: {
          via: "dialog",
          outcome: "ok",
          mode: "code",
          messages_dropped: 0,
          files_restored: 1,
          file_restore_skipped: false,
          conversation_unavailable: false,
          has_snapshot: true,
        },
        count: 1,
      },
      { event: REWIND_EVENT_NAME, count: 1 },
    ],
    files: [{ path: "hello.txt", equals: "hello world\n" }],
  },
  mutations: [
    {
      file: "packages/cli/src/ui/hooks/use-rewind-escape.ts",
      find: "    if (!detector.press()) {",
      replace: "    if (true) {",
      why: "人手速度的双击（慢路径）永远判成第一击，只剩解析层快路径——面板在正常手速下打不开",
    },
    {
      file: "packages/core/src/session/rewind-manager.ts",
      find: "        const r = await this.deps.restoreBeforeSnapshot(point.snapshotId);",
      replace: "        const r = { restored: 1, failed: [] as unknown[] };",
      why: "面板照常走完、埋点照报 ok，但文件根本没被恢复（只看事件会假绿）",
    },
    {
      file: "packages/core/src/session/rewind-manager.ts",
      find: "      this.emitDialogRewind(result);",
      replace: "      void result;",
      why: "回退照常生效，但 Rewind 埋点断了（轨迹里看不到这次回滚）",
    },
    {
      file: "packages/cli/src/ui/components/RewindDialog.tsx",
      find: "      if (result) {\n        onClose();",
      replace: "      if (false) {\n        onClose();",
      why: "结果页按一次 Esc 不关闭、要按两次（2026-11-08 本用例首跑发现的缺陷原形）",
    },
  ],
};

export default def;
