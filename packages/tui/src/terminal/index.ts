/** 终端控制序列工具（B9 / T2.3）：OSC、多路复用器包裹、剪贴板、超链接支持判定。 */
export {BEL, OSC, ST, osc, oscTerminator, wrapForMultiplexer} from './osc.js';
export {
	type ClipboardDeps,
	type CommandRunner,
	createSetClipboard,
	setClipboard,
} from './clipboard.js';
export {
	ADDITIONAL_HYPERLINK_TERMINALS,
	type SupportsHyperlinksOptions,
	supportsHyperlinks,
} from './hyperlinks.js';
