// sid-code（B9 / T5.1c，契约 I11）：`useStdin().internal_eventEmitter` 上 `input` 事件的形状。
//
// 规则来自对拍旧底座的黑盒探针（设计文档 D-5）：事件是一个对象，自有字段依次是
// `_didStopImmediatePropagation / keypress / key / input`，`stopImmediatePropagation()` 在父类上；
// 某个监听者调用它之后，排在后面的监听者（含 `useInput`）都收不到这次输入。
// `keypress` 只承诺 `kind / ctrl / meta / shift / super / fn / sequence / raw / isPasted` 这几项——
// 旧底座还有 `name / option / code`，CLI 侧没有读者，这里不仿造（宁缺不错）。
import type {Key} from './parse-keypress.js';

export type Keypress = {
	readonly kind: 'key';
	readonly ctrl: boolean;
	readonly meta: boolean;
	readonly shift: boolean;
	readonly super: boolean;
	readonly fn: boolean;
	readonly sequence: string;
	readonly raw: string;
	readonly isPasted: boolean;
};

class StoppableEvent {
	_didStopImmediatePropagation = false;

	stopImmediatePropagation(): void {
		this._didStopImmediatePropagation = true;
	}
}

export class InputEvent extends StoppableEvent {
	readonly keypress: Keypress;
	readonly key: Key;
	readonly input: string;

	constructor(data: string, input: string, key: Key, isPasted: boolean) {
		super();
		this.keypress = {
			kind: 'key',
			ctrl: key.ctrl,
			meta: key.meta,
			shift: key.shift,
			super: key.super,
			fn: key.fn,
			sequence: data,
			raw: data,
			isPasted,
		};
		this.key = key;
		this.input = input;
	}
}
