import {useEffect, useEffectEvent} from 'react';
import decodeKeypress, {rawInput, type Key} from '../parse-keypress.js';
import reconciler from '../reconciler.js';
import {useStdinContext} from './use-stdin.js';

/**
Handy information about a key that was pressed.

sid-code（B9 / T5.1b，契约 I8）：字段集合与旧底座一致（多 `fn` / `wheelUp` / `wheelDown`，没有上游的
`hyper` / `capsLock` / `numLock` / `eventType`），定义在 `parse-keypress.ts`。
*/
export type {Key} from '../parse-keypress.js';

type Handler = (input: string, key: Key) => void;

type Options = {
	/**
	Enable or disable capturing of user input. Useful when there are multiple `useInput` hooks used at once to avoid handling the same input several times.

	@default true
	*/
	isActive?: boolean;
};

/**
A React hook that returns `void` and handles user input.
It's a more convenient alternative to using `StdinContext` and listening for `data` events. The callback you pass to `useInput` is called for each character when the user enters any input. However, if the user pastes text and it's more than one character, the callback will be called only once, and the whole string will be passed as `input`.

```
import {useInput} from 'ink';

const UserInput = () => {
  useInput((input, key) => {
    if (input === 'q') {
      // Exit program
    }

    if (key.leftArrow) {
      // Left arrow key pressed
    }
  });

  return …
};
```
*/
const useInput = (inputHandler: Handler, options: Options = {}) => {
	// eslint-disable-next-line @typescript-eslint/naming-convention
	const {setRawMode, internal_exitOnCtrlC, internal_eventEmitter} =
		useStdinContext();

	useEffect(() => {
		if (options.isActive === false) {
			return;
		}

		setRawMode(true);

		return () => {
			setRawMode(false);
		};
	}, [options.isActive, setRawMode]);

	const handleData = useEffectEvent((data: string, raw?: boolean) => {
		const decoded = raw ? rawInput(data) : decodeKeypress(data);
		if (!decoded) return;
		const {input, key} = decoded;

		// If app is supposed to exit on Ctrl+C, skip input listeners.
		if (input === 'c' && key.ctrl && internal_exitOnCtrlC) {
			return;
		}

		// Use discreteUpdates to assign DiscreteEventPriority to state
		// updates from keyboard input, ensuring they are processed at the
		// highest priority in concurrent mode.
		// @ts-expect-error Types require 5 arguments (fn, a, b, c, d) but only fn is needed at runtime.
		reconciler.discreteUpdates(() => {
			// sid-code（T5.1b，I8）：回调抛错只打 `[ink:error]`，不退出、不摘监听，后续输入照常送达
			try {
				inputHandler(input, key);
			} catch (error) {
				console.error('[ink:error]', error);
			}
		});
	});

	useEffect(() => {
		if (options.isActive === false) {
			return;
		}

		internal_eventEmitter.on('input', handleData);

		return () => {
			internal_eventEmitter.removeListener('input', handleData);
		};
	}, [options.isActive, internal_eventEmitter]);
};

export default useInput;
