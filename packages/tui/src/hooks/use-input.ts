import type {EventEmitter} from 'node:events';
import {useEffect, useEffectEvent, useLayoutEffect} from 'react';
import {type Key} from '../parse-keypress.js';
import type {InputEvent} from '../input-event.js';
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
// sid-code（B9 / T5.1c，契约 I9 / I10）：raw mode 租约跟 layout effect 走、handler 订阅跟 passive effect 走。
// 旧底座实测如此，带来两条可观察行为：同一提交换组件时先关后开（关在旧组件的 layout 清理里）；
// 停用期间缓冲的字节在重新启用时由 readable 交出，此时 handler 还没订阅上，所以这些字节被丢掉
const leaseRawMode = (setRawMode: (value: boolean) => void) => {
	setRawMode(true);
	return () => setRawMode(false);
};

const subscribe = (
	emitter: EventEmitter,
	listener: (event: InputEvent) => void,
) => {
	emitter.on('input', listener);
	return () => {
		emitter.off('input', listener);
	};
};

const useInput = (inputHandler: Handler, options: Options = {}) => {
	// eslint-disable-next-line @typescript-eslint/naming-convention
	const {setRawMode, internal_exitOnCtrlC, internal_eventEmitter} =
		useStdinContext();
	const enabled = options.isActive !== false;

	useLayoutEffect(
		() => (enabled ? leaseRawMode(setRawMode) : undefined),
		[enabled, setRawMode],
	);

	// 解码在 App 里做（T5.1c，I11），这里拿到的是 `InputEvent`。
	// 回调抛错不在这里吞，冒到 App 的 readable 回调里统一打 `[ink:error]`（T5.1c，I10）——
	// 旧底座实测同一块里后面的事件、排在后面的监听者都收不到这次输入
	const handleData = useEffectEvent(({input, key}: InputEvent) => {
		// If app is supposed to exit on Ctrl+C, skip input listeners.
		if (input === 'c' && key.ctrl && internal_exitOnCtrlC) return;

		// Use discreteUpdates to assign DiscreteEventPriority to state
		// updates from keyboard input, ensuring they are processed at the
		// highest priority in concurrent mode.
		// @ts-expect-error Types require 5 arguments (fn, a, b, c, d) but only fn is needed at runtime.
		reconciler.discreteUpdates(() => inputHandler(input, key));
	});

	useEffect(
		() => (enabled ? subscribe(internal_eventEmitter, handleData) : undefined),
		[enabled, internal_eventEmitter],
	);
};

export default useInput;
