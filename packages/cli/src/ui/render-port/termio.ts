/**
 * 终端控制序列工具。实现在 `next/termio.ts`（底座 `packages/tui`），见 README.md。
 */
export {
  OSC,
  osc,
  setClipboard,
  wrapForMultiplexer,
  BEL,
  supportsHyperlinks,
} from "./next/termio.ts";
