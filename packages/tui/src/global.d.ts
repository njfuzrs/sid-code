import {type ReactNode, type Key, type Ref} from 'react';
import {type Except} from 'type-fest';
import {type DOMElement} from './dom.js';
import {type Styles} from './styles.js';

declare module 'react' {
	namespace JSX {
		// eslint-disable-next-line @typescript-eslint/consistent-type-definitions
		interface IntrinsicElements {
			'ink-box': Ink.Box;
			'ink-text': Ink.Text;
		}
	}
}

declare namespace Ink {
	type Box = {
		internal_static?: boolean;
		children?: ReactNode;
		key?: Key;
		ref?: Ref<DOMElement>;
		style?: Except<Styles, 'textWrap'>;
		internal_accessibility?: DOMElement['internal_accessibility'];
	};

	type Text = {
		children?: ReactNode;
		key?: Key;
		style?: Styles;

		// eslint-disable-next-line @typescript-eslint/naming-convention
		internal_transform?: (children: string, index: number) => string;
		// sid-code（B9 / T4.1）：RawAnsi 的终端就绪行，渲染时不换行不截断
		internal_raw?: boolean;
		internal_accessibility?: DOMElement['internal_accessibility'];
	};
}
